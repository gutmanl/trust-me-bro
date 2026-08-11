import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractionOutput } from "../../adapters";
import { buildBriefingViewModel, RegisterStore } from "../../register";
import type { ApplyMeta, ApplySummary } from "./apply-extraction-output";
import { applyExtractionOutput } from "./apply-extraction-output";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { importBriefing } from "../briefing";
import { createProject } from "../projects";
import { captureSource } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";

/**
 * The commit half of an extraction pass: dedupe, the additional-evidence
 * channel, the recheck pull and anchor resolution — all of it inside ONE
 * register transaction, against a real store so the creation gate and the
 * transition table decide, not the test.
 */

const PROJECT = "proj_apply";

const BRIEFING = [
  "# Briefing zur Reviewzeit",
  "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
  "Langfristig steigt angeblich auch die Codequalität.",
].join("\n\n");

const PARAGRAPHS = [
  "# Briefing zur Reviewzeit",
  "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
  "Langfristig steigt angeblich auch die Codequalität.",
];

const META: ApplyMeta = {
  backendId: "claude",
  model: "claude-sonnet-5",
  runId: "lauf-1",
  targetSourceId: "src_studie",
};

function output(partial: Partial<ExtractionOutput>): ExtractionOutput {
  return { claims: [], additional_evidence: [], ...partial };
}

function evidenceOn(
  excerpt = "median review time dropped from 42 to 19 minutes",
): ExtractionOutput["claims"][number]["evidence"][number] {
  return {
    source_id: "src_studie",
    locator: { page: 6 },
    verbatim_excerpt: excerpt,
  };
}

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-apply-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId: PROJECT,
    content: BRIEFING,
    tool: "deep-research-x",
  });
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "peer_reviewed_publication",
      manual: { title: "Studie", authors: "Studie, A." },
      upload: {
        content: Buffer.from(
          "median review time dropped from 42 to 19 minutes",
        ),
        filename: "studie.txt",
      },
    },
    { fetcher: fakeFetcher({}) },
  );
  expect(source.id).toBe("src_studie");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

async function apply(
  result: ExtractionOutput,
  meta: Partial<ApplyMeta> = {},
): Promise<ApplySummary> {
  return RegisterStore.forProject(PROJECT).transaction((tx) =>
    applyExtractionOutput(tx, result, PARAGRAPHS, { ...META, ...meta }),
  );
}

async function claims() {
  return (await RegisterStore.forProject(PROJECT).read()).claims;
}

describe("applyExtractionOutput — creation and anchoring", () => {
  it("creates a claim and resolves its paragraph from the anchor quote", async () => {
    const summary = await apply(
      output({
        claims: [
          {
            text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn()],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 1, merged: 0, escalated: 0 });
    const [claim] = await claims();
    expect(claim.id).toBe("clm_0001");
    expect(claim.status).toBe("captured");
    // Paragraph 2 of the briefing (the title block is p1).
    expect(claim.briefing_anchor).toBe("p2");
    expect(claim.anchor_quote).toBe("reduzieren die mediane Reviewzeit");
    expect(claim.evidence[0].id).toBe("ev_0001");
    expect(claim.provenance).toMatchObject({
      tool: "claude",
      model: "claude-sonnet-5",
      search_path: "Extraktionslauf lauf-1",
    });
  });

  it("resolves a quote whose punctuation and case differ from the briefing", async () => {
    await apply(
      output({
        claims: [
          {
            text: "Die Codequalität steigt langfristig.",
            claim_type: "effectiveness_statement",
            anchor_quote: "LANGFRISTIG   steigt angeblich auch die",
            evidence: [],
          },
        ],
      }),
    );
    expect((await claims())[0].briefing_anchor).toBe("p3");
  });

  it("falls back to the p0 sentinel — keeping the quote — when it is not in the briefing", async () => {
    await apply(
      output({
        claims: [
          {
            text: "Die Teamzufriedenheit steigt.",
            claim_type: "effectiveness_statement",
            anchor_quote: "ein Satz, der im Briefing nirgends steht",
            evidence: [evidenceOn()],
          },
        ],
      }),
    );
    const [claim] = await claims();
    expect(claim.briefing_anchor).toBe("p0");
    expect(claim.anchor_quote).toBe("ein Satz, der im Briefing nirgends steht");
    // The sentinel is deliberately not a valid p<N>, so the view model shows
    // the claim in its unanchored bucket instead of pinning it somewhere.
    const register = await RegisterStore.forProject(PROJECT).read();
    const viewModel = buildBriefingViewModel(BRIEFING, register);
    expect(viewModel.unanchored.map((marker) => marker.claim.id)).toEqual([
      claim.id,
    ]);
  });

  it("sends a bundled claim to adjudication despite its evidence (atomicity gate)", async () => {
    const summary = await apply(
      output({
        claims: [
          {
            text: "Die Reviewzeit sinkt deutlich. Zudem steigt die Zufriedenheit.",
            claim_type: "effectiveness_statement",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn()],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 1, escalated: 1 });
    const [claim] = await claims();
    expect(claim.status).toBe("pending_adjudication");
    expect(claim.history[0].reason).toContain("Atomaritätsgate");
  });

  it("merges two identical candidates of the SAME output into one claim", async () => {
    const candidate = {
      text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
      claim_type: "quantitative_finding" as const,
      anchor_quote: "reduzieren die mediane Reviewzeit",
    };
    const summary = await apply(
      output({
        claims: [
          { ...candidate, evidence: [evidenceOn()] },
          {
            ...candidate,
            evidence: [evidenceOn("developer satisfaction rose")],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 1, merged: 1 });
    const all = await claims();
    expect(all).toHaveLength(1);
    expect(all[0].evidence).toHaveLength(2);
  });

  it("routes an unevidenced claim to adjudication through the creation gate", async () => {
    const summary = await apply(
      output({
        claims: [
          {
            text: "Langfristig steigt die Codequalität.",
            claim_type: "effectiveness_statement",
            anchor_quote: "Langfristig steigt angeblich",
            evidence: [],
          },
        ],
      }),
      { targetSourceId: null },
    );
    expect(summary).toMatchObject({ created: 1, escalated: 1 });
    const [claim] = await claims();
    expect(claim.status).toBe("pending_adjudication");
    expect(claim.history[0].reason).toContain("Keine Fundstelle");
  });
});

describe("applyExtractionOutput — dedupe against the committed claims", () => {
  async function seedClaim(): Promise<void> {
    await apply(
      output({
        claims: [
          {
            text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn()],
          },
        ],
      }),
    );
  }

  it("treats an exact re-extraction as additional evidence, not a second claim", async () => {
    await seedClaim();
    const summary = await apply(
      output({
        claims: [
          {
            text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn("developer satisfaction increased")],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 0, merged: 1 });
    const all = await claims();
    expect(all).toHaveLength(1);
    expect(all[0].evidence.map((entry) => entry.id)).toEqual([
      "ev_0001",
      "ev_0002",
    ]);
  });

  it("merges a candidate that differs only in the search normal form", async () => {
    await seedClaim();
    const summary = await apply(
      output({
        claims: [
          {
            text: "llm-reviews   reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn("developer satisfaction increased")],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 0, merged: 1 });
    expect(await claims()).toHaveLength(1);
  });

  it("creates a genuinely different claim instead of merging it", async () => {
    await seedClaim();
    const summary = await apply(
      output({
        claims: [
          {
            text: "Langfristig steigt die Codequalität.",
            claim_type: "effectiveness_statement",
            anchor_quote: "Langfristig steigt angeblich",
            evidence: [evidenceOn("code quality improved")],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 1, merged: 0 });
    expect((await claims()).map((claim) => claim.id)).toEqual([
      "clm_0001",
      "clm_0002",
    ]);
  });

  it("skips evidence whose (source, verbatim excerpt) pair the claim already has", async () => {
    await seedClaim();
    const summary = await apply(
      output({
        claims: [
          {
            text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            // Same source, same excerpt as the seeded evidence, plus one new.
            evidence: [evidenceOn(), evidenceOn("developer satisfaction rose")],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 0, merged: 1 });
    expect((await claims())[0].evidence).toHaveLength(2);
  });

  it("does not merge into a discarded claim — the settled negative stands", async () => {
    await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId: "src_studie",
      status: "discarded",
    });
    const discarded = (await claims())[0];
    const summary = await apply(
      output({
        claims: [
          {
            text: discarded.text,
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn()],
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 1, merged: 0 });
    expect(await claims()).toHaveLength(2);
  });
});

describe("applyExtractionOutput — the additional-evidence channel", () => {
  it("attaches evidence to the claim its claim_text_match resolves to", async () => {
    const claimId = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId: "src_studie",
      status: "captured",
    });
    const known = (await claims())[0];
    const summary = await apply(
      output({
        additional_evidence: [
          {
            claim_text_match: known.text.toUpperCase(),
            evidence: evidenceOn("developer satisfaction increased"),
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 0, merged: 1 });
    const all = await claims();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(claimId);
    expect(all[0].evidence).toHaveLength(2);
  });

  it("never drops an unresolvable match — it becomes a new claim through the gate", async () => {
    const summary = await apply(
      output({
        additional_evidence: [
          {
            claim_text_match: "Ein Claim, den das Register nicht kennt.",
            evidence: evidenceOn(),
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ created: 1, merged: 0 });
    const [claim] = await claims();
    expect(claim.text).toBe("Ein Claim, den das Register nicht kennt.");
    expect(claim.evidence).toHaveLength(1);
    expect(claim.history[0].reason).toContain("Zusatzfundstelle");
  });
});

describe("applyExtractionOutput — the recheck pull", () => {
  it("pulls a settled claim into recheck_required when evidence lands on it", async () => {
    const claimId = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId: "src_studie",
      status: "confirmed",
    });
    const known = (await claims())[0];
    const summary = await apply(
      output({
        additional_evidence: [
          {
            claim_text_match: known.text,
            evidence: evidenceOn("developer satisfaction increased"),
          },
        ],
      }),
    );
    expect(summary.recheckPulled).toEqual([claimId]);
    const [claim] = await claims();
    expect(claim.status).toBe("recheck_required");
    const last = claim.history.at(-1);
    expect(last?.actor).toBe("system:extraction");
    expect(last?.reason).toContain("Neue Fundstelle aus Quelle src_studie");
    expect(last?.reason).toContain("erneute Prüfung");
  });

  it("leaves a claim mid human workflow where it is, but still attaches the evidence", async () => {
    await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId: "src_studie",
      status: "pending_adjudication",
    });
    const known = (await claims())[0];
    const summary = await apply(
      output({
        additional_evidence: [
          {
            claim_text_match: known.text,
            evidence: evidenceOn("developer satisfaction increased"),
          },
        ],
      }),
    );
    expect(summary.recheckPulled).toEqual([]);
    const [claim] = await claims();
    expect(claim.status).toBe("pending_adjudication");
    expect(claim.evidence).toHaveLength(2);
  });

  it("does not pull a claim whose only new evidence was a duplicate", async () => {
    await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId: "src_studie",
      status: "confirmed",
    });
    const known = (await claims())[0];
    const summary = await apply(
      output({
        additional_evidence: [
          {
            claim_text_match: known.text,
            evidence: {
              source_id: "src_studie",
              locator: { page: 1 },
              verbatim_excerpt: known.evidence[0].verbatim_excerpt,
            },
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ merged: 0, recheckPulled: [] });
    expect((await claims())[0].status).toBe("confirmed");
  });
});

describe("applyExtractionOutput — the run bracket", () => {
  it("closes the bracket with a scoped German summary in the same transaction", async () => {
    await apply(
      output({
        claims: [
          {
            text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            anchor_quote: "reduzieren die mediane Reviewzeit",
            evidence: [evidenceOn()],
          },
        ],
      }),
    );
    const register = await RegisterStore.forProject(PROJECT).read();
    const last = register.project_events.at(-1);
    expect(last?.event).toBe("batch_run_completed");
    expect(last?.actor).toBe("system:extraction");
    expect(last?.reason).toContain("Quelle src_studie");
    expect(last?.reason).toContain("Lauf lauf-1");
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });

  it("names the sweep pass instead of a source", async () => {
    await apply(output({}), { targetSourceId: null });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.project_events.at(-1)?.reason).toContain("Sweep");
  });
});

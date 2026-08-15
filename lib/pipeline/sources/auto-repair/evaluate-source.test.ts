import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Orchestrator } from "../../../adapters";
import { RegisterStore } from "../../../register";
import { createProject } from "../../projects";
import { addClaimWalkedTo } from "../../__fixtures__/walk-claim";
import {
  CROSSREF_WORKS_RESPONSE,
  CROSSREF_WORK_NO_LINK_RESPONSE,
  CROSSREF_WORK_WITH_PDF_LINK_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import { captureSource } from "../capture";
import type {
  SourceCaptureItemInfo,
  SourceCaptureWorkItem,
} from "../work-items/types";
import { recordCaptureFailure } from "../work-items/failures";
import {
  failingExcerptsForSource,
  sourcesNeedingRepairEvaluation,
  sourcesNeedingRepairEvaluationForProject,
} from "./candidates";
import { evaluateSourceRepair } from "./evaluate-source";

const PROJECT = "proj_auto-repair-bc";
const RAW_TEXT = "Meyer et al. (2025) zeigen dies deutlich.[^1]";
const WRONG_DOC = Buffer.from("Volltext eines völlig anderen Papers.");

let workspace: string;
let sourceId: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-repair-bc-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Wird die falsche Quelle automatisch repariert?",
    primaryCli: "claude",
  });
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Falsches Paper", year: "2020" },
      upload: { content: WRONG_DOC, filename: "falsch.txt" },
      autoCapture: { raw_text: RAW_TEXT, method: "doi" },
    },
    { fetcher: fakeFetcher({}) },
  );
  sourceId = source.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Strands one claim in adjudication via a failed existence check. */
async function strandClaim(claimNumber: number): Promise<string> {
  const claimId = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber,
    sourceId,
    status: "captured",
  });
  const store = RegisterStore.forProject(PROJECT);
  await store.transaction((tx) => {
    const claim = tx.getClaim(claimId);
    tx.setExistenceCheck(claimId, claim.evidence[0].id, {
      status: "failed",
      at: new Date().toISOString(),
    });
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: "system:existence_check",
      reason: "Wortlaut nicht im eingefrorenen Text gefunden.",
      routing: "existence_check_failed",
    });
  });
  return claimId;
}

/** Gives the captured upload source a dead DOI identity, so the live check
 * fails unambiguously (case b). */
async function giveSourceDeadDoi(): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.correctSourceIdentity(sourceId, {
      item: {
        type: "article-journal",
        title: "Falsches Paper",
        DOI: "10.9999/tot.456",
      },
      replacedAt: new Date().toISOString(),
      correctionAttemptId: "wi_setup",
    });
  });
}

function chainFake(): {
  enqueued: SourceCaptureWorkItem[];
  enqueueSourceCapture: (p: string, item: SourceCaptureWorkItem) => void;
  pendingCaptureItems: () => SourceCaptureItemInfo[];
  activeCaptureItem: () => SourceCaptureItemInfo | undefined;
} {
  const enqueued: SourceCaptureWorkItem[] = [];
  return {
    enqueued,
    enqueueSourceCapture: (_p, item) => {
      enqueued.push(item);
    },
    pendingCaptureItems: () => [],
    activeCaptureItem: () => undefined,
  };
}

const parseOrchestrator = {
  run: async () => ({
    status: "ok",
    output: {
      references: [
        {
          raw_text: RAW_TEXT,
          title: "Effects of AI Assistants on Code Review Duration",
          authors: ["Anna Meyer"],
          year: 2025,
        },
      ],
    },
  }),
} as unknown as Orchestrator;

function crossrefRoutes() {
  return {
    "https://api.crossref.org/works?": {
      contentType: "application/json",
      body: Buffer.from(CROSSREF_WORKS_RESPONSE),
    },
    "https://api.crossref.org/works/": {
      contentType: "application/json",
      body: Buffer.from(CROSSREF_WORK_NO_LINK_RESPONSE),
    },
  };
}

describe("candidate derivation helpers", () => {
  it("lists stranded sources and their failing excerpts", async () => {
    await strandClaim(1);
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(sourcesNeedingRepairEvaluation(register)).toEqual([sourceId]);
    expect(failingExcerptsForSource(register, sourceId)).toEqual([
      "Reviewzeit sank",
    ]);
    expect(failingExcerptsForSource(register, "src_andere")).toEqual([]);
    // The project-id variant the auto-chain uses reads its own register.
    expect(await sourcesNeedingRepairEvaluationForProject(PROJECT)).toEqual([
      sourceId,
    ]);
  });
});

describe("evaluateSourceRepair", () => {
  it("case (b): applies a confident rematch when the identity is provably dead", async () => {
    await strandClaim(1);
    await giveSourceDeadDoi();
    const chain = chainFake();
    await evaluateSourceRepair(PROJECT, sourceId, {
      // The dead DOI 404s (no doi.org route), Crossref answers the title.
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: parseOrchestrator,
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action).toMatchObject({
      mode: "applied",
      basis: "identity_unambiguous_rematch",
      target: { kind: "source", source_id: sourceId },
      candidate: { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
    });
    expect(chain.enqueued).toHaveLength(1);
    expect(chain.enqueued[0]).toMatchObject({
      origin: "auto_repair",
      request: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        targetSourceId: sourceId,
      },
    });
  });

  it("case (b): only suggests when the rematch is weak (no LLM, title-only)", async () => {
    await strandClaim(1);
    await giveSourceDeadDoi();
    const chain = chainFake();
    // Fallback meta = cleaned raw_text — a poor Crossref query, but the
    // works response still matches at ~0.6 via... actually the raw line
    // scores below the floor; use a title-only raw_text via a fresh
    // provenance is not possible post-capture, so inject a parse that
    // yields ONLY the title (no year/author) → score 0.6 → suggested.
    const titleOnlyParse = {
      run: async () => ({
        status: "ok",
        output: {
          references: [
            {
              raw_text: RAW_TEXT,
              title: "Effects of AI Assistants on Code Review Duration",
              authors: [],
            },
          ],
        },
      }),
    } as unknown as Orchestrator;
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: titleOnlyParse,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action?.mode).toBe("suggested");
    expect(event?.repair_action?.basis).toBe("identity_unambiguous_rematch");
    expect(chain.enqueued).toHaveLength(0);
  });

  it("records nothing when a human correction landed while the evaluation ran", async () => {
    await strandClaim(1);
    await giveSourceDeadDoi();
    const chain = chainFake();
    // The LLM parse is the slow middle of the evaluation — a correction
    // landing inside it grows previous_identities, which the TOCTOU
    // re-check under the lock detects.
    const racingOrchestrator = {
      run: async () => {
        await RegisterStore.forProject(PROJECT).transaction((tx) => {
          tx.correctSourceIdentity(sourceId, {
            item: {
              type: "article-journal",
              title: "Vom Menschen korrigiert",
              DOI: "10.1109/TSE.2025.3489012",
            },
            replacedAt: new Date().toISOString(),
            correctionAttemptId: "wi_mensch",
          });
        });
        return (
          parseOrchestrator as unknown as { run: () => Promise<unknown> }
        ).run();
      },
    } as unknown as Orchestrator;
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: racingOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
  });

  it("case (c): applies when the candidate document verifiably contains the failing quotes", async () => {
    await strandClaim(1);
    const chain = chainFake();
    // The candidate's PDF genuinely contains the claim's excerpt
    // ("Reviewzeit sank …"), while the frozen WRONG_DOC does not.
    const samplePdf = fs.readFileSync(
      path.join(process.cwd(), "lib/pipeline/fulltext/__fixtures__/sample.pdf"),
    );
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher({
        "https://api.crossref.org/works?": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORKS_RESPONSE),
        },
        "https://api.crossref.org/works/": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORK_WITH_PDF_LINK_RESPONSE),
        },
        "https://publisher.example.org/paper.pdf": {
          contentType: "application/pdf",
          body: samplePdf,
        },
      }),
      orchestrator: parseOrchestrator,
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action).toMatchObject({
      mode: "applied",
      basis: "quote_fit_rematch",
      quote_fit: {
        candidate_matches: 1,
        current_matches: 0,
        checked_excerpts: 1,
      },
    });
    expect(event?.reason).toContain("1 von 1 fehlenden Zitatstellen");
    expect(chain.enqueued).toHaveLength(1);
    expect(chain.enqueued[0].request).toMatchObject({
      targetSourceId: sourceId,
      documentUrl: "https://publisher.example.org/paper.pdf",
    });
  });

  it("case (c): only suggests when the candidate document cannot be verified", async () => {
    await strandClaim(1);
    const chain = chainFake();
    await evaluateSourceRepair(PROJECT, sourceId, {
      // Identity fine (upload, no identifier); wording missing; the
      // candidate resolves but no PDF is derivable → quote-fit impossible.
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: parseOrchestrator,
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action).toMatchObject({
      mode: "suggested",
      basis: "quote_fit_rematch",
    });
    expect(event?.repair_action?.quote_fit).toBeUndefined();
    expect(chain.enqueued).toHaveLength(0);
  });

  it("treats a network error on the live check as no signal, not a verdict", async () => {
    await strandClaim(1);
    await giveSourceDeadDoi();
    const chain = chainFake();
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: {
        fetch: async () => {
          throw new Error("Netzwerk weg.");
        },
      },
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
  });

  it("only ever SUGGESTS for a manually captured source, never applies", async () => {
    // A human typed this identity, so replacing it stays a human's click —
    // even though the rematch below scores well past the auto-apply bar.
    const manual = await captureSource(
      {
        projectId: PROJECT,
        kind: "upload",
        sourceType: "grey_literature",
        manual: {
          title: "Effects of AI Assistants on Code Review Duration",
          authors: "Meyer, Anna",
          year: "2025",
        },
        upload: { content: WRONG_DOC, filename: "manuell.txt" },
      },
      { fetcher: fakeFetcher({}) },
    );
    sourceId = manual.id;
    // A dead DOI on an otherwise well-described source: case (b) signal,
    // with the CSL core still carrying what the rematch reads.
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.correctSourceIdentity(sourceId, {
        item: {
          type: "article-journal",
          title: "Effects of AI Assistants on Code Review Duration",
          author: [{ family: "Meyer", given: "Anna" }],
          issued: { "date-parts": [[2025]] },
          DOI: "10.9999/tot.456",
        },
        replacedAt: new Date().toISOString(),
        correctionAttemptId: "wi_setup_manual",
      });
    });
    await strandClaim(1);

    const chain = chainFake();
    // No orchestrator, no preflight: a manual source's own CSL core is the
    // rematch input, so no backend may be involved.
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      chain,
    });

    const register = await RegisterStore.forProject(PROJECT).read();
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_repair_action",
    );
    expect(event?.repair_action).toMatchObject({
      mode: "suggested",
      basis: "identity_unambiguous_rematch",
      target: { kind: "source", source_id: sourceId },
    });
    expect(chain.enqueued).toHaveLength(0);
  });

  it("skips a source without suspicion", async () => {
    // No stranded claim, identity fine → no signal, nothing recorded.
    const chain = chainFake();
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
  });

  it("loop guard: an open suggestion or an in-flight correction blocks re-evaluation", async () => {
    await strandClaim(1);
    const store = RegisterStore.forProject(PROJECT);
    await store.transaction((tx) => {
      tx.recordRepairAction({
        action: {
          target: { kind: "source", source_id: sourceId },
          mode: "suggested",
          basis: "quote_fit_rematch",
          candidate: { kind: "doi", identifier: "10.1109/TSE.2025.3489012" },
        },
        actor: "system:auto_repair",
        reason: "Reparaturvorschlag (Test).",
      });
    });
    const chain = chainFake();
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await store.read();
    // Only the pre-seeded suggestion exists — no second event, no enqueue.
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(1);
    expect(chain.enqueued).toHaveLength(0);

    // Same for an in-flight correction targeting the source.
    const busyChain = {
      ...chainFake(),
      pendingCaptureItems: (): SourceCaptureItemInfo[] => [
        {
          workItemId: "wi_läuft",
          origin: "correction",
          label: "Korrektur",
          targetSourceId: sourceId,
        },
      ],
    };
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "source_repair_action_dismissed",
        reason: "Reparaturvorschlag verworfen (Test).",
        actor: "human:lg",
        source_id: sourceId,
      });
    });
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: parseOrchestrator,
      chain: busyChain,
    });
    expect(busyChain.enqueued).toHaveLength(0);
  });

  it("loop guard: an open auto_repair failure on the source blocks re-evaluation", async () => {
    await strandClaim(1);
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "wi_versuch",
        origin: "auto_repair",
        label: "Reparaturversuch",
        request: {
          kind: "doi",
          sourceType: "grey_literature",
          targetSourceId: sourceId,
          identifier: "10.1109/TSE.2025.3489012",
        },
      },
      new Error("Reparaturversuch scheiterte."),
    );
    const chain = chainFake();
    await evaluateSourceRepair(PROJECT, sourceId, {
      fetcher: fakeFetcher(crossrefRoutes()),
      orchestrator: parseOrchestrator,
      chain,
    });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (candidate) => candidate.event === "source_repair_action",
      ),
    ).toHaveLength(0);
    expect(chain.enqueued).toHaveLength(0);
  });
});

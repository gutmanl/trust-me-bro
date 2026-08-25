import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBackend, Orchestrator } from "../../adapters";
import type { JobRequest, RepairOutput } from "../../adapters";
import { countRepairCycles, RegisterStore } from "../../register";
import type { Claim, Evidence } from "../../register";
import { PipelineError, RepairPreconditionError } from "../errors";
import { decideClaim } from "../adjudication/decide";
import { createProject } from "../projects";
import { applyRepair, proposeRepair } from "./run-repair";
import {
  claimsEligibleForRepairSuggestion,
  deriveOpenClaimRepairSuggestions,
  dismissClaimRepairSuggestion,
  evaluateClaimRepair,
} from "./suggestions";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-repair-sugg-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
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

const PROJECT_ID = "proj_vorschlag";

function evidence(id: string, passed: boolean | null): Evidence {
  return {
    id,
    source_id: "src_0001",
    locator: { page: 3 },
    verbatim_excerpt: "Reviews reduzieren die Fehlerdichte um 12 %.",
    ...(passed === null
      ? {}
      : {
          existence_check: {
            status: passed ? "passed" : "failed",
            at: "2026-08-08T09:00:00Z",
          },
        }),
    judgments: [],
  } as Evidence;
}

/**
 * Project with one machine-parked claim. `routing` selects the door:
 * `negative_precheck` claims carry a calibration verdict (the critique the
 * verdict driver reads), `existence_check_failed` claims carry a failed
 * evidence check, `spot_check` claims are the ineligible control.
 */
async function projectWithParkedClaim(
  routing: "negative_precheck" | "existence_check_failed" | "spot_check",
): Promise<RegisterStore> {
  await createProject({
    id: PROJECT_ID,
    research_question: "Frage?",
    primaryCli: "claude",
  });
  const store = RegisterStore.forProject(PROJECT_ID);
  const failedQuote = routing === "existence_check_failed";
  await store.transaction((tx) => {
    tx.addSource({
      id: "src_0001",
      type: "article-journal",
      title: "Testquelle",
      custom: { source_type: "peer_reviewed_publication" },
    } as never);
    tx.addClaim({
      claim: {
        id: "clm_0001",
        text: "Reviews reduzieren die Fehlerdichte immer deutlich.",
        claim_type: "effectiveness_statement",
        briefing_anchor: "p1",
        provenance: {
          tool: "claude",
          model: "claude-sonnet-5",
          extracted_at: "2026-08-08T09:00:00Z",
          search_path: "briefing",
        },
        evidence: [evidence("ev_0001", !failedQuote)],
      } as Omit<Claim, "status" | "history">,
      actor: "system:extraction",
      reason: "Extrahiert.",
    });
    if (routing === "negative_precheck") {
      tx.setCalibrationResult(
        "clm_0001",
        "weakened",
        "Die Aussage überzieht den einzelnen Beleg.",
        "1.1.0",
      );
    }
    if (failedQuote) {
      tx.transitionClaim("clm_0001", {
        to: "pending_adjudication",
        actor: "system:existence_check",
        reason: "Zitatpr\u00fcfung nicht bestanden (Test-Setup).",
        routing,
      });
    } else {
      // Passed evidence cannot take the stage-1 failure edge; walk the
      // claim through existence_checked like the sibling repair tests.
      tx.transitionClaim("clm_0001", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Zitatpr\u00fcfung bestanden (Test-Setup).",
      });
      tx.transitionClaim("clm_0001", {
        to: "pending_adjudication",
        actor: "system:precheck",
        reason: "Geparkt (Test-Setup).",
        routing,
      });
    }
  });
  return store;
}

function mockOrchestrator(output: RepairOutput): {
  orchestrator: Orchestrator;
  jobs: () => JobRequest<"repair">[];
} {
  const backend = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: { repair: output },
  });
  return {
    orchestrator: new Orchestrator({
      backends: [backend],
      traceSink: { write: async () => {} },
      gate: { run: (fn) => fn() },
      policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
      sleep: async () => {},
    }),
    jobs: () =>
      backend.calls.filter(
        (job): job is JobRequest<"repair"> => job.kind === "repair",
      ),
  };
}

describe("evaluateClaimRepair", () => {
  it("records a durable suggestion driven by the negative pre-check", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    const { orchestrator, jobs } = mockOrchestrator({
      suggested_text: "Reviews können die Fehlerdichte reduzieren.",
      reasoning: "Abschwächung auf den belegten Einzelbefund.",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    // The critique came from the machine's own verdict, never a complaint.
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].input.complaint.origin).toBe("negative_precheck");
    expect(jobs()[0].input.complaint.reason).toContain(
      "überzieht den einzelnen Beleg",
    );
    const register = await store.read();
    const open = deriveOpenClaimRepairSuggestions(register);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      claimId: "clm_0001",
      origin: "negative_precheck",
      suggestedText: "Reviews können die Fehlerdichte reduzieren.",
      promptVersion: "1.2.1",
      backend: "claude",
    });
    expect((await store.verify()).ok).toBe(true);
  });

  it("does nothing for a claim whose routing is not repairable", async () => {
    const store = await projectWithParkedClaim("spot_check");
    const { orchestrator, jobs } = mockOrchestrator({
      suggested_text: "x",
      reasoning: "y",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    expect(jobs()).toHaveLength(0);
    expect(deriveOpenClaimRepairSuggestions(await store.read())).toEqual([]);
    expect(claimsEligibleForRepairSuggestion(await store.read())).toEqual([]);
  });

  it("carries excerpt repairs for a failed quote check", async () => {
    const store = await projectWithParkedClaim("existence_check_failed");
    const { orchestrator, jobs } = mockOrchestrator({
      suggested_text: "Reviews reduzieren die Fehlerdichte messbar.",
      reasoning: "Zitat berichtigt, Aussage auf den Befund eingeengt.",
      evidence_repairs: [
        {
          evidence_id: "ev_0001",
          corrected_excerpt: "Reviews senkten die Fehlerdichte um 12,4 %.",
        },
      ],
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    expect(jobs()[0].input.complaint.origin).toBe("existence_check_failed");
    const open = deriveOpenClaimRepairSuggestions(await store.read());
    expect(open[0].evidenceRepairs).toEqual([
      {
        evidenceId: "ev_0001",
        correctedExcerpt: "Reviews senkten die Fehlerdichte um 12,4 %.",
      },
    ]);
  });
});

describe("suggestion openness", () => {
  it("goes stale the moment the claim takes any further transition", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    const { orchestrator } = mockOrchestrator({
      suggested_text: "Abschwächung.",
      reasoning: "Begründung.",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    expect(deriveOpenClaimRepairSuggestions(await store.read())).toHaveLength(
      1,
    );
    // The reviewer confirms — the suggestion answered a question that no
    // longer exists and must disappear without a dismissal event.
    await decideClaim(PROJECT_ID, "clm_0001", {
      categories: [],
      durationS: 5,
    });
    expect(deriveOpenClaimRepairSuggestions(await store.read())).toEqual([]);
  });

  it("is dismissed by the human and refuses a dismissal with nothing open", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    const { orchestrator } = mockOrchestrator({
      suggested_text: "Abschwächung.",
      reasoning: "Begründung.",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    await dismissClaimRepairSuggestion(PROJECT_ID, "clm_0001");
    expect(deriveOpenClaimRepairSuggestions(await store.read())).toEqual([]);
    // The dismissed claim becomes eligible again — a NEW suggestion may be
    // requested; the dismissal judged the recorded proposal, not the claim.
    expect(claimsEligibleForRepairSuggestion(await store.read())).toEqual([
      "clm_0001",
    ]);
    await expect(
      dismissClaimRepairSuggestion(PROJECT_ID, "clm_0001"),
    ).rejects.toThrow(PipelineError);
  });
});

describe("the verdict-driven repair door", () => {
  it("proposeRepair works on a machine-parked claim without any complaint", async () => {
    await projectWithParkedClaim("negative_precheck");
    const { orchestrator, jobs } = mockOrchestrator({
      suggested_text: "Reviews können die Fehlerdichte reduzieren.",
      reasoning: "Abschwächung.",
    });
    const outcome = await proposeRepair(PROJECT_ID, "clm_0001", {
      orchestrator,
    });
    expect(outcome.status).toBe("proposed");
    expect(jobs()[0].input.complaint.origin).toBe("negative_precheck");
  });

  it("applyRepair takes the direct edge, repairs the excerpt and re-enters the full cascade", async () => {
    const store = await projectWithParkedClaim("existence_check_failed");
    const result = await applyRepair(PROJECT_ID, "clm_0001", {
      newText: "Reviews reduzieren die Fehlerdichte messbar.",
      source: "vorschlag_uebernommen",
      excerptRepairs: [
        {
          evidenceId: "ev_0001",
          correctedExcerpt: "Reviews senkten die Fehlerdichte um 12,4 %.",
        },
      ],
    });
    // Cleared existence check ⇒ the mechanical re-entry rule routes through
    // the full cascade, where stage 1 re-establishes the corrected quote.
    expect(result.reentryTarget).toBe("captured");
    const register = await store.read();
    const claim = register.claims[0];
    expect(claim.evidence[0].verbatim_excerpt).toBe(
      "Reviews senkten die Fehlerdichte um 12,4 %.",
    );
    expect(claim.evidence[0].existence_check).toBeUndefined();
    const revised = claim.history.find(
      (entry) => entry.to_status === "revised",
    );
    expect(revised?.from_status).toBe("pending_adjudication");
    expect(revised?.excerpt_revisions).toEqual([
      {
        evidence_id: "ev_0001",
        previous_excerpt: "Reviews reduzieren die Fehlerdichte um 12 %.",
        new_excerpt: "Reviews senkten die Fehlerdichte um 12,4 %.",
      },
    ]);
    // REPAIR-04: the cycle budget counts this door too.
    expect(countRepairCycles(claim)).toBe(1);
    expect((await store.verify()).ok).toBe(true);
  });

  it("keeps the door shut for non-repairable routings", async () => {
    await projectWithParkedClaim("spot_check");
    await expect(
      applyRepair(PROJECT_ID, "clm_0001", {
        newText: "Neuformulierung.",
        source: "manuell",
      }),
    ).rejects.toThrow(RepairPreconditionError);
  });
});

describe("mechanical-cap eligibility (automatic list)", () => {
  // The fixture claims have NO pertinent sources (their evidence carries no
  // resolved relation), so every rule with min_pertinent_sources >= 1 caps
  // them — exactly the state the automatic list must skip for
  // negative_precheck routings while keeping failed-quote claims in.
  it("skips a capped negative-precheck claim but keeps a failed-quote claim", async () => {
    await projectWithParkedClaim("negative_precheck");
    const { claimsNeedingRepairSuggestionForProject } =
      await import("./suggestions");
    expect(await claimsNeedingRepairSuggestionForProject(PROJECT_ID)).toEqual(
      [],
    );
  });

  it("keeps an existence_check_failed claim despite the cap", async () => {
    await projectWithParkedClaim("existence_check_failed");
    const { claimsNeedingRepairSuggestionForProject } =
      await import("./suggestions");
    expect(await claimsNeedingRepairSuggestionForProject(PROJECT_ID)).toEqual([
      "clm_0001",
    ]);
  });
});

describe("outdated suggestions (older prompt version)", () => {
  const plantOutdated = async (store: RegisterStore): Promise<void> => {
    const claim = (await store.read()).claims[0];
    await store.transaction((tx) => {
      tx.recordClaimRepairSuggestion({
        suggestion: {
          claim_id: "clm_0001",
          origin: "negative_precheck",
          suggested_text: "Alte Fassung.",
          reasoning: "Alt.",
          prompt_version: "1.1.0",
          backend: "claude",
          history_length: claim.history.length,
        },
        actor: "system:repair",
        reason: "Reparaturvorschlag aus der negativen Vorprüfung erzeugt.",
      });
    });
  };

  it("stays visible but is flagged and no longer blocks eligibility", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    await plantOutdated(store);
    const register = await store.read();
    const open = deriveOpenClaimRepairSuggestions(register);
    expect(open).toHaveLength(1);
    expect(open[0].outdated).toBe(true);
    expect(claimsEligibleForRepairSuggestion(register)).toEqual(["clm_0001"]);
  });

  it("regeneration supersedes the outdated suggestion in chain order", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    await plantOutdated(store);
    const { orchestrator } = mockOrchestrator({
      suggested_text: "Neue Fassung.",
      reasoning: "Neu erzeugt.",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    const open = deriveOpenClaimRepairSuggestions(await store.read());
    expect(open).toHaveLength(1);
    expect(open[0].suggestedText).toBe("Neue Fassung.");
    expect(open[0].outdated).toBe(false);
  });

  it("a current-version suggestion still blocks regeneration", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    const { orchestrator, jobs } = mockOrchestrator({
      suggested_text: "Erste Fassung.",
      reasoning: "Begründung.",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    expect(jobs()).toHaveLength(1);
    expect(deriveOpenClaimRepairSuggestions(await store.read())).toHaveLength(
      1,
    );
  });
});

describe("briefing repair passthrough", () => {
  it("carries the proposed briefing paragraph into the durable suggestion", async () => {
    const store = await projectWithParkedClaim("negative_precheck");
    const { orchestrator } = mockOrchestrator({
      suggested_text: "Abschwächung.",
      reasoning: "Begründung.",
      briefing_repair: "Der Absatz, neu formuliert um die Abschwächung.",
    });
    await evaluateClaimRepair(PROJECT_ID, "clm_0001", { orchestrator });
    const open = deriveOpenClaimRepairSuggestions(await store.read());
    expect(open[0].briefingRepair).toBe(
      "Der Absatz, neu formuliert um die Abschwächung.",
    );
    expect((await store.verify()).ok).toBe(true);
  });
});

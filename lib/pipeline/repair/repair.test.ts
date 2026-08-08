import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBackend, Orchestrator } from "../../adapters";
import type { RepairOutput } from "../../adapters";
import { RegisterStore } from "../../register";
import type { Claim, Evidence } from "../../register";
import { RepairPreconditionError } from "../errors";
import { createProject } from "../projects";
import { decideClaim } from "../adjudication/decide";
import { countRepairCycles } from "./cycle-count";
import { decideReEntry } from "./re-entry";
import { applyRepair, discardClaim, proposeRepair } from "./run-repair";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-repair-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
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

const PROJECT_ID = "proj_reparatur";

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
            status: passed ? "bestanden" : "nicht_bestanden",
            at: "2026-08-08T09:00:00Z",
          },
        }),
    judgments: [],
  } as Evidence;
}

/** Project with one source and one beanstandet claim. The route into
 * zur_adjudikation respects the gates: failed existence checks take the
 * stage-1 edge, passed ones go through existenzgeprueft (escalation edge). */
async function projectWithComplainedClaim(
  evidenceEntries: Evidence[],
): Promise<RegisterStore> {
  await createProject({
    id: PROJECT_ID,
    research_question: "Frage?",
    primaryCli: "claude",
  });
  const store = RegisterStore.forProject(PROJECT_ID);
  const allPassed = evidenceEntries.every(
    (entry) => entry.existence_check?.status === "bestanden",
  );
  await store.transaction((tx) => {
    tx.addSource({
      id: "src_0001",
      type: "article-journal",
      title: "Testquelle",
      custom: { source_type: "begutachtete_publikation" },
    } as never);
    tx.addClaim({
      claim: {
        id: "clm_0001",
        text: "Reviews reduzieren die Fehlerdichte immer deutlich.",
        claim_type: "wirksamkeitsaussage",
        briefing_anchor: "p1",
        provenance: {
          tool: "claude",
          model: "claude-sonnet-5",
          extracted_at: "2026-08-08T09:00:00Z",
          search_path: "briefing",
        },
        evidence: evidenceEntries,
      } as Omit<Claim, "status" | "history">,
      actor: "system:extraction",
      reason: "Extrahiert.",
    });
    if (allPassed) {
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existenzpruefung",
        reason: "Existenzprüfung bestanden (Test-Setup).",
      });
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:vorpruefung",
        reason: "Eskaliert (Test-Setup).",
        routing: "eskaliert",
      });
    } else {
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:existenzpruefung",
        reason: "Existenzprüfung nicht bestanden (Test-Setup).",
        routing: "existenz_nicht_bestanden",
      });
    }
  });
  await decideClaim(PROJECT_ID, "clm_0001", {
    categories: ["leitsatz_nicht_herleitbar"],
    durationS: 30,
  });
  return store;
}

function mockOrchestrator(output: RepairOutput): {
  orchestrator: Orchestrator;
  calls: () => string[];
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
    calls: () => backend.calls.map((job) => job.kind),
  };
}

describe("proposeRepair", () => {
  it("builds the repair job from claim, evidence and complaint", async () => {
    await projectWithComplainedClaim([evidence("ev_0001", false)]);
    const { orchestrator, calls } = mockOrchestrator({
      suggested_text: "Reviews können die Fehlerdichte reduzieren.",
      reasoning: "Abschwächung auf den belegten Einzelbefund.",
    });
    const outcome = await proposeRepair(PROJECT_ID, "clm_0001", {
      orchestrator,
    });
    expect(outcome).toEqual({
      status: "proposed",
      suggestion: {
        suggested_text: "Reviews können die Fehlerdichte reduzieren.",
        reasoning: "Abschwächung auf den belegten Einzelbefund.",
      },
    });
    expect(calls()).toEqual(["repair"]);
  });

  it("rejects claims that are not beanstandet", async () => {
    await projectWithComplainedClaim([evidence("ev_0001", false)]);
    await expect(proposeRepair(PROJECT_ID, "clm_9999")).rejects.toThrow(
      RepairPreconditionError,
    );
  });
});

describe("applyRepair", () => {
  it("revises the text, preserves the previous wording and skips stage 1 when existence checks passed", async () => {
    const store = await projectWithComplainedClaim([
      evidence("ev_0001", true),
    ]);
    const result = await applyRepair(PROJECT_ID, "clm_0001", {
      newText: "Reviews können die Fehlerdichte reduzieren.",
      source: "vorschlag_uebernommen",
    });
    expect(result.reentryTarget).toBe("existenzgeprueft");
    const register = await store.read();
    const claim = register.claims[0];
    expect(claim.status).toBe("existenzgeprueft");
    expect(claim.text).toBe("Reviews können die Fehlerdichte reduzieren.");
    const revision = claim.history.find((entry) => entry.revision);
    expect(revision?.revision).toEqual({
      previous_text: "Reviews reduzieren die Fehlerdichte immer deutlich.",
      new_text: "Reviews können die Fehlerdichte reduzieren.",
    });
    expect((await store.verify()).ok).toBe(true);
  });

  it("re-enters the full cascade when existence checks failed", async () => {
    const store = await projectWithComplainedClaim([
      evidence("ev_0001", false),
    ]);
    const result = await applyRepair(PROJECT_ID, "clm_0001", {
      newText: "Neuformulierung.",
      source: "manuell",
    });
    expect(result.reentryTarget).toBe("erfasst");
    expect((await store.read()).claims[0].status).toBe("erfasst");
  });

  it("escalates to adjudication after the cycle limit, with routing", async () => {
    const store = await projectWithComplainedClaim([
      evidence("ev_0001", true),
    ]);
    // Default limit is 2: run two full complain→repair cycles first.
    for (const cycle of [1, 2]) {
      if (cycle > 1) {
        await store.transaction((tx) => {
          tx.transitionClaim("clm_0001", {
            to: "zur_adjudikation",
            actor: "system:vorpruefung",
            reason: "Nicht automatisch bestätigbar (Test-Setup).",
            routing: "negative_vorpruefung",
          });
        });
        await decideClaim(PROJECT_ID, "clm_0001", {
          categories: ["leitsatz_nicht_herleitbar"],
          durationS: 10,
        });
      }
      await applyRepair(PROJECT_ID, "clm_0001", {
        newText: `Fassung ${cycle}.`,
        source: "manuell",
      });
    }
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:vorpruefung",
        reason: "Nicht automatisch bestätigbar (Test-Setup).",
        routing: "negative_vorpruefung",
      });
    });
    await decideClaim(PROJECT_ID, "clm_0001", {
      categories: ["leitsatz_nicht_herleitbar"],
      durationS: 10,
    });

    const result = await applyRepair(PROJECT_ID, "clm_0001", {
      newText: "Dritte Fassung.",
      source: "manuell",
    });
    expect(result.reentryTarget).toBe("zur_adjudikation");
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("zur_adjudikation");
    expect(claim.history.at(-1)?.routing).toBe("eskaliert");
    expect(countRepairCycles(claim)).toBe(3);
  });

  it("rejects empty revisions and non-beanstandet claims", async () => {
    await projectWithComplainedClaim([evidence("ev_0001", true)]);
    await expect(
      applyRepair(PROJECT_ID, "clm_0001", { newText: "  ", source: "manuell" }),
    ).rejects.toThrow(RepairPreconditionError);
    await applyRepair(PROJECT_ID, "clm_0001", {
      newText: "Fassung.",
      source: "manuell",
    });
    await expect(
      applyRepair(PROJECT_ID, "clm_0001", {
        newText: "Noch eine.",
        source: "manuell",
      }),
    ).rejects.toThrow(RepairPreconditionError);
  });
});

describe("discardClaim", () => {
  it("discards beanstandet claims with a reason; they stay visible", async () => {
    const store = await projectWithComplainedClaim([
      evidence("ev_0001", false),
    ]);
    await discardClaim(PROJECT_ID, "clm_0001", "Nicht reparierbar.");
    const register = await store.read();
    expect(register.claims).toHaveLength(1);
    expect(register.claims[0].status).toBe("verworfen");
    expect(register.claims[0].history.at(-1)?.reason).toBe(
      "Nicht reparierbar.",
    );
  });

  it("requires a reason", async () => {
    await projectWithComplainedClaim([evidence("ev_0001", false)]);
    await expect(
      discardClaim(PROJECT_ID, "clm_0001", "  "),
    ).rejects.toThrow(RepairPreconditionError);
  });
});

describe("decideReEntry", () => {
  it("is pure over the claim's history and evidence state", () => {
    const claim = {
      history: [
        { from_status: "beanstandet", to_status: "ueberarbeitet" },
      ],
      evidence: [
        {
          id: "ev_0001",
          existence_check: { status: "bestanden" },
        },
      ],
    } as unknown as Claim;
    expect(decideReEntry(claim, 2).target).toBe("existenzgeprueft");
    expect(decideReEntry(claim, 0).target).toBe("zur_adjudikation");
  });
});

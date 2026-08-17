import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegisterStore } from "../persistence/store";
import type { Claim } from "../schema/claim";
import type { Evidence, Judgment } from "../schema/evidence";
import type { ProjectConfig } from "../schema/project";
import {
  DecisionRequiredError,
  GateRejectedError,
  InvalidTransitionError,
} from "./errors";
import { TRANSITIONS } from "./transitions";

const config: ProjectConfig = {
  rubric_version: "se-evidence-rubric-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};

const source = {
  id: "src_meyer2025",
  type: "article-journal",
  title: "Effects of AI Assistants on Code Review Duration",
  custom: { source_type: "peer_reviewed_publication" },
};

function newEvidence(id = "ev_0001"): Evidence {
  return {
    id,
    source_id: "src_meyer2025",
    locator: { page: 6 },
    verbatim_excerpt: "…median review time dropped…",
    judgments: [],
  } as Evidence;
}

function newClaim(id = "clm_0001", evidence: Evidence[] = [newEvidence()]) {
  return {
    id,
    text: "LLM-Reviews reduzieren die Reviewzeit.",
    claim_type: "quantitative_finding",
    briefing_anchor: "p12",
    provenance: {
      tool: "deep-research-x",
      model: "drx-1",
      extracted_at: "2026-08-06T08:10:00Z",
      search_path: "Lauf 1",
    },
    evidence,
  } as Omit<Claim, "status" | "history">;
}

function judgment(
  backend: string,
  relation: Judgment["relation_type"],
  at = "2026-08-06T09:00:00Z",
): Judgment {
  return {
    backend,
    model: `${backend}-model`,
    relation_type: relation,
    confidence: 0.9,
    reasoning: "Auszug deckt die Aussage.",
    at,
  };
}

let projectDir: string;
let store: RegisterStore;

beforeEach(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-statemachine-"));
  store = RegisterStore.atDirectory(projectDir);
  await store.create({
    id: "proj_statemachine-test",
    research_question: "Funktioniert die Statusmaschine?",
    config,
    actor: "human:lg",
    at: "2026-08-06T08:00:00Z",
  });
  await store.transaction((tx) => {
    tx.addSource(structuredClone(source) as never);
  });
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("claim creation (extraction gate)", () => {
  it("routes claims with evidence to captured", async () => {
    const claim = await store.transaction((tx) =>
      tx.addClaim({
        claim: newClaim(),
        actor: "system:extraction",
        reason: "Extrahiert.",
      }),
    );
    expect(claim.status).toBe("captured");
    expect(claim.history).toHaveLength(1);
    expect(claim.history[0]).toMatchObject({
      from_status: null,
      to_status: "captured",
    });
  });

  it("routes claims without evidence directly to adjudication, visibly", async () => {
    const claim = await store.transaction((tx) =>
      tx.addClaim({
        claim: newClaim("clm_0002", []),
        actor: "system:extraction",
        reason: "Kein Beleg extrahierbar.",
      }),
    );
    expect(claim.status).toBe("pending_adjudication");
  });

  it("routes bundled statements to adjudication despite evidence (atomicity gate)", async () => {
    const bundled = newClaim("clm_0004");
    bundled.text =
      "Die Reviewzeit sinkt um 55 %. Zudem steigt die Codequalität langfristig.";
    const claim = await store.transaction((tx) =>
      tx.addClaim({
        claim: bundled,
        actor: "system:extraction",
        reason:
          "Atomaritätsgate: Extraktionsergebnis bündelt mehrere Aussagen.",
      }),
    );
    expect(claim.status).toBe("pending_adjudication");
    expect(claim.history[0].to_status).toBe("pending_adjudication");
  });

  it("rejects human actors as claim creators", async () => {
    await expect(
      store.transaction((tx) =>
        tx.addClaim({
          claim: newClaim("clm_0003"),
          actor: "human:lg",
          reason: "manuell",
        }),
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe("gate conditions re-derive from persisted state", () => {
  beforeEach(async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim(),
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
    });
  });

  it("blocks existence_checked while checks are missing or failed", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "existence_checked",
          actor: "system:existence_check",
          reason: "sollte scheitern",
        }),
      ),
    ).rejects.toThrow(GateRejectedError);

    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "failed",
        at: "2026-08-06T09:00:00Z",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "existence_checked",
          actor: "system:existence_check",
          reason: "sollte weiter scheitern",
        }),
      ),
    ).rejects.toThrow(GateRejectedError);
  });

  it("routes failed existence checks to adjudication", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "failed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "pending_adjudication",
        actor: "system:existence_check",
        reason: "Wortlaut nicht in der eingefrorenen Fassung gefunden.",
      });
    });
    const register = await store.read();
    expect(register.claims[0].status).toBe("pending_adjudication");
  });

  it("escalates existence_checked → pending_adjudication when adapter retries are exhausted (TMB-19, ratified edge)", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "passed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Wortlaut in der eingefrorenen Fassung verifiziert.",
      });
      const entry = tx.transitionClaim("clm_0001", {
        to: "pending_adjudication",
        actor: "system:adapter",
        reason:
          "LLM-Prüfaufrufe endgültig gescheitert (3 Versuche, timeout) — Eskalation statt stillem Verwerfen.",
      });
      expect(entry.from_status).toBe("existence_checked");
      expect(entry.to_status).toBe("pending_adjudication");
    });
    const register = await store.read();
    expect(register.claims[0].status).toBe("pending_adjudication");
  });

  it("walks the happy path to automatic confirmation", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "passed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Beleg nachgewiesen.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", judgment("claude", "supports"));
      tx.appendJudgment("clm_0001", "ev_0001", judgment("codex", "supports"));
      tx.setResolvedRelation("clm_0001", "ev_0001", "supports");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "licensed");
      tx.transitionClaim("clm_0001", {
        to: "prechecked",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
      tx.transitionClaim("clm_0001", {
        to: "auto_confirmed",
        actor: "system:adjudication_gate",
        reason: "Durchgehend positiv, keine Divergenz.",
      });
    });
    const register = await store.read();
    expect(register.claims[0].status).toBe("auto_confirmed");
    expect(register.claims[0].history.map((entry) => entry.to_status)).toEqual([
      "captured",
      "existence_checked",
      "prechecked",
      "auto_confirmed",
    ]);
    expect((await store.verify()).ok).toBe(true);
  });

  it("blocks automatic confirmation on backend divergence", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "passed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Beleg nachgewiesen.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", judgment("claude", "supports"));
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("codex", "partially_supports"),
      );
      tx.setCalibrationResult("clm_0001", "licensed");
      tx.setResolvedRelation("clm_0001", "ev_0001", "supports");
      tx.setSupportDegree("clm_0001", "supported");
      tx.transitionClaim("clm_0001", {
        to: "prechecked",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "auto_confirmed",
          actor: "system:adjudication_gate",
          reason: "sollte an der Divergenzregel scheitern",
        }),
      ),
    ).rejects.toThrow(/diverge/);
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "pending_adjudication",
        actor: "system:adjudication_gate",
        reason: "Modellfamilien-Divergenz.",
      });
    });
    expect((await store.read()).claims[0].status).toBe("pending_adjudication");
  });

  it("does not read a backend's own revision as divergence (latest judgment counts)", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "passed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Beleg nachgewiesen.",
      });
      // claude first judged partially_supports, then revised to supports after
      // a re-run; codex agrees with the current position.
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("claude", "partially_supports", "2026-08-06T09:00:00Z"),
      );
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("claude", "supports", "2026-08-06T10:00:00Z"),
      );
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("codex", "supports", "2026-08-06T10:05:00Z"),
      );
      tx.setResolvedRelation("clm_0001", "ev_0001", "supports");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "licensed");
      tx.transitionClaim("clm_0001", {
        to: "prechecked",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
      tx.transitionClaim("clm_0001", {
        to: "auto_confirmed",
        actor: "system:adjudication_gate",
        reason: "Aktuelle Urteile beider Backends stimmen überein.",
      });
    });
    expect((await store.read()).claims[0].status).toBe("auto_confirmed");
  });

  it("blocks automatic confirmation on a rubric complaint (Stufe 3)", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "passed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Beleg nachgewiesen.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", judgment("claude", "supports"));
      tx.appendJudgment("clm_0001", "ev_0001", judgment("codex", "supports"));
      tx.setResolvedRelation("clm_0001", "ev_0001", "supports");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "weakened");
      tx.transitionClaim("clm_0001", {
        to: "prechecked",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "auto_confirmed",
          actor: "system:adjudication_gate",
          reason: "sollte an der Rubrik scheitern",
        }),
      ),
    ).rejects.toThrow(/licensed/);
  });
});

describe("human adjudication", () => {
  beforeEach(async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim("clm_0001", []),
        actor: "system:extraction",
        reason: "Unbelegter Claim.",
      });
    });
  });

  it("requires a decision object", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "confirmed",
          actor: "human:lg",
          reason: "ohne Entscheidung",
        }),
      ),
    ).rejects.toThrow(DecisionRequiredError);
  });

  it("confirms with empty categories and records the decision", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "confirmed",
        actor: "human:lg",
        reason: "Manuell verifiziert.",
        decision: { categories: [], reviewed_evidence_ids: [], duration_s: 42 },
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("confirmed");
    expect(claim.history.at(-1)?.decision).toMatchObject({
      categories: [],
      duration_s: 42,
    });
  });

  it("rejects a confirmation that carries complaint categories", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "confirmed",
          actor: "human:lg",
          reason: "Bestätigung mit Kategorie.",
          decision: {
            categories: ["other"],
            reviewed_evidence_ids: [],
            duration_s: 10,
          },
        }),
      ),
    ).rejects.toThrow(DecisionRequiredError);
  });

  it("requires a complaint category for contested", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "contested",
          actor: "human:lg",
          reason: "Kategorie fehlt.",
          decision: {
            categories: [],
            reviewed_evidence_ids: [],
            duration_s: 10,
          },
        }),
      ),
    ).rejects.toThrow(DecisionRequiredError);
  });

  it("accepts multi-select complaints and records all categories", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "contested",
        actor: "human:lg",
        reason: "Aus dem Kontext gerissen und Quelle veraltet.",
        decision: {
          categories: ["taken_out_of_context", "source_outdated"],
          reviewed_evidence_ids: [],
          duration_s: 30,
        },
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("contested");
    expect(claim.history.at(-1)?.decision?.categories).toEqual([
      "taken_out_of_context",
      "source_outdated",
    ]);
  });

  it("rejects system actors on human edges", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "confirmed",
          actor: "system:adjudication_gate",
          reason: "Maschine darf nicht adjudizieren.",
        }),
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it("rejects decisions referencing unknown evidence", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "confirmed",
          actor: "human:lg",
          reason: "Falsche Evidenz-IDs.",
          decision: {
            categories: [],
            reviewed_evidence_ids: ["ev_9999"],
            duration_s: 5,
          },
        }),
      ),
    ).rejects.toThrow(DecisionRequiredError);
  });
});

describe("repair loop", () => {
  beforeEach(async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim("clm_0001", []),
        actor: "system:extraction",
        reason: "Unbelegter Claim.",
      });
      tx.transitionClaim("clm_0001", {
        to: "contested",
        actor: "human:lg",
        reason: "Wortlaut nicht in Quelle.",
        decision: {
          categories: ["wording_not_in_source"],
          reviewed_evidence_ids: [],
          duration_s: 60,
        },
      });
    });
  });

  it("re-enters the cascade after revision", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "revised",
        actor: "system:repair",
        reason: "Neuformulierung vorgeschlagen und angenommen.",
      });
      tx.addEvidence("clm_0001", newEvidence("ev_0002"));
      tx.transitionClaim("clm_0001", {
        to: "captured",
        actor: "system:repair",
        reason: "Neuer Beleg, volle Kaskade.",
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("captured");
    expect(claim.history).toHaveLength(4);
    expect((await store.verify()).ok).toBe(true);
  });

  it("records a text revision with the previous wording preserved", async () => {
    const before = (await store.read()).claims[0].text;
    await store.transaction((tx) => {
      tx.reviseClaimText("clm_0001", "Abgeschwächte Neuformulierung.");
      tx.transitionClaim("clm_0001", {
        to: "revised",
        actor: "human:lg",
        reason: "Reparatur angenommen.",
        revision: {
          previous_text: before,
          new_text: "Abgeschwächte Neuformulierung.",
        },
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.text).toBe("Abgeschwächte Neuformulierung.");
    expect(claim.history.at(-1)?.revision).toEqual({
      previous_text: before,
      new_text: "Abgeschwächte Neuformulierung.",
    });
    expect((await store.verify()).ok).toBe(true);
  });

  it("carries the routing reason on escalation back to adjudication", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "revised",
        actor: "human:lg",
        reason: "Reparatur angenommen.",
      });
      tx.transitionClaim("clm_0001", {
        to: "pending_adjudication",
        actor: "system:repair",
        reason: "Eskaliert nach erschöpften Reparaturzyklen.",
        routing: "escalated",
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.history.at(-1)?.routing).toBe("escalated");
    expect((await store.verify()).ok).toBe(true);
  });

  it("allows discarding unrepairable claims, which then stay in the register", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "discarded",
        actor: "human:lg",
        reason: "Nicht reparierbar.",
      });
    });
    const register = await store.read();
    expect(register.claims).toHaveLength(1);
    expect(register.claims[0].status).toBe("discarded");
  });
});

describe("invalid transitions have zero side effects", () => {
  it("leaves status, history and seq untouched", async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim(),
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "confirmed",
          actor: "human:lg",
          reason: "Abkürzung verboten.",
          decision: {
            categories: [],
            reviewed_evidence_ids: [],
            duration_s: 1,
          },
        }),
      ),
    ).rejects.toThrow(InvalidTransitionError);

    const register = await store.read();
    expect(register.claims[0].status).toBe("captured");
    expect(register.claims[0].history).toHaveLength(1);

    // The next valid mutation continues the chain gaplessly.
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "source_set_frozen",
        reason: "Kette läuft lückenlos weiter.",
        actor: "human:lg",
      });
    });
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("source-correction readmission edge (pending_adjudication → recheck_required)", () => {
  it("readmits a claim whose LATEST transition was routed via existence_check_failed", async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim("clm_gestrandet"),
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
      tx.setExistenceCheck("clm_gestrandet", "ev_0001", {
        status: "failed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_gestrandet", {
        to: "pending_adjudication",
        actor: "system:existence_check",
        reason: "Wortlaut nicht gefunden.",
        routing: "existence_check_failed",
      });
    });
    await store.transaction((tx) => {
      const entry = tx.transitionClaim("clm_gestrandet", {
        to: "recheck_required",
        actor: "system:source_correction",
        reason: "Quellenkennung korrigiert.",
      });
      expect(entry.to_status).toBe("recheck_required");
    });
  });

  it("rejects a claim whose adjudication has a different routing", async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim("clm_eskaliert"),
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
      tx.setExistenceCheck("clm_eskaliert", "ev_0001", {
        status: "passed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_eskaliert", {
        to: "existence_checked",
        actor: "system:existence_check",
        reason: "Zitat nachgewiesen.",
      });
      tx.transitionClaim("clm_eskaliert", {
        to: "pending_adjudication",
        actor: "system:verification",
        reason: "Adapterfehler.",
        routing: "escalated",
      });
    });
    await expect(
      store.transaction((tx) => {
        tx.transitionClaim("clm_eskaliert", {
          to: "recheck_required",
          actor: "system:source_correction",
          reason: "Quellenkennung korrigiert.",
        });
      }),
    ).rejects.toBeInstanceOf(GateRejectedError);
  });

  it("is a system-only edge", async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: newClaim("clm_menschlich"),
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
      tx.setExistenceCheck("clm_menschlich", "ev_0001", {
        status: "failed",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_menschlich", {
        to: "pending_adjudication",
        actor: "system:existence_check",
        reason: "Wortlaut nicht gefunden.",
        routing: "existence_check_failed",
      });
    });
    await expect(
      store.transaction((tx) => {
        tx.transitionClaim("clm_menschlich", {
          to: "recheck_required",
          actor: "human:lg",
          reason: "Von Hand zurückgeholt.",
        });
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe("transition table sanity", () => {
  it("keeps discarded fully terminal; confirmed has exactly the TMB-7 reopening edges", () => {
    expect(TRANSITIONS.filter((def) => def.from === "discarded")).toHaveLength(
      0,
    );
    // Since TMB-7 confirmed is settled, not eternal: reopenable only by a
    // source revision (TMB-44) and a negative warm-run relevance judgment
    // (TMB-43), both system-only.
    expect(
      TRANSITIONS.filter((def) => def.from === "confirmed").map(
        (def) => `${def.to}:${def.actorKind}`,
      ),
    ).toEqual(["pending_adjudication:system", "recheck_required:system"]);
  });

  it("gives every status except discarded at least one outgoing edge", () => {
    const nonTerminal = [
      "captured",
      "existence_checked",
      "prechecked",
      "auto_confirmed",
      "pending_adjudication",
      "confirmed",
      "contested",
      "revised",
      "recheck_required",
    ] as const;
    for (const status of nonTerminal) {
      expect(TRANSITIONS.some((def) => def.from === status)).toBe(true);
    }
  });
});

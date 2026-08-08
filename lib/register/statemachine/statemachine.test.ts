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
  rubric_version: "se-evidenz-rubrik-v1",
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
  custom: { source_type: "begutachtete_publikation" },
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
    claim_type: "quantitativer_einzelbefund",
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
  it("routes claims with evidence to erfasst", async () => {
    const claim = await store.transaction((tx) =>
      tx.addClaim({
        claim: newClaim(),
        actor: "system:extraction",
        reason: "Extrahiert.",
      }),
    );
    expect(claim.status).toBe("erfasst");
    expect(claim.history).toHaveLength(1);
    expect(claim.history[0]).toMatchObject({
      from_status: null,
      to_status: "erfasst",
    });
  });

  it("routes claims without evidence directly to adjudication, visibly", async () => {
    const claim = await store.transaction((tx) =>
      tx.addClaim({
        claim: newClaim("clm_0002", []),
        actor: "system:extraction",
        reason: "Keine Fundstelle extrahierbar.",
      }),
    );
    expect(claim.status).toBe("zur_adjudikation");
  });

  it("routes bundled statements to adjudication despite evidence (Atomaritätsgate)", async () => {
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
    expect(claim.status).toBe("zur_adjudikation");
    expect(claim.history[0].to_status).toBe("zur_adjudikation");
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

  it("blocks existenzgeprueft while checks are missing or failed", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "existenzgeprueft",
          actor: "system:existence_check",
          reason: "sollte scheitern",
        }),
      ),
    ).rejects.toThrow(GateRejectedError);

    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "nicht_bestanden",
        at: "2026-08-06T09:00:00Z",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "existenzgeprueft",
          actor: "system:existence_check",
          reason: "sollte weiter scheitern",
        }),
      ),
    ).rejects.toThrow(GateRejectedError);
  });

  it("routes failed existence checks to adjudication", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "nicht_bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:existence_check",
        reason: "Wortlaut nicht im Snapshot gefunden.",
      });
    });
    const register = await store.read();
    expect(register.claims[0].status).toBe("zur_adjudikation");
  });

  it("escalates existenzgeprueft → zur_adjudikation when adapter retries are exhausted (TMB-19, ratified edge)", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existence_check",
        reason: "Wortlaut im Snapshot verifiziert.",
      });
      const entry = tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:adapter",
        reason:
          "LLM-Prüfaufrufe endgültig gescheitert (3 Versuche, timeout) — Eskalation statt stillem Verwerfen.",
      });
      expect(entry.from_status).toBe("existenzgeprueft");
      expect(entry.to_status).toBe("zur_adjudikation");
    });
    const register = await store.read();
    expect(register.claims[0].status).toBe("zur_adjudikation");
  });

  it("walks the happy path to automatic confirmation", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existence_check",
        reason: "Fundstelle nachgewiesen.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", judgment("claude", "stuetzt"));
      tx.appendJudgment("clm_0001", "ev_0001", judgment("codex", "stuetzt"));
      tx.setResolvedRelation("clm_0001", "ev_0001", "stuetzt");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "lizenziert");
      tx.transitionClaim("clm_0001", {
        to: "vorgeprueft",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
      tx.transitionClaim("clm_0001", {
        to: "automatisch_bestaetigt",
        actor: "system:adjudication_gate",
        reason: "Durchgehend positiv, keine Divergenz.",
      });
    });
    const register = await store.read();
    expect(register.claims[0].status).toBe("automatisch_bestaetigt");
    expect(register.claims[0].history.map((entry) => entry.to_status)).toEqual([
      "erfasst",
      "existenzgeprueft",
      "vorgeprueft",
      "automatisch_bestaetigt",
    ]);
    expect((await store.verify()).ok).toBe(true);
  });

  it("blocks automatic confirmation on backend divergence", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existence_check",
        reason: "Fundstelle nachgewiesen.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", judgment("claude", "stuetzt"));
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("codex", "stuetzt_teilweise"),
      );
      tx.setCalibrationResult("clm_0001", "lizenziert");
      tx.setResolvedRelation("clm_0001", "ev_0001", "stuetzt");
      tx.setSupportDegree("clm_0001", "supported");
      tx.transitionClaim("clm_0001", {
        to: "vorgeprueft",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "automatisch_bestaetigt",
          actor: "system:adjudication_gate",
          reason: "sollte an der Divergenzregel scheitern",
        }),
      ),
    ).rejects.toThrow(/diverge/);
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:adjudication_gate",
        reason: "Modellfamilien-Divergenz.",
      });
    });
    expect((await store.read()).claims[0].status).toBe("zur_adjudikation");
  });

  it("does not read a backend's own revision as divergence (latest judgment counts)", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existence_check",
        reason: "Fundstelle nachgewiesen.",
      });
      // claude first judged stuetzt_teilweise, then revised to stuetzt after
      // a re-run; codex agrees with the current position.
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("claude", "stuetzt_teilweise", "2026-08-06T09:00:00Z"),
      );
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("claude", "stuetzt", "2026-08-06T10:00:00Z"),
      );
      tx.appendJudgment(
        "clm_0001",
        "ev_0001",
        judgment("codex", "stuetzt", "2026-08-06T10:05:00Z"),
      );
      tx.setResolvedRelation("clm_0001", "ev_0001", "stuetzt");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "lizenziert");
      tx.transitionClaim("clm_0001", {
        to: "vorgeprueft",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
      tx.transitionClaim("clm_0001", {
        to: "automatisch_bestaetigt",
        actor: "system:adjudication_gate",
        reason: "Aktuelle Urteile beider Backends stimmen überein.",
      });
    });
    expect((await store.read()).claims[0].status).toBe(
      "automatisch_bestaetigt",
    );
  });

  it("blocks automatic confirmation on a rubric complaint (Stufe 3)", async () => {
    await store.transaction((tx) => {
      tx.setExistenceCheck("clm_0001", "ev_0001", {
        status: "bestanden",
        at: "2026-08-06T09:00:00Z",
      });
      tx.transitionClaim("clm_0001", {
        to: "existenzgeprueft",
        actor: "system:existence_check",
        reason: "Fundstelle nachgewiesen.",
      });
      tx.appendJudgment("clm_0001", "ev_0001", judgment("claude", "stuetzt"));
      tx.appendJudgment("clm_0001", "ev_0001", judgment("codex", "stuetzt"));
      tx.setResolvedRelation("clm_0001", "ev_0001", "stuetzt");
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult("clm_0001", "abschwaechen");
      tx.transitionClaim("clm_0001", {
        to: "vorgeprueft",
        actor: "system:attribution",
        reason: "Stufe 2 und 3 abgeschlossen.",
      });
    });
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "automatisch_bestaetigt",
          actor: "system:adjudication_gate",
          reason: "sollte an der Rubrik scheitern",
        }),
      ),
    ).rejects.toThrow(/lizenziert/);
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
          to: "bestaetigt",
          actor: "human:lg",
          reason: "ohne Entscheidung",
        }),
      ),
    ).rejects.toThrow(DecisionRequiredError);
  });

  it("confirms with empty categories and records the decision", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "bestaetigt",
        actor: "human:lg",
        reason: "Manuell verifiziert.",
        decision: { categories: [], reviewed_evidence_ids: [], duration_s: 42 },
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("bestaetigt");
    expect(claim.history.at(-1)?.decision).toMatchObject({
      categories: [],
      duration_s: 42,
    });
  });

  it("rejects a confirmation that carries complaint categories", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "bestaetigt",
          actor: "human:lg",
          reason: "Bestätigung mit Kategorie.",
          decision: {
            categories: ["sonstiges"],
            reviewed_evidence_ids: [],
            duration_s: 10,
          },
        }),
      ),
    ).rejects.toThrow(DecisionRequiredError);
  });

  it("requires a complaint category for beanstandet", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "beanstandet",
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
        to: "beanstandet",
        actor: "human:lg",
        reason: "Aus dem Kontext gerissen und Quelle veraltet.",
        decision: {
          categories: ["aus_dem_kontext_gerissen", "quelle_veraltet"],
          reviewed_evidence_ids: [],
          duration_s: 30,
        },
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("beanstandet");
    expect(claim.history.at(-1)?.decision?.categories).toEqual([
      "aus_dem_kontext_gerissen",
      "quelle_veraltet",
    ]);
  });

  it("rejects system actors on human edges", async () => {
    await expect(
      store.transaction((tx) =>
        tx.transitionClaim("clm_0001", {
          to: "bestaetigt",
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
          to: "bestaetigt",
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
        to: "beanstandet",
        actor: "human:lg",
        reason: "Wortlaut nicht in Quelle.",
        decision: {
          categories: ["wortlaut_nicht_in_quelle"],
          reviewed_evidence_ids: [],
          duration_s: 60,
        },
      });
    });
  });

  it("re-enters the cascade after revision", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "ueberarbeitet",
        actor: "system:repair",
        reason: "Neuformulierung vorgeschlagen und angenommen.",
      });
      tx.addEvidence("clm_0001", newEvidence("ev_0002"));
      tx.transitionClaim("clm_0001", {
        to: "erfasst",
        actor: "system:repair",
        reason: "Neue Fundstelle, volle Kaskade.",
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.status).toBe("erfasst");
    expect(claim.history).toHaveLength(4);
    expect((await store.verify()).ok).toBe(true);
  });

  it("records a text revision with the previous wording preserved", async () => {
    const before = (await store.read()).claims[0].text;
    await store.transaction((tx) => {
      tx.reviseClaimText("clm_0001", "Abgeschwächte Neuformulierung.");
      tx.transitionClaim("clm_0001", {
        to: "ueberarbeitet",
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
        to: "ueberarbeitet",
        actor: "human:lg",
        reason: "Reparatur angenommen.",
      });
      tx.transitionClaim("clm_0001", {
        to: "zur_adjudikation",
        actor: "system:reparatur",
        reason: "Eskaliert nach erschöpften Reparaturzyklen.",
        routing: "eskaliert",
      });
    });
    const claim = (await store.read()).claims[0];
    expect(claim.history.at(-1)?.routing).toBe("eskaliert");
    expect((await store.verify()).ok).toBe(true);
  });

  it("allows discarding unrepairable claims, which then stay in the register", async () => {
    await store.transaction((tx) => {
      tx.transitionClaim("clm_0001", {
        to: "verworfen",
        actor: "human:lg",
        reason: "Nicht reparierbar.",
      });
    });
    const register = await store.read();
    expect(register.claims).toHaveLength(1);
    expect(register.claims[0].status).toBe("verworfen");
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
          to: "bestaetigt",
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
    expect(register.claims[0].status).toBe("erfasst");
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

describe("transition table sanity", () => {
  it("defines no outgoing edges for terminal states", () => {
    for (const terminal of ["bestaetigt", "verworfen"] as const) {
      expect(TRANSITIONS.filter((def) => def.from === terminal)).toHaveLength(
        0,
      );
    }
  });

  it("gives every status except terminal ones at least one outgoing edge", () => {
    const nonTerminal = [
      "erfasst",
      "existenzgeprueft",
      "vorgeprueft",
      "automatisch_bestaetigt",
      "zur_adjudikation",
      "beanstandet",
      "ueberarbeitet",
    ] as const;
    for (const status of nonTerminal) {
      expect(TRANSITIONS.some((def) => def.from === status)).toBe(true);
    }
  });
});

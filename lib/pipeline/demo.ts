import { RegisterStore } from "../register";
import type { ClaimsRegister } from "../register";
import { createProject } from "./projects";

/**
 * Seeds the example project (TMB-54, D3). Created on explicit request only —
 * never silently at install time — so that someone evaluating the tool has a
 * populated register to walk through before owning a briefing of their own.
 *
 * Provenance instead of quarantine (D1): the project is not read-only and is
 * not barred from export. Every entry this seeder writes carries a
 * `demo_seed` actor, so the hash chain itself says where the material came
 * from — visible in the history, in an exported bundle and under
 * `tmb verify`, and impossible to strip without breaking the chain. That is
 * a stronger guarantee than a UI prohibition, and it keeps the
 * export/verify story — the point of the tool — available in the demo.
 */

/** Fixed id: a second call is meant to fail through the existing
 * ProjectAlreadyExistsError path rather than pile up demo projects. */
export const DEMO_PROJECT_ID = "proj_demo";

/** System-side seeding actor. */
const SEED_ACTOR = "system:demo_seed";
/**
 * Human-side seeding actor. The adjudication edges into `confirmed` and
 * `contested` are reserved for human actors by the transition table, which
 * is binding — so the seeded decisions carry a `human:` actor. It keeps the
 * `demo_seed` token, so every seeded entry still identifies itself.
 */
const SEED_HUMAN_ACTOR = "human:demo_seed";

const BRIEFING = [
  "Dieses Briefing ist ein Demonstrationstext. Es beschreibt eine erfundene " +
    "Studienlage zu einer fiktiven Werkzeugkategorie und dient allein dazu, " +
    "den Prüfablauf an einem gefüllten Register zu zeigen.",
  "Der Einsatz von Musterwerkzeugen senkt die mediane Bearbeitungszeit " +
    "einer Aufgabe um 40 %.",
  "Die Zufriedenheit der Beteiligten steigt dabei messbar an.",
  "Langfristig verbessert sich außerdem die Qualität der Ergebnisse.",
].join("\n\n");

const SOURCE_TEXT_A =
  "Die mediane Bearbeitungszeit sank von 50 auf 30 Minuten je Aufgabe.";
const SOURCE_TEXT_B =
  "Auf einer fünfstufigen Skala stieg die berichtete Zufriedenheit von 3,1 auf 3,4.";

/**
 * Creates the example project and fills it with a walkable register: a
 * frozen briefing, two synthetic sources and three claims that end in
 * different terminal states, so the adjudication queue is non-empty and the
 * status distribution is not uniform.
 *
 * The sources are deliberately, visibly synthetic. Inventing plausible
 * citations to real papers and attaching fabricated findings to them would
 * put exactly the artifact this tool exists to detect into the tool's own
 * demo.
 */
export async function createDemoProject(): Promise<ClaimsRegister> {
  // Goes through the normal creation path, so the demo project is an
  // ordinary project in every respect — including its genesis event, which
  // records the real user as the creator, because they did create it.
  await createProject({
    id: DEMO_PROJECT_ID,
    research_question:
      "Wie wirkt sich der Einsatz von Musterwerkzeugen auf Bearbeitungszeit und Ergebnisqualität aus?",
    primaryCli: "mock",
  });

  const store = RegisterStore.forProject(DEMO_PROJECT_ID);
  const blobs = store.blobs();
  const briefingBlob = blobs.put(BRIEFING, "md");
  const snapshotA = blobs.put("Demo-Dokument A (synthetisch)", "txt");
  const textA = blobs.put(SOURCE_TEXT_A, "txt");
  const snapshotB = blobs.put("Demo-Dokument B (synthetisch)", "txt");
  const textB = blobs.put(SOURCE_TEXT_B, "txt");

  await store.transaction((tx) => {
    tx.recordBriefingImport({
      sha256: briefingBlob.sha256,
      blob_path: briefingBlob.blobPath,
      tool: "demo-seed",
      actor: SEED_ACTOR,
    });
    tx.addSource({
      id: "src_demo-a",
      type: "article-journal",
      title: "Musterstudie A zur Bearbeitungszeit (Demonstrationsquelle)",
      custom: {
        source_type: "peer_reviewed_publication",
        snapshot: {
          retrieved_at: new Date().toISOString(),
          sha256: snapshotA.sha256,
          blob_path: snapshotA.blobPath,
          text_blob_path: textA.blobPath,
          revision: 1,
        },
      },
    } as never);
    tx.addSource({
      id: "src_demo-b",
      type: "report",
      title: "Musterbericht B zur Zufriedenheit (Demonstrationsquelle)",
      custom: {
        source_type: "grey_literature",
        snapshot: {
          retrieved_at: new Date().toISOString(),
          sha256: snapshotB.sha256,
          blob_path: snapshotB.blobPath,
          text_blob_path: textB.blobPath,
          revision: 1,
        },
      },
    } as never);
  });

  // Extraction: one well-supported claim, one weakly supported, one without
  // any evidence at all — the three cases the workshop has to tell apart.
  await store.transaction((tx) => {
    tx.addClaim({
      claim: {
        id: "clm_demo1",
        text: "Musterwerkzeuge senken die mediane Bearbeitungszeit um 40 %.",
        claim_type: "quantitative_finding",
        briefing_anchor: "p2",
        provenance: {
          tool: "demo-seed",
          model: "mock-1",
          extracted_at: new Date().toISOString(),
          search_path: "Demonstrationslauf",
        },
        evidence: [
          {
            id: "ev_demo1",
            source_id: "src_demo-a",
            locator: { page: 4 },
            verbatim_excerpt: SOURCE_TEXT_A,
            judgments: [],
          },
        ],
      },
      actor: SEED_ACTOR,
      reason: "Beispielprojekt: aus Absatz p2 extrahiert.",
    });
    tx.addClaim({
      claim: {
        id: "clm_demo2",
        text: "Die Zufriedenheit der Beteiligten steigt messbar an.",
        claim_type: "effectiveness_statement",
        briefing_anchor: "p3",
        provenance: {
          tool: "demo-seed",
          model: "mock-1",
          extracted_at: new Date().toISOString(),
          search_path: "Demonstrationslauf",
        },
        evidence: [
          {
            id: "ev_demo2",
            source_id: "src_demo-b",
            locator: { page: 2 },
            verbatim_excerpt: SOURCE_TEXT_B,
            judgments: [],
          },
        ],
      },
      actor: SEED_ACTOR,
      reason: "Beispielprojekt: aus Absatz p3 extrahiert.",
    });
    tx.addClaim({
      claim: {
        id: "clm_demo3",
        text: "Langfristig verbessert sich die Qualität der Ergebnisse.",
        claim_type: "effectiveness_statement",
        briefing_anchor: "p4",
        provenance: {
          tool: "demo-seed",
          model: "mock-1",
          extracted_at: new Date().toISOString(),
          search_path: "Demonstrationslauf",
        },
        evidence: [],
      },
      actor: SEED_ACTOR,
      reason:
        "Beispielprojekt: keine Fundstelle extrahierbar – der Claim geht ohne Beleg in die Adjudikation.",
    });
  });

  // Stages 1–3 for the two claims that have evidence.
  await store.transaction((tx) => {
    tx.setExistenceCheck("clm_demo1", "ev_demo1", {
      status: "passed",
      at: new Date().toISOString(),
    });
    tx.transitionClaim("clm_demo1", {
      to: "existence_checked",
      actor: SEED_ACTOR,
      reason:
        "Stufe 1: Wortlaut im eingefrorenen Dokument nachgewiesen (deterministisch).",
    });
    tx.appendJudgment("clm_demo1", "ev_demo1", {
      backend: "mock",
      model: "mock-1",
      relation_type: "supports",
      confidence: 0.93,
      reasoning:
        "Demo-Urteil: Zahlenwert und Richtung des Auszugs decken die Aussage.",
      at: new Date().toISOString(),
    });
    tx.setResolvedRelation("clm_demo1", "ev_demo1", "supports");
    tx.setSupportDegree("clm_demo1", "supported");
    tx.setCalibrationResult("clm_demo1", "licensed");
    tx.transitionClaim("clm_demo1", {
      to: "prechecked",
      actor: SEED_ACTOR,
      reason: "Stufen 2 und 3 abgeschlossen.",
    });
    tx.transitionClaim("clm_demo1", {
      to: "auto_confirmed",
      actor: SEED_ACTOR,
      reason: "Durchgehend positiv, Rubrik lizenziert.",
    });

    tx.setExistenceCheck("clm_demo2", "ev_demo2", {
      status: "passed",
      at: new Date().toISOString(),
    });
    tx.transitionClaim("clm_demo2", {
      to: "existence_checked",
      actor: SEED_ACTOR,
      reason: "Stufe 1: Wortlaut im eingefrorenen Dokument nachgewiesen.",
    });
    tx.appendJudgment("clm_demo2", "ev_demo2", {
      backend: "mock",
      model: "mock-1",
      relation_type: "supports",
      confidence: 0.52,
      reasoning:
        "Demo-Urteil: Der Auszug zeigt einen kleinen Anstieg; „messbar“ ist damit nur schwach gedeckt.",
      at: new Date().toISOString(),
    });
    tx.setResolvedRelation("clm_demo2", "ev_demo2", "supports");
    tx.setSupportDegree("clm_demo2", "partially_supported");
    tx.setCalibrationResult("clm_demo2", "weakened");
    tx.transitionClaim("clm_demo2", {
      to: "prechecked",
      actor: SEED_ACTOR,
      reason: "Stufen 2 und 3 abgeschlossen.",
    });
  });

  // The gate routes what it may not auto-confirm into the queue; the human
  // decisions follow.
  await store.transaction((tx) => {
    tx.transitionClaim("clm_demo1", {
      to: "pending_adjudication",
      actor: SEED_ACTOR,
      reason: "Stichprobenkontrolle (Rate 0.1).",
    });
    tx.transitionClaim("clm_demo1", {
      to: "confirmed",
      actor: SEED_HUMAN_ACTOR,
      reason:
        "Fundstelle im eingefrorenen Dokument geprüft, Zahlenwert stimmt überein.",
      decision: {
        categories: [],
        reviewed_evidence_ids: ["ev_demo1"],
        duration_s: 84,
      },
    });
    tx.transitionClaim("clm_demo2", {
      to: "pending_adjudication",
      actor: SEED_ACTOR,
      reason:
        "Konfidenz unter der Schwelle und Rubrik nicht lizenziert – keine automatische Bestätigung.",
    });
    // clm_demo3 is already in pending_adjudication: a claim added without
    // evidence enters there directly (the null → pending_adjudication edge),
    // because there is nothing for the machine to check.
    tx.transitionClaim("clm_demo3", {
      to: "contested",
      actor: SEED_HUMAN_ACTOR,
      reason:
        "Aussage ohne Fundstelle; im Briefing als belegt formuliert, im Material nicht auffindbar.",
      decision: {
        categories: ["wording_not_in_source"],
        reviewed_evidence_ids: [],
        duration_s: 35,
      },
    });
  });

  // clm_demo2 stays in pending_adjudication on purpose: the queue must be
  // non-empty so the reviewer has something to decide.
  return store.read();
}

import { RegisterStore } from "../../register";
import type { ClaimStatus } from "../../register";

/**
 * Shared test fixture (TMB-7): mints a claim with one evidence entry on the
 * given source and walks it to the requested status through the REAL
 * state-machine gates — facts first (existence check, judgment, relation,
 * support, calibration), then the edges. Unlike fabricated-status fixtures
 * this exercises the gate discipline, so the walk breaks loudly if the
 * cascade changes.
 */
export async function addClaimWalkedTo(options: {
  projectId: string;
  claimNumber: number;
  sourceId: string;
  status: ClaimStatus;
}): Promise<string> {
  const { projectId, claimNumber, sourceId, status } = options;
  const claimId = `clm_${String(claimNumber).padStart(4, "0")}`;
  const evidenceId = `ev_${String(claimNumber).padStart(4, "0")}`;
  const now = new Date().toISOString();
  await RegisterStore.forProject(projectId).transaction((tx) => {
    tx.addClaim({
      claim: {
        id: claimId,
        text: `Die Reviewzeit sank messbar (${claimNumber}).`,
        claim_type: "quantitativer_einzelbefund",
        briefing_anchor: `p${claimNumber}`,
        provenance: {
          tool: "test",
          model: "test",
          extracted_at: now,
          search_path: "Test",
        },
        evidence: [
          {
            id: evidenceId,
            source_id: sourceId,
            locator: { page: 1 },
            verbatim_excerpt: "Reviewzeit sank",
            judgments: [],
          },
        ],
      },
      actor: "system:extraction",
      reason: "Testclaim erzeugt.",
    });
    if (status === "erfasst") {
      return;
    }
    tx.setExistenceCheck(claimId, evidenceId, { status: "bestanden", at: now });
    tx.transitionClaim(claimId, {
      to: "existenzgeprueft",
      actor: "system:existenzpruefung",
      reason: "Existenz nachgewiesen.",
    });
    if (status === "existenzgeprueft") {
      return;
    }
    tx.appendJudgment(claimId, evidenceId, {
      backend: "claude",
      model: "test",
      relation_type: "stuetzt",
      confidence: 0.95,
      reasoning: "Deckt sich mit dem Auszug.",
      at: now,
    });
    tx.setResolvedRelation(claimId, evidenceId, "stuetzt");
    tx.setSupportDegree(claimId, "supported");
    tx.setCalibrationResult(claimId, "lizenziert");
    tx.transitionClaim(claimId, {
      to: "vorgeprueft",
      actor: "system:vorpruefung",
      reason: "Stufen 2/3 abgeschlossen.",
    });
    if (status === "vorgeprueft") {
      return;
    }
    tx.transitionClaim(claimId, {
      to: "automatisch_bestaetigt",
      actor: "system:vorpruefung",
      reason: "Vorprüfung durchgehend positiv.",
    });
    if (status === "automatisch_bestaetigt") {
      return;
    }
    tx.transitionClaim(claimId, {
      to: "zur_adjudikation",
      actor: "system:stichprobe",
      reason: "Stichprobenkontrolle.",
      routing: "stichprobe",
    });
    if (status === "zur_adjudikation") {
      return;
    }
    if (status === "bestaetigt") {
      tx.transitionClaim(claimId, {
        to: "bestaetigt",
        actor: "human:lg",
        reason: "Bestätigt.",
        decision: {
          categories: [],
          reviewed_evidence_ids: [evidenceId],
          duration_s: 30,
        },
      });
      return;
    }
    if (status === "verworfen") {
      tx.transitionClaim(claimId, {
        to: "beanstandet",
        actor: "human:lg",
        reason: "Trägt nicht.",
        decision: {
          categories: ["leitsatz_nicht_herleitbar"],
          reviewed_evidence_ids: [evidenceId],
          duration_s: 30,
        },
      });
      tx.transitionClaim(claimId, {
        to: "verworfen",
        actor: "human:lg",
        reason: "Nicht reparierbar.",
      });
      return;
    }
    throw new Error(`unsupported target status ${status}`);
  });
  return claimId;
}

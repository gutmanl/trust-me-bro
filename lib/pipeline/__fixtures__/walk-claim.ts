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
        claim_type: "quantitative_finding",
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
    if (status === "captured") {
      return;
    }
    tx.setExistenceCheck(claimId, evidenceId, { status: "passed", at: now });
    tx.transitionClaim(claimId, {
      to: "existence_checked",
      actor: "system:existence_check",
      reason: "Zitat nachgewiesen.",
    });
    if (status === "existence_checked") {
      return;
    }
    tx.appendJudgment(claimId, evidenceId, {
      backend: "claude",
      model: "test",
      relation_type: "supports",
      confidence: 0.95,
      reasoning: "Deckt sich mit dem Auszug.",
      at: now,
    });
    tx.setResolvedRelation(claimId, evidenceId, "supports");
    tx.setSupportDegree(claimId, "supported");
    tx.setCalibrationResult(claimId, "licensed");
    tx.transitionClaim(claimId, {
      to: "prechecked",
      actor: "system:precheck",
      reason: "Stufen 2/3 abgeschlossen.",
    });
    if (status === "prechecked") {
      return;
    }
    tx.transitionClaim(claimId, {
      to: "auto_confirmed",
      actor: "system:precheck",
      reason: "Vorprüfung durchgehend positiv.",
    });
    if (status === "auto_confirmed") {
      return;
    }
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: "system:spot_check",
      reason: "Stichprobenkontrolle.",
      routing: "spot_check",
    });
    if (status === "pending_adjudication") {
      return;
    }
    if (status === "confirmed") {
      tx.transitionClaim(claimId, {
        to: "confirmed",
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
    if (status === "discarded") {
      tx.transitionClaim(claimId, {
        to: "contested",
        actor: "human:lg",
        reason: "Trägt nicht.",
        decision: {
          categories: ["claim_not_derivable"],
          reviewed_evidence_ids: [evidenceId],
          duration_s: 30,
        },
      });
      tx.transitionClaim(claimId, {
        to: "discarded",
        actor: "human:lg",
        reason: "Nicht reparierbar.",
      });
      return;
    }
    throw new Error(`unsupported target status ${status}`);
  });
  return claimId;
}

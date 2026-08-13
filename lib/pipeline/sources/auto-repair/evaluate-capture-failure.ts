import type { Orchestrator } from "../../../adapters";
import type { RepairAction } from "../../../register/schema/history";
import type { BackendPreflight } from "../../health";
import { requireProjectStore } from "../../projects";
import {
  enqueueSourceCapture,
  hasCaptureInFlight,
} from "../../runs/auto-chain";
import type { CaptureChainAccess } from "../../runs/auto-chain";
import type { HttpFetcher } from "../fetch-port";
import { nodeHttpFetcher } from "../node-http-fetcher";
import { CONFIDENT_THRESHOLD } from "../reference-scan/crossref-match";
import { deriveDocumentUrl } from "../reference-scan/derive-document-url";
import { deriveOpenCaptureFailures } from "../work-items/failures";
import type { SourceCaptureWorkItem } from "../work-items/types";
import { rematchCitation, repairCandidateOf } from "./derive-candidate";

/** Actor of every automatic-repair register write. */
export const AUTO_REPAIR_ACTOR = "system:auto_repair";

export interface AutoRepairDependencies {
  fetcher?: HttpFetcher;
  orchestrator?: Orchestrator;
  preflight?: BackendPreflight;
  sleep?: (ms: number) => Promise<void>;
  chain?: CaptureChainAccess;
}

/**
 * Case (a) of the automatic repair: a reference-import capture failed —
 * typically a hallucinated identifier that never resolved. Re-derive the
 * citation's metadata from its raw text and ask Crossref which work the
 * TITLE describes. A confident match (score ≥ CONFIDENT_THRESHOLD, and a
 * DIFFERENT identifier than the one that failed) is applied automatically:
 * the corrected attempt re-enqueues under the SAME work-item id, so a
 * success resolves the original failure structurally. A weaker match
 * becomes a durable suggestion; no match records nothing.
 *
 * Loop guard, structural: only `origin: "reference_import"` failures ever
 * trigger this — a failed auto-repair attempt carries origin
 * `"auto_repair"` and is never re-evaluated automatically.
 */
export async function evaluateCaptureFailureRepair(
  projectId: string,
  workItemId: string,
  deps: AutoRepairDependencies = {},
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const failure = deriveOpenCaptureFailures(register).find(
    (entry) =>
      entry.workItemId === workItemId && entry.origin === "reference_import",
  );
  const rawText = failure?.input.auto_capture?.raw_text;
  if (!failure || !rawText) {
    return;
  }
  // A retry of this very item already queued/active? Leave it alone.
  if (
    hasCaptureInFlight(
      projectId,
      (entry) => entry.workItemId === workItemId,
      deps.chain,
    )
  ) {
    return;
  }

  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const match = await rematchCitation(
    rawText,
    register,
    store.projectDir,
    fetcher,
    deps,
  );
  const failedIdentifier = (failure.input.identifier ?? "").toLowerCase();
  if (!match.doi || match.doi.toLowerCase() === failedIdentifier) {
    // Nothing new to try — the failure stands exactly as today.
    return;
  }

  const derived = await deriveDocumentUrl(
    { doi: match.doi },
    { fetcher, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );
  // A returned doi always comes with its match_score (title-resolution
  // sets them together).
  const score = match.match_score ?? 0;
  const action: RepairAction = {
    target: { kind: "capture_failure", work_item_id: workItemId },
    mode: score >= CONFIDENT_THRESHOLD ? "applied" : "suggested",
    basis: "capture_failure_rematch",
    candidate: repairCandidateOf(
      { ...match, doi: match.doi },
      derived.documentUrl,
    ),
    confidence: score,
  };
  const percent = Math.round(score * 100);
  const reason =
    action.mode === "applied"
      ? `Automatische Reparatur: Zitat per Titelabgleich neu aufgelöst ` +
        `(„${match.title ?? match.doi}", ${percent} % Übereinstimmung) – ` +
        `korrigierter Erfassungsversuch eingereiht.`
      : `Reparaturvorschlag: Titelabgleich fand „${match.title ?? match.doi}" ` +
        `(${percent} % Übereinstimmung) – zur Übernahme per Klick.`;

  // TOCTOU re-check under the lock (mirroring correctSource): the slow
  // network/LLM work above raced against human dismissals — a failure the
  // reviewer dropped in the meantime must not sprout a suggestion, let
  // alone an automatic re-capture.
  let stillOpen = false;
  await store.transaction((tx) => {
    stillOpen = deriveOpenCaptureFailures({
      sources: tx.listSources(),
      project_events: tx.listProjectEvents(),
    }).some(
      (entry) =>
        entry.workItemId === workItemId && entry.origin === "reference_import",
    );
    if (!stillOpen) {
      return;
    }
    tx.recordRepairAction({ action, actor: AUTO_REPAIR_ACTOR, reason });
  });

  if (stillOpen && action.mode === "applied") {
    const item: SourceCaptureWorkItem = {
      workItemId,
      origin: "auto_repair",
      label: match.title ?? match.doi,
      request: {
        kind: "doi",
        sourceType: failure.input.source_type,
        identifier: match.doi,
        ...(derived.documentUrl ? { documentUrl: derived.documentUrl } : {}),
        autoCapture: {
          raw_text: rawText,
          method: "crossref_title",
          score,
        },
      },
    };
    (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  }
}

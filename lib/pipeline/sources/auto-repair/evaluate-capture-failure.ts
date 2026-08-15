import type { Orchestrator } from "../../../adapters";
import type { ClaimsRegister, RegisterStore } from "../../../register";
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
import { loadReferenceScanResult } from "../reference-scan/load-scan-result";
import type { TitleMatch } from "../reference-scan/title-resolution";
import { deriveOpenCaptureFailures } from "../work-items/failures";
import type { SourceCaptureWorkItem } from "../work-items/types";
import {
  rematchCitation,
  rematchMeta,
  repairCandidateOf,
} from "./derive-candidate";
import { citationMetaFromManual, repairableOrigin } from "./repair-input";
import type { ManualCitationFields } from "./repair-input";

/** Actor of every automatic-repair register write. */
export const AUTO_REPAIR_ACTOR = "system:auto_repair";

/**
 * What a failed attempt left behind to re-resolve from. For a reference
 * import the two strings differ on purpose: `citationLine` is what the
 * rematch QUERIES with, `rawText` is the provenance the repaired attempt
 * carries forward (the review keys already-captured detection on it, so it
 * must survive unchanged).
 */
type RematchProvenance =
  | { kind: "auto_capture"; rawText: string; citationLine: string }
  | { kind: "manual"; manual: ManualCitationFields };

/**
 * The title the reference scan ALREADY resolved for this candidate — for a
 * reference import the work-item id IS the scan's candidate id (see
 * enqueue-candidate-capture).
 *
 * It is by far the better thing to query with: `auto_capture.raw_text` is
 * the briefing PARAGRAPH that cites the work, and a citing paragraph
 * routinely names no title at all — leaving the parser nothing to extract
 * and the deterministic floor handing Crossref a paragraph of prose. The
 * scan's title is an actual citation string.
 *
 * Undefined when no scan exists, its blob is unreadable, or a rescan
 * dropped the candidate; the raw text then stands in, exactly as before.
 */
function scannedCandidateTitle(
  store: RegisterStore,
  register: ClaimsRegister,
  workItemId: string,
): string | undefined {
  const pointer = register.project.reference_scan;
  if (!pointer) {
    return undefined;
  }
  try {
    const candidate = loadReferenceScanResult(store, pointer).candidates.find(
      (entry) => entry.candidate_id === workItemId,
    );
    const title = candidate?.title?.trim();
    return title !== undefined && title.length > 0 ? title : undefined;
  } catch {
    // A corrupt scan blob must never turn a repair evaluation into a
    // failure — the raw citation text is still there to fall back on.
    return undefined;
  }
}

export interface AutoRepairDependencies {
  fetcher?: HttpFetcher;
  orchestrator?: Orchestrator;
  preflight?: BackendPreflight;
  sleep?: (ms: number) => Promise<void>;
  chain?: CaptureChainAccess;
}

/**
 * Case (a) of the automatic repair: a capture attempt failed — typically a
 * hallucinated identifier that never resolved. Re-derive the citation's
 * metadata and ask Crossref which work the TITLE describes. A confident
 * match (score ≥ CONFIDENT_THRESHOLD, and a DIFFERENT identifier than the
 * one that failed) is applied automatically: the corrected attempt
 * re-enqueues under the SAME work-item id, so a success resolves the
 * original failure structurally. A weaker match becomes a durable
 * suggestion; no match records nothing.
 *
 * Every origin `repairableOrigin` admits reaches this, whichever way the
 * attempt entered the workshop — the post-scan run, a per-row "Übernehmen",
 * the manual capture modal, a correction, and any RETRY of those, since a
 * retry is just another failing capture run. The two provenances differ
 * only in what the rematch reads: a reference import re-parses the title
 * its scan already resolved (falling back to the raw citation text), a
 * manual attempt uses the form fields it was given.
 *
 * Loop guard, structural: a failed auto-repair attempt carries origin
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
      entry.workItemId === workItemId && repairableOrigin(entry.origin),
  );
  if (!failure) {
    return;
  }
  // Which provenance the rematch reads, decided once: it picks both the
  // query below and the provenance the repaired attempt carries forward.
  const rawText = failure.input.auto_capture?.raw_text;
  const manual = failure.input.manual;
  const provenance: RematchProvenance | undefined =
    rawText !== undefined
      ? {
          kind: "auto_capture",
          rawText,
          citationLine:
            scannedCandidateTitle(store, register, workItemId) ?? rawText,
        }
      : manual !== undefined
        ? { kind: "manual", manual }
        : undefined;
  if (provenance === undefined) {
    // Neither provenance left anything to re-resolve from — an upload-only
    // attempt, say. Nothing this evaluator can act on.
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
  const match: TitleMatch =
    provenance.kind === "auto_capture"
      ? // Reference-import provenance: the citation line still needs its
        // metadata parsed out before Crossref can be asked anything.
        await rematchCitation(
          provenance.citationLine,
          register,
          store.projectDir,
          fetcher,
          deps,
        )
      : // Manual/correction provenance: the form fields ARE the metadata,
        // so no backend is involved at all.
        await rematchMeta(
          citationMetaFromManual(provenance.manual),
          fetcher,
          deps.sleep,
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

  /**
   * The document the corrected identity gets frozen from, best evidence
   * first:
   *
   *   1. a derivation that ASSERTED the document (arXiv, a Crossref link
   *      typed application/pdf, an Unpaywall open-access copy);
   *   2. the URL the FAILED attempt already carried — typically one a human
   *      supplied by hand, and for a closed-access work usually the only
   *      reachable copy there is;
   *   3. a merely PDF-SHAPED Crossref link, which for a closed work is the
   *      publisher's paywall and answers 403.
   *
   * Order matters: a guess that outranks a human's own URL turns a working
   * capture into a 403, which is exactly what it did before this ordering
   * existed.
   *
   * Inheriting at all is deliberate and not free: that URL belonged to the
   * DISCREDITED identity, so it can be the wrong paper's PDF, and
   * `expectedExt` proves PDF-ness, not right-paper-ness. A wrong document
   * surfaces immediately as failing stage-1 quotes.
   */
  const inheritedUrl = failure.input.document_url;
  const repairDocumentUrl =
    derived.documentUrl !== undefined && derived.guessed !== true
      ? derived.documentUrl
      : (inheritedUrl ?? derived.documentUrl);
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
        entry.workItemId === workItemId && repairableOrigin(entry.origin),
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
        // A correction's repair stays a correction: without the target the
        // retried attempt would create a SECOND source instead of
        // replacing the wrong identity on the existing one.
        ...(failure.input.target_source_id !== undefined
          ? { targetSourceId: failure.input.target_source_id }
          : {}),
        identifier: match.doi,
        ...(repairDocumentUrl !== undefined
          ? { documentUrl: repairDocumentUrl, expectedExt: "pdf" }
          : {}),
        // The attempt keeps the provenance it was repaired FROM: a
        // reference import stays auto-captured, a human-entered attempt
        // keeps its form metadata rather than being restamped as an
        // auto-import — which would silently widen what a later automatic
        // repair may do to the resulting source.
        ...(provenance.kind === "auto_capture"
          ? {
              autoCapture: {
                raw_text: provenance.rawText,
                method: "crossref_title" as const,
                score,
              },
            }
          : { manual: provenance.manual }),
      },
    };
    (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  }
}

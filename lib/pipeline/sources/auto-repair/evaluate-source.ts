import { randomUUID } from "node:crypto";

import { createProjectOrchestrator } from "../../../adapters";
import { loadAdapterConfig } from "../../../identity";
import type { RepairAction } from "../../../register/schema/history";
import { permissiveBackendPreflight, probeBackendUsable } from "../../health";
import { requireProjectStore } from "../../projects";
import {
  activeCaptureItem,
  enqueueSourceCapture,
  pendingCaptureItems,
} from "../../runs/auto-chain";
import { checkSourceLive } from "../../verification/stage1/source-check";
import { acquireDocument, extractTextOrError } from "../document";
import { nodeHttpFetcher } from "../node-http-fetcher";
import { CONFIDENT_THRESHOLD } from "../reference-scan/crossref-match";
import { deriveDocumentUrl } from "../reference-scan/derive-document-url";
import { matchViaCrossrefTitle } from "../reference-scan/title-resolution";
import { deriveOpenCaptureFailures } from "../work-items/failures";
import type { SourceCaptureWorkItem } from "../work-items/types";
import { failingExcerptsForSource } from "./candidates";
import { deriveCitationMeta } from "./derive-candidate";
import {
  AUTO_REPAIR_ACTOR,
  type AutoRepairDependencies,
} from "./evaluate-capture-failure";
import { deriveOpenRepairActions } from "./suggestions";
import { evaluateQuoteFit } from "./quote-fit";
import type { QuoteFitResult } from "./quote-fit";

/**
 * Cases (b) and (c) of the automatic repair: an already-captured,
 * auto-imported source whose identity is suspect.
 *
 * (b) UNAMBIGUOUS — the live identity check itself fails (dead DOI,
 *     snapshot hash mismatch): a confident Crossref rematch of the
 *     original citation is applied automatically as an identity
 *     correction.
 * (c) AMBIGUOUS — the identity resolves fine but stranded claims' quoted
 *     wording is missing from the frozen text (wrong paper OR wrong
 *     wording): the candidate's document is actually FETCHED and the
 *     failing excerpts tested against it (quote-fit). Only a candidate
 *     that verifiably contains what the current text lacks is applied;
 *     everything weaker becomes a suggestion.
 *
 * Loop guards, structural: no `auto_capture` provenance (manual sources)
 * → out of scope; an open auto_repair-origin failure targeting the source
 * → the one automatic attempt already happened; an open suggestion → no
 * re-recording spam; a queued/active correction → a human is on it.
 */
export async function evaluateSourceRepair(
  projectId: string,
  sourceId: string,
  deps: AutoRepairDependencies = {},
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const source = register.sources.find((entry) => entry.id === sourceId);
  const rawText = source?.custom.auto_capture?.raw_text;
  if (!source || !rawText || !source.custom.snapshot) {
    return;
  }
  const openFailures = deriveOpenCaptureFailures(register);
  if (
    openFailures.some(
      (entry) =>
        entry.origin === "auto_repair" &&
        entry.input.target_source_id === sourceId,
    )
  ) {
    return;
  }
  if (
    deriveOpenRepairActions(register).some(
      (entry) =>
        entry.target.kind === "source" && entry.target.sourceId === sourceId,
    )
  ) {
    return;
  }
  const active = (deps.chain?.activeCaptureItem ?? activeCaptureItem)(
    projectId,
  );
  const queued = (deps.chain?.pendingCaptureItems ?? pendingCaptureItems)(
    projectId,
  );
  if (
    [active, ...queued].some(
      (entry) => entry !== undefined && entry.targetSourceId === sourceId,
    )
  ) {
    return;
  }

  const fetcher = deps.fetcher ?? nodeHttpFetcher;

  // Recompute both signals LIVE — never trust stale register state.
  let identityBroken = false;
  try {
    identityBroken = !(await checkSourceLive(source, fetcher)).ok;
  } catch {
    // Network error: no signal, not a verdict — skip this evaluation.
    return;
  }
  const failingExcerpts = failingExcerptsForSource(register, sourceId);
  const currentText = source.custom.snapshot.text_blob_path
    ? store.blobs().readText(source.custom.snapshot.text_blob_path)
    : undefined;
  if (!identityBroken && failingExcerpts.length === 0) {
    // Neither signal actually fails (stale routing) — nothing to repair.
    return;
  }

  const preflight =
    deps.preflight ??
    (deps.orchestrator ? permissiveBackendPreflight : probeBackendUsable);
  const backendId = register.config.backends.primary.cli;
  const primaryReady = await preflight(backendId);
  const orchestrator =
    deps.orchestrator ?? createProjectOrchestrator(register.config);

  const meta = await deriveCitationMeta(rawText, {
    orchestrator,
    backendId,
    backendUsable: primaryReady.usable,
    timeoutMs: loadAdapterConfig().timeoutMs,
    projectDir: store.projectDir,
  });
  const match = await matchViaCrossrefTitle(meta, fetcher, deps.sleep);
  const currentDoi =
    typeof source.DOI === "string" ? source.DOI.toLowerCase() : "";
  if (!match.doi || match.doi.toLowerCase() === currentDoi) {
    return;
  }

  const derived = await deriveDocumentUrl(
    { doi: match.doi },
    { fetcher, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );

  // A returned doi always comes with its match_score (title-resolution
  // sets them together).
  const score = match.match_score ?? 0;
  let mode: "applied" | "suggested";
  let quoteFit: QuoteFitResult | undefined;
  if (identityBroken) {
    // Case (b): the identity is provably dead — the metadata match decides.
    mode = score >= CONFIDENT_THRESHOLD ? "applied" : "suggested";
  } else {
    // Case (c): quote-fit disambiguation — fetch the candidate document
    // and test the failing excerpts. Any failure to obtain/extract the
    // document degrades to a suggestion, never to a blind application.
    mode = "suggested";
    if (derived.documentUrl) {
      try {
        const document = await acquireDocument(
          { documentUrl: derived.documentUrl, expectedExt: "pdf" },
          fetcher,
        );
        const extraction = await extractTextOrError(
          document.content,
          document.ext,
        );
        if ("text" in extraction) {
          quoteFit = evaluateQuoteFit(
            extraction.text,
            failingExcerpts,
            currentText,
          );
          if (quoteFit.confident) {
            mode = "applied";
          }
        }
      } catch {
        // Candidate document unreachable — suggestion only.
      }
    }
  }

  const action: RepairAction = {
    target: { kind: "source", source_id: sourceId },
    mode,
    basis: identityBroken
      ? "identity_unambiguous_rematch"
      : "quote_fit_rematch",
    candidate: {
      kind: "doi",
      identifier: match.doi,
      ...(derived.documentUrl ? { document_url: derived.documentUrl } : {}),
      ...(match.title ? { title: match.title } : {}),
    },
    confidence: score,
    ...(quoteFit !== undefined
      ? {
          quote_fit: {
            candidate_matches: quoteFit.candidateMatches,
            current_matches: quoteFit.currentMatches,
            checked_excerpts: quoteFit.checkedExcerpts,
          },
        }
      : {}),
  };
  const percent = Math.round(score * 100);
  const fitNote =
    quoteFit !== undefined
      ? ` Zitat-Abgleich: ${quoteFit.candidateMatches} von ` +
        `${quoteFit.checkedExcerpts} fehlenden Zitatstellen im Kandidaten ` +
        `gefunden, ${quoteFit.currentMatches} im aktuellen Bestand.`
      : "";
  const reason =
    mode === "applied"
      ? `Automatische Reparatur der Quelle ${sourceId}: Kennung per ` +
        `Titelabgleich neu aufgelöst („${match.title ?? match.doi}", ` +
        `${percent} % Übereinstimmung) – Korrektur eingereiht.${fitNote}`
      : `Reparaturvorschlag für Quelle ${sourceId}: Titelabgleich fand ` +
        `„${match.title ?? match.doi}" (${percent} % Übereinstimmung) – ` +
        `zur Übernahme per Klick.${fitNote}`;

  await store.transaction((tx) => {
    tx.recordRepairAction({ action, actor: AUTO_REPAIR_ACTOR, reason });
  });

  if (mode === "applied") {
    const item: SourceCaptureWorkItem = {
      workItemId: `wi_${randomUUID()}`,
      origin: "auto_repair",
      label: match.title ?? match.doi,
      request: {
        kind: "doi",
        sourceType: source.custom.source_type,
        targetSourceId: sourceId,
        identifier: match.doi,
        ...(derived.documentUrl ? { documentUrl: derived.documentUrl } : {}),
      },
    };
    (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  }
}

import { randomUUID } from "node:crypto";

import type { ClaimsRegister } from "../../../register";
import type { RepairAction } from "../../../register/schema/history";
import { requireProjectStore } from "../../projects";
import {
  enqueueSourceCapture,
  hasCaptureInFlight,
} from "../../runs/auto-chain";
import { checkSourceLive } from "../../verification/stage1/source-check";
import { acquireDocument, extractTextOrError } from "../document";
import { nodeHttpFetcher } from "../node-http-fetcher";
import { CONFIDENT_THRESHOLD } from "../reference-scan/crossref-match";
import { deriveDocumentUrl } from "../reference-scan/derive-document-url";
import { deriveOpenCaptureFailures } from "../work-items/failures";
import type { SourceCaptureWorkItem } from "../work-items/types";
import { failingExcerptsForSource } from "./candidates";
import type { DerivedCitationMeta } from "./derive-candidate";
import {
  rematchCitation,
  rematchMeta,
  repairCandidateOf,
} from "./derive-candidate";
import { citationMetaFromSource } from "./repair-input";
import {
  AUTO_REPAIR_ACTOR,
  type AutoRepairDependencies,
} from "./evaluate-capture-failure";
import { deriveOpenRepairActions } from "./suggestions";
import { evaluateQuoteFit } from "./quote-fit";
import type { QuoteFitResult } from "./quote-fit";

/** The evaluator's own preconditions, shared between the initial read and
 * the TOCTOU re-check inside the recording transaction: no open suggestion
 * for the source, no open auto_repair failure targeting it. */
function repairStillUnattempted(
  state: Pick<ClaimsRegister, "sources" | "project_events">,
  sourceId: string,
): boolean {
  return (
    !deriveOpenCaptureFailures(state).some(
      (entry) =>
        entry.origin === "auto_repair" &&
        entry.input.target_source_id === sourceId,
    ) &&
    !deriveOpenRepairActions(state).some(
      (entry) =>
        entry.target.kind === "source" && entry.target.sourceId === sourceId,
    )
  );
}

/** What the source-level rematch reads: the raw citation line an auto-import
 * kept, or the CSL core of a manually captured source. */
type SourceRematchInput =
  | { kind: "raw_text"; rawText: string }
  | { kind: "meta"; meta: DerivedCitationMeta };

/**
 * Cases (b) and (c) of the automatic repair: an already-captured source
 * whose identity is suspect.
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
 * A MANUALLY captured source takes the same two paths from its own CSL
 * core, with one difference that is the whole point: it is never applied
 * automatically, only ever suggested. The identity came from a human, so
 * replacing it stays a human's click.
 *
 * Loop guards, structural: an open auto_repair-origin failure targeting the
 * source → the one automatic attempt already happened; an open suggestion →
 * no re-recording spam; a queued/active correction → a human is on it.
 */
export async function evaluateSourceRepair(
  projectId: string,
  sourceId: string,
  deps: AutoRepairDependencies = {},
): Promise<void> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const source = register.sources.find((entry) => entry.id === sourceId);
  if (!source || !source.custom.snapshot) {
    return;
  }
  // What the rematch reads, settled before any network work: an auto-import
  // re-parses its raw citation line; a manually captured source has none, so
  // its own CSL core stands in. Neither usable → nothing to re-resolve from.
  const rawText = source.custom.auto_capture?.raw_text;
  const sourceMeta =
    rawText === undefined ? citationMetaFromSource(source) : undefined;
  const rematchInput: SourceRematchInput | undefined =
    rawText !== undefined
      ? { kind: "raw_text", rawText }
      : sourceMeta !== undefined
        ? { kind: "meta", meta: sourceMeta }
        : undefined;
  if (rematchInput === undefined) {
    return;
  }
  if (!repairStillUnattempted(register, sourceId)) {
    return;
  }
  if (
    hasCaptureInFlight(
      projectId,
      (entry) => entry.targetSourceId === sourceId,
      deps.chain,
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

  const match =
    rematchInput.kind === "raw_text"
      ? await rematchCitation(
          rematchInput.rawText,
          register,
          store.projectDir,
          fetcher,
          deps,
        )
      : await rematchMeta(rematchInput.meta, fetcher, deps.sleep);
  const currentDoi =
    typeof source.DOI === "string" ? source.DOI.toLowerCase() : "";
  if (!match.doi || match.doi.toLowerCase() === currentDoi) {
    return;
  }

  const rawDerived = await deriveDocumentUrl(
    { doi: match.doi },
    { fetcher, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );
  // A merely PDF-SHAPED link is never offered as a CORRECTION's document.
  // A correction replaces the identity of a source that already exists, so
  // a wrong guess does not just fail an import — it overwrites a frozen
  // document with a publisher landing page. Only an asserted document
  // (arXiv, a Crossref link typed application/pdf, an Unpaywall copy) is
  // good enough here; without one the reviewer supplies the document.
  const derived = rawDerived.guessed === true ? {} : rawDerived;

  // A returned doi always comes with its match_score (title-resolution
  // sets them together).
  const score = match.match_score ?? 0;
  // A manually captured source is only ever SUGGESTED a new identity: a
  // human typed that identity deliberately, so silently re-resolving it to
  // a different work is the one outcome that must stay a click away.
  const autoApplicable = rematchInput.kind === "raw_text";
  let mode: "applied" | "suggested";
  let quoteFit: QuoteFitResult | undefined;
  if (identityBroken) {
    // Case (b): the identity is provably dead — the metadata match decides.
    mode =
      autoApplicable && score >= CONFIDENT_THRESHOLD ? "applied" : "suggested";
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
          if (autoApplicable && quoteFit.confident) {
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
    candidate: repairCandidateOf(
      { ...match, doi: match.doi },
      derived.documentUrl,
    ),
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

  // TOCTOU re-check under the lock (mirroring correctSource): while the
  // slow live checks and document fetches ran, a human may have dismissed
  // a suggestion, applied one, or corrected the identity outright — the
  // late evaluation must not revive what was just settled. The identity
  // itself is pinned by the correction-count: any correction that landed
  // in between grew `previous_identities`.
  const identityMark = source.custom.previous_identities?.length ?? 0;
  let stillRelevant = false;
  await store.transaction((tx) => {
    const state = {
      sources: tx.listSources(),
      project_events: tx.listProjectEvents(),
    };
    const lockedSource = state.sources.find((entry) => entry.id === sourceId);
    stillRelevant =
      lockedSource !== undefined &&
      (lockedSource.custom.previous_identities?.length ?? 0) === identityMark &&
      repairStillUnattempted(state, sourceId);
    if (!stillRelevant) {
      return;
    }
    tx.recordRepairAction({ action, actor: AUTO_REPAIR_ACTOR, reason });
  });

  if (stillRelevant && mode === "applied") {
    const item: SourceCaptureWorkItem = {
      workItemId: `wi_${randomUUID()}`,
      origin: "auto_repair",
      label: match.title ?? match.doi,
      request: {
        kind: "doi",
        sourceType: source.custom.source_type,
        targetSourceId: sourceId,
        identifier: match.doi,
        ...(derived.documentUrl
          ? { documentUrl: derived.documentUrl, expectedExt: "pdf" }
          : {}),
      },
    };
    (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  }
}

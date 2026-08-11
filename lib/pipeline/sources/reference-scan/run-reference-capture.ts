import type { SourceType } from "../../../register";
import { PipelineError, ReferenceCapturePreconditionError } from "../../errors";
import { requireProjectStore } from "../../projects";
import { getGlobalJobRunner } from "../../runs/job-runner";
import type { JobRunner } from "../../runs/job-runner";
import type { RunHandle } from "../../runs/types";
import { captureSource, isSourceSetFrozen } from "../capture";
import type { CaptureSourceInput } from "../capture";
import type { HttpFetcher } from "../fetch-port";
import { loadReferenceScanResult } from "./load-scan-result";
import type { ReferenceCandidate } from "./schema";

/**
 * Reference-capture batch (reference auto-import): one job-runner item per
 * user-selected candidate, each independently captured through the SAME
 * captureSource() the manual capture forms use — every item is therefore
 * self-durable the instant its own transaction commits (source entry +
 * auto_capture provenance), exactly like a manual capture. NO bracket
 * events are recorded here, unlike extraction/verification/relevance:
 * there is no partial-batch state worth deriving beyond "which sources
 * exist now", and the job-runner's own progress feed (item_started/
 * item_completed) already gives the UI everything a bracket would add.
 * Per-item failures ride the job-runner's existing try/catch around each
 * step (job-runner.ts) — a stale candidate id, a frozen source set reached
 * mid-batch, or a capture error for one item never aborts its siblings.
 */

export interface ReferenceCaptureSelection {
  candidateId: string;
  sourceType: SourceType;
  /** Required for `url`-method and `unresolved` candidates with no title of
   * their own; overrides the candidate's own title otherwise. */
  title?: string;
  /** User-supplied document URL from the review form (reference auto-
   * import): overrides an identifier candidate's derived `document_url`, and
   * completes an `unresolved` candidate (the URL becomes both its source URL
   * and the document to freeze). */
  documentUrl?: string;
  /** User-uploaded PDF from the review form: the way to complete a candidate
   * whose document is behind a paywall or otherwise not auto-downloadable
   * (finding: real-world references). Takes precedence over any URL. */
  upload?: { content: Buffer; filename: string };
}

export interface ReferenceCaptureDependencies {
  runner?: JobRunner;
  fetcher?: HttpFetcher;
}

export interface ReferenceCaptureItemResult {
  candidateId: string;
  sourceId: string;
  message: string;
}

export async function startReferenceCapture(
  projectId: string,
  selections: readonly ReferenceCaptureSelection[],
  deps: ReferenceCaptureDependencies = {},
): Promise<RunHandle<ReferenceCaptureItemResult>> {
  if (selections.length === 0) {
    throw new ReferenceCapturePreconditionError("Keine Kandidaten ausgewählt.");
  }
  const store = requireProjectStore(projectId);
  const register = await store.read();
  if (isSourceSetFrozen(register)) {
    throw new ReferenceCapturePreconditionError(
      "Der Quellenbestand ist bereits eingefroren.",
    );
  }

  const runner = deps.runner ?? getGlobalJobRunner();
  const fetcher = deps.fetcher;

  return runner.submit(
    projectId,
    selections,
    (selection) => selection.candidateId,
    (selection) => captureOneCandidate(projectId, selection, fetcher),
    { kind: "reference_capture" },
  );
}

/** The live (or latest) reference-capture run handle, for the SSE stream. */
export function getReferenceCaptureRun(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): RunHandle | undefined {
  return (deps.runner ?? getGlobalJobRunner()).currentRun(
    projectId,
    "reference_capture",
  );
}

/** Per-candidate outcome of the last capture run. */
export interface ReferenceCaptureOutcome {
  candidateId: string;
  status: "ok" | "error";
  /** German reason, present when status is "error". */
  error?: string;
}

/**
 * Per-candidate outcomes of the latest reference-capture run, read from the
 * runner's in-memory event log (the itemId of a capture item IS its
 * candidateId). Server-derived on purpose: the capture panel's live SSE feed
 * is volatile client state that a fast run and the post-run refresh can race
 * away, so the durable "why did this candidate not import" is re-derived here
 * on every page render instead. Empty until a run has produced outcomes;
 * survives until the next run or a server restart (capture keeps no durable
 * bracket state, by design — run-reference-capture batch note above).
 */
export function getReferenceCaptureOutcomes(
  projectId: string,
  deps: { runner?: JobRunner } = {},
): ReferenceCaptureOutcome[] {
  const run = getReferenceCaptureRun(projectId, deps);
  if (!run) {
    return [];
  }
  const outcomes: ReferenceCaptureOutcome[] = [];
  for (const event of run.eventsSoFar()) {
    if (event.type === "item_completed") {
      outcomes.push({
        candidateId: event.itemId,
        status: event.outcome.status,
        ...(event.outcome.error ? { error: event.outcome.error } : {}),
      });
    }
  }
  return outcomes;
}

async function captureOneCandidate(
  projectId: string,
  selection: ReferenceCaptureSelection,
  fetcher: HttpFetcher | undefined,
): Promise<ReferenceCaptureItemResult> {
  // Re-reads the CURRENT blob per item (not once for the whole batch): the
  // job-runner's single-writer exclusivity means nothing else can capture
  // concurrently, but a candidate can still have gone stale (rescanned away)
  // since the batch was submitted.
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const pointer = register.project.reference_scan;
  if (!pointer) {
    throw new PipelineError(
      `Für Projekt "${projectId}" liegt kein Ergebnis eines Referenz-Scans vor.`,
    );
  }
  const { candidates } = loadReferenceScanResult(store, pointer);
  const candidate = candidates.find(
    (entry) => entry.candidate_id === selection.candidateId,
  );
  if (!candidate) {
    throw new PipelineError(
      `Kandidat "${selection.candidateId}" ist im aktuellen Scan-Ergebnis nicht mehr vorhanden.`,
    );
  }

  const input = buildCaptureInput(projectId, candidate, selection);
  const source = await captureSource(input, { fetcher });
  return {
    candidateId: selection.candidateId,
    sourceId: source.id,
    message: `Quelle "${source.id}" erfasst.`,
  };
}

function buildCaptureInput(
  projectId: string,
  candidate: ReferenceCandidate,
  selection: ReferenceCaptureSelection,
): CaptureSourceInput {
  const autoCapture = {
    raw_text: candidate.raw_text,
    method: candidate.method as "doi" | "arxiv" | "url" | "crossref_title",
    ...(candidate.match_score !== undefined
      ? { score: candidate.match_score }
      : {}),
  };

  // Document URL precedence (reference auto-import, Task 3b): a user-
  // supplied override from the review form always wins; otherwise fall
  // back to the candidate's derived document_url (run-reference-scan.ts's
  // arXiv PDF > Crossref PDF-link > Unpaywall chain — see
  // derive-document-url.ts). expectedExt="pdf" guards ONLY the derived
  // case: a user typed the override themselves and vouches for it, so it
  // is passed to acquireDocument() unchecked, exactly like a manual
  // capture's documentUrl always has been.
  const documentUrlOverride = selection.documentUrl?.trim() || undefined;
  const documentUrl = documentUrlOverride ?? candidate.document_url;
  // An uploaded PDF the user vouches for always wins; a user-typed URL is
  // passed unchecked (like a manual capture). expectedExt="pdf" guards ONLY
  // the auto-DERIVED document_url — the one case where the app, not the user,
  // chose the link and must prove it is a PDF (never a landing page).
  const expectedExt =
    selection.upload === undefined &&
    documentUrlOverride === undefined &&
    candidate.document_url !== undefined
      ? "pdf"
      : undefined;
  const upload = selection.upload;

  switch (candidate.method) {
    case "doi":
    case "crossref_title":
      return {
        projectId,
        kind: "doi",
        identifier: candidate.doi,
        sourceType: selection.sourceType,
        ...(upload ? { upload } : { documentUrl, expectedExt }),
        autoCapture,
      };
    case "arxiv":
      return {
        projectId,
        kind: "arxiv",
        identifier: candidate.arxiv_id,
        sourceType: selection.sourceType,
        ...(upload ? { upload } : { documentUrl, expectedExt }),
        autoCapture,
      };
    case "url": {
      const title = selection.title?.trim() || candidate.title;
      if (!title) {
        throw new PipelineError(
          `Kandidat "${candidate.candidate_id}" benötigt einen Titel zur Übernahme.`,
        );
      }
      return {
        projectId,
        kind: "url",
        identifier: candidate.url,
        sourceType: selection.sourceType,
        manual: manualMetadata(candidate, title),
        ...(upload ? { upload } : {}),
        autoCapture,
      };
    }
    case "unresolved": {
      // Completed by the user in the review (finding: real-world references):
      // an uploaded PDF, or a document URL the user provides. Either way the
      // candidate's own title/authors/year become the source metadata.
      const title = selection.title?.trim() || candidate.title;
      if (!title) {
        throw new PipelineError(
          `Kandidat "${candidate.candidate_id}" benötigt einen Titel zur Übernahme.`,
        );
      }
      // Provenance records how the SCAN classified the citation — "unresolved"
      // — not how its document was supplied, so a rescan recognizes it as
      // already captured (review keys on raw_text + method).
      const unresolvedProvenance = {
        raw_text: candidate.raw_text,
        method: "unresolved" as const,
      };
      if (upload) {
        return {
          projectId,
          kind: "upload",
          sourceType: selection.sourceType,
          manual: manualMetadata(candidate, title),
          upload,
          autoCapture: unresolvedProvenance,
        };
      }
      if (documentUrlOverride) {
        return {
          projectId,
          kind: "url",
          identifier: documentUrlOverride,
          sourceType: selection.sourceType,
          manual: manualMetadata(candidate, title),
          autoCapture: unresolvedProvenance,
        };
      }
      throw new PipelineError(
        `Kandidat "${candidate.candidate_id}" benötigt ein Dokument zur Übernahme: PDF hochladen oder Dokument-URL angeben.`,
      );
    }
  }
}

/** Manual CSL metadata carried over from a candidate onto a captured source
 * (url/upload/unresolved completions). */
function manualMetadata(
  candidate: ReferenceCandidate,
  title: string,
): {
  title: string;
  authors?: string;
  year?: string;
  container_title?: string;
} {
  return {
    title,
    ...(candidate.authors && candidate.authors.length > 0
      ? { authors: candidate.authors.join("; ") }
      : {}),
    ...(candidate.year !== undefined ? { year: String(candidate.year) } : {}),
    ...(candidate.venue ? { container_title: candidate.venue } : {}),
  };
}

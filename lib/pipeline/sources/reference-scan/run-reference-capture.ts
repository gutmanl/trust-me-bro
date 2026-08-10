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
  /** Required for `url`-method candidates with no title of their own;
   * overrides the candidate's own title otherwise. */
  title?: string;
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

  switch (candidate.method) {
    case "doi":
    case "crossref_title":
      // NOTE: neither channel supplies a document URL here. resolveDoi()
      // (sources/resolve.ts) deliberately returns bibliographic metadata
      // only — DOI landing pages are paywalled too often to guess a PDF
      // link from the DOI alone — so captureSource()'s acquireDocument()
      // step rejects these with InvalidSourceInputError unless the user
      // later revises the source with a document URL or upload. Deriving a
      // document URL automatically (arXiv-style PDF link, Crossref's own
      // PDF links, Unpaywall) is the immediate follow-up task; this branch
      // is expected to be revisited once that lands.
      return {
        projectId,
        kind: "doi",
        identifier: candidate.doi,
        sourceType: selection.sourceType,
        autoCapture,
      };
    case "arxiv":
      return {
        projectId,
        kind: "arxiv",
        identifier: candidate.arxiv_id,
        sourceType: selection.sourceType,
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
        manual: {
          title,
          ...(candidate.authors && candidate.authors.length > 0
            ? { authors: candidate.authors.join("; ") }
            : {}),
          ...(candidate.year !== undefined
            ? { year: String(candidate.year) }
            : {}),
          ...(candidate.venue ? { container_title: candidate.venue } : {}),
        },
        autoCapture,
      };
    }
    case "unresolved":
      throw new PipelineError(
        `Kandidat "${candidate.candidate_id}" konnte nicht aufgelöst werden und kann nicht automatisch übernommen werden.`,
      );
  }
}

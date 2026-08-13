import { PipelineError } from "../../errors";
import { requireProjectStore } from "../../projects";
import type { AutoChain } from "../../runs/auto-chain";
import { enqueueSourceCapture } from "../../runs/auto-chain";
import type { CaptureSourceInput } from "../capture";
import { extFromFilename } from "../document";
import type {
  SourceCaptureRequest,
  SourceCaptureWorkItem,
} from "../work-items/types";
import { buildCaptureInput } from "./capture-input";
import type { ReferenceCaptureSelection } from "./capture-input";
import { getReferenceCandidates } from "./read-candidates";
import type { ReviewCandidate } from "./review";

export interface CandidateCaptureDependencies {
  chain?: Pick<AutoChain, "enqueueSourceCapture">;
  getReferenceCandidates?: typeof getReferenceCandidates;
}

/**
 * Turns a resolved capture input into the buffer-free request the queue
 * carries (source work items): an upload is frozen into the blob store here,
 * at enqueue time — the same discipline as the manual capture path, and the
 * reason a failed candidate capture retries without a re-upload.
 *
 * The candidate is resolved NOW, not when the item runs. That trades the
 * retired batch run's run-time staleness re-check for a self-describing
 * queue entry; the window between enqueue and run is one project's chain
 * backlog, and the item was either a human's explicit selection or computed
 * from the scan that finished in the same drain step.
 */
function toSourceCaptureRequest(
  projectId: string,
  input: CaptureSourceInput,
): SourceCaptureRequest {
  const request: SourceCaptureRequest = {
    kind: input.kind,
    sourceType: input.sourceType,
  };
  if (input.identifier !== undefined) {
    request.identifier = input.identifier;
  }
  if (input.documentUrl !== undefined) {
    request.documentUrl = input.documentUrl;
  }
  if (input.expectedExt !== undefined) {
    request.expectedExt = input.expectedExt;
  }
  if (input.manual !== undefined) {
    request.manual = input.manual;
  }
  if (input.autoCapture !== undefined) {
    request.autoCapture = input.autoCapture;
  }
  if (input.upload !== undefined) {
    const blob = requireProjectStore(projectId)
      .blobs()
      .put(input.upload.content, extFromFilename(input.upload.filename));
    request.uploadBlob = {
      blob_path: blob.blobPath,
      filename: input.upload.filename,
    };
  }
  return request;
}

function toWorkItem(
  projectId: string,
  candidate: ReviewCandidate,
  selection: ReferenceCaptureSelection,
): SourceCaptureWorkItem {
  const input = buildCaptureInput(projectId, candidate, selection);
  return {
    // The scan's candidate id IS the work-item id: stable across rescans
    // (candidates key on raw_text + method), so a failure recorded under it
    // stays attached to the row a user sees.
    workItemId: candidate.candidate_id,
    origin: "reference_import",
    label: selection.title?.trim() || candidate.title || candidate.raw_text,
    request: toSourceCaptureRequest(projectId, input),
  };
}

/**
 * Queues one reference candidate as a capture work item (source work items)
 * — the per-row "Übernehmen" of the unified sources list, replacing the
 * retired reference-capture batch run. Validation mirrors the old batch
 * path: an incomplete completion (missing title or document) fails HERE,
 * synchronously in the row's form, not as a queued item's failure.
 */
export async function enqueueCandidateCapture(
  projectId: string,
  selection: ReferenceCaptureSelection,
  deps: CandidateCaptureDependencies = {},
): Promise<{ workItemId: string }> {
  const readCandidates = deps.getReferenceCandidates ?? getReferenceCandidates;
  const candidates = await readCandidates(projectId);
  const candidate = candidates.find(
    (entry) => entry.candidate_id === selection.candidateId,
  );
  if (!candidate) {
    throw new PipelineError(
      `Kandidat "${selection.candidateId}" ist im aktuellen Scan-Ergebnis nicht mehr vorhanden.`,
    );
  }
  if (candidate.alreadyCaptured) {
    throw new PipelineError(
      `Kandidat "${selection.candidateId}" ist bereits als Quelle erfasst.`,
    );
  }
  const item = toWorkItem(projectId, candidate, selection);
  (deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture)(projectId, item);
  return { workItemId: item.workItemId };
}

/**
 * Queues every open candidate the review form would submit unmodified —
 * the "alle offenen übernehmen" convenience. Exactly the pre-checked
 * (`selected`) candidates with their suggested defaults; everything that
 * needs a human completion stays behind, like the automatic path.
 */
export async function enqueueReadyCandidateCaptures(
  projectId: string,
  deps: CandidateCaptureDependencies = {},
): Promise<{ queued: number }> {
  const readCandidates = deps.getReferenceCandidates ?? getReferenceCandidates;
  const candidates = await readCandidates(projectId);
  const enqueue = deps.chain?.enqueueSourceCapture ?? enqueueSourceCapture;
  let queued = 0;
  for (const candidate of candidates) {
    if (!candidate.selected || candidate.alreadyCaptured) {
      continue;
    }
    const item = toWorkItem(projectId, candidate, {
      candidateId: candidate.candidate_id,
      sourceType: candidate.suggested_source_type,
    });
    enqueue(projectId, item);
    queued += 1;
  }
  return { queued };
}

/**
 * The automatic post-scan captures, as work items for the auto-chain to
 * unshift right behind the scan that produced them (source work items —
 * replaces the retired one-shot auto-capture run). Same policy, spelled
 * out in `selectAutoCaptures`' terms: exactly the candidates the review
 * form pre-checks, submitted with their untouched defaults.
 */
export async function buildAutoCaptureItems(
  projectId: string,
  deps: Pick<CandidateCaptureDependencies, "getReferenceCandidates"> = {},
): Promise<SourceCaptureWorkItem[]> {
  const readCandidates = deps.getReferenceCandidates ?? getReferenceCandidates;
  const candidates = await readCandidates(projectId);
  return candidates
    .filter((candidate) => candidate.selected && !candidate.alreadyCaptured)
    .map((candidate) =>
      toWorkItem(projectId, candidate, {
        candidateId: candidate.candidate_id,
        sourceType: candidate.suggested_source_type,
      }),
    );
}

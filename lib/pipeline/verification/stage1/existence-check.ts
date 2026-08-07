import type {
  BlobStore,
  Claim,
  ExistenceCheckStatus,
  Source,
} from "../../../register";
import { containsNormalized } from "../../text/normalize";
import type { HttpFetcher } from "../../sources/fetch-port";
import type { SourceCheckCache } from "./source-check";
import { checkSourceCached } from "./source-check";

/**
 * Stage 1 per claim (TMB-27), deterministic and LLM-free: the live source
 * check (identifier resolution, URL against snapshot) combined with the
 * purely local Wortlaut-Nachweis — the frozen text blob must contain the
 * verbatim excerpt under the shared normal form (whitespace/hyphenation
 * tolerated, content deviations not). Sources whose text extraction failed
 * can prove no wording and fail visibly. Network errors from the live check
 * propagate as run errors; nothing is returned partially.
 */

export interface EvidenceExistenceResult {
  evidenceId: string;
  status: ExistenceCheckStatus;
  detail: string;
}

export async function checkClaimExistence(
  claim: Claim,
  sourcesById: ReadonlyMap<string, Source>,
  deps: { blobs: BlobStore; fetcher: HttpFetcher; cache: SourceCheckCache },
): Promise<EvidenceExistenceResult[]> {
  const results: EvidenceExistenceResult[] = [];
  for (const evidence of claim.evidence) {
    const source = sourcesById.get(evidence.source_id);
    if (!source) {
      // Referential integrity makes this unreachable; fail visibly anyway.
      results.push({
        evidenceId: evidence.id,
        status: "nicht_bestanden",
        detail: `Quelle ${evidence.source_id} nicht im Register.`,
      });
      continue;
    }
    const live = await checkSourceCached(source, deps.fetcher, deps.cache);
    if (!live.ok) {
      results.push({
        evidenceId: evidence.id,
        status: "nicht_bestanden",
        detail: live.detail,
      });
      continue;
    }
    results.push(
      verbatimProof(evidence.id, evidence.verbatim_excerpt, source, deps.blobs),
    );
  }
  return results;
}

function verbatimProof(
  evidenceId: string,
  excerpt: string,
  source: Source,
  blobs: BlobStore,
): EvidenceExistenceResult {
  const snapshot = source.custom.snapshot;
  if (!snapshot) {
    return {
      evidenceId,
      status: "nicht_bestanden",
      detail: `Quelle ${source.id} hat keinen eingefrorenen Schnappschuss.`,
    };
  }
  if (!snapshot.text_blob_path) {
    return {
      evidenceId,
      status: "nicht_bestanden",
      detail:
        `Kein Text-Blob für Quelle ${source.id} ` +
        `(Extraktion gescheitert: ${snapshot.text_extraction_error ?? "unbekannt"}) – ` +
        "Wortlaut nicht nachweisbar.",
    };
  }
  const text = blobs.readText(snapshot.text_blob_path);
  if (!containsNormalized(text, excerpt)) {
    return {
      evidenceId,
      status: "nicht_bestanden",
      detail: `Wortlaut nicht im eingefrorenen Text von ${source.id} gefunden.`,
    };
  }
  return {
    evidenceId,
    status: "bestanden",
    detail: `Wortlaut in ${source.id} nachgewiesen.`,
  };
}

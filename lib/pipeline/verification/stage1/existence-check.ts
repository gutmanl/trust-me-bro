import type {
  BlobStore,
  Claim,
  ExistenceCheckMatch,
  ExistenceCheckStatus,
  Source,
} from "../../../register";
import { containsNormalized, findInterrupted } from "../../../register";
import type { HttpFetcher } from "../../sources/fetch-port";
import type { SourceCheckCache } from "./source-check";
import { checkSourceCached } from "./source-check";

/**
 * Stage 1 per claim (TMB-27), deterministic and LLM-free: the live source
 * check (identifier resolution, URL against snapshot) combined with the
 * purely local verbatim-wording proof — the frozen text blob must contain the
 * verbatim excerpt under the shared normal form (whitespace/hyphenation
 * tolerated, content deviations not). Sources whose text extraction failed
 * can prove no wording and fail visibly. Network errors from the live check
 * propagate as run errors; nothing is returned partially.
 */

export interface EvidenceExistenceResult {
  evidenceId: string;
  status: ExistenceCheckStatus;
  /** How the wording was established — recorded on every outcome, so a
   * verdict from before this distinction existed is recognizable by its
   * absence. */
  match: ExistenceCheckMatch;
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
        status: "failed",
        match: "none",
        detail: `Quelle ${evidence.source_id} nicht im Register.`,
      });
      continue;
    }
    const live = await checkSourceCached(source, deps.fetcher, deps.cache);
    if (!live.ok) {
      results.push({
        evidenceId: evidence.id,
        status: "failed",
        match: "none",
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
      status: "failed",
      match: "none",
      detail: `Quelle ${source.id} hat keinen eingefrorenen Schnappschuss.`,
    };
  }
  if (!snapshot.text_blob_path) {
    return {
      evidenceId,
      status: "failed",
      match: "none",
      detail:
        `Kein Text-Blob für Quelle ${source.id} ` +
        `(Extraktion gescheitert: ${snapshot.text_extraction_error ?? "unbekannt"}) – ` +
        "Wortlaut nicht nachweisbar.",
    };
  }
  const text = blobs.readText(snapshot.text_blob_path);
  if (containsNormalized(text, excerpt)) {
    return {
      evidenceId,
      status: "passed",
      match: "exact",
      detail: `Wortlaut in ${source.id} nachgewiesen.`,
    };
  }
  // Second line: the extraction of a two-column PDF is not always in
  // reading order, so a quotation genuinely present in the paper can arrive
  // split around a copyright block, figure caption or running head. Every
  // character must still be found verbatim; only contiguity is relaxed.
  const interrupted = findInterrupted(text, excerpt);
  if (interrupted) {
    return {
      evidenceId,
      status: "passed",
      match: "interrupted",
      detail:
        `Wortlaut in ${source.id} nachgewiesen – vollständig und in ` +
        `Reihenfolge, aber im extrahierten Text durch ` +
        `${interrupted.skipped} Zeichen Fremdtext unterbrochen ` +
        `(${interrupted.interruptions}×, typisch: Rechtekasten, ` +
        `Abbildungsunterschrift oder Kolumnentitel).`,
    };
  }
  return {
    evidenceId,
    status: "failed",
    match: "none",
    detail: `Wortlaut nicht im eingefrorenen Text von ${source.id} gefunden.`,
  };
}

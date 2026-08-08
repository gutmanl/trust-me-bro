import type { ClaimsRegister } from "@/lib/pipeline";
import {
  formatCitation,
  formatLocator,
  resolveEvidenceRelation,
} from "@/lib/pipeline";

/**
 * Server-side precomputation for the evidence detail panel (TMB-34): the
 * client components stay presentational, so everything that needs the
 * pipeline barrel (citation formatting, locator rule, divergence predicate,
 * snapshot links) is resolved here and travels as plain serializable data.
 */

export interface EvidenceDisplay {
  citation: string;
  sourceType: string;
  sourceId: string;
  locatorText: string;
  /** Link into the frozen snapshot (PDF: #page anchor, HTML: best-effort
   * text fragment on the excerpt); null when no snapshot exists. */
  snapshotHref: string | null;
  /** Divergence of the latest judgments per backend (relation unresolved). */
  divergent: boolean;
}

/** Key: `${claimId}/${evidenceId}` — same convention as the briefing view
 * model's evidence numbering. */
export function buildEvidenceDisplayMap(
  projectId: string,
  register: ClaimsRegister,
): Record<string, EvidenceDisplay> {
  const sourcesById = new Map(
    register.sources.map((source) => [source.id, source]),
  );
  const display: Record<string, EvidenceDisplay> = {};
  for (const claim of register.claims) {
    for (const evidence of claim.evidence) {
      const source = sourcesById.get(evidence.source_id);
      const snapshot = source?.custom.snapshot;
      let snapshotHref: string | null = null;
      if (snapshot) {
        const base = `/api/projects/${projectId}/blobs/${snapshot.blob_path}`;
        const page = (evidence.locator as { page?: number }).page;
        if (snapshot.blob_path.endsWith(".pdf") && typeof page === "number") {
          snapshotHref = `${base}#page=${page}`;
        } else if (/\.html?$/.test(snapshot.blob_path)) {
          // Text fragment on the excerpt's first words — best effort, the
          // browser falls back to the top of the document.
          const fragment = encodeURIComponent(
            evidence.verbatim_excerpt.slice(0, 80),
          );
          snapshotHref = `${base}#:~:text=${fragment}`;
        } else {
          snapshotHref = base;
        }
      }
      display[`${claim.id}/${evidence.id}`] = {
        citation: source ? formatCitation(source) : evidence.source_id,
        sourceType: source?.custom.source_type ?? "grauliteratur",
        sourceId: evidence.source_id,
        locatorText: formatLocator(evidence.locator as Record<string, unknown>),
        snapshotHref,
        divergent:
          evidence.judgments.length > 0 &&
          evidence.relation_type === undefined &&
          resolveEvidenceRelation(evidence.judgments) === null,
      };
    }
  }
  return display;
}

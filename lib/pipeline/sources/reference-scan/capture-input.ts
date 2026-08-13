import type { SourceType } from "../../../register";
import { PipelineError } from "../../errors";
import type { CaptureSourceInput } from "../capture";
import type { ReferenceCandidate } from "./schema";

/**
 * How a reference candidate becomes a capture input (reference auto-import,
 * source work items): the selection carries what the user completed in the
 * candidate row — or nothing but the suggested source type, for the
 * automatic path. Extracted from the retired batch run so the per-item
 * queue and the automatic post-scan captures share one definition.
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

export function buildCaptureInput(
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

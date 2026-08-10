import type { ReferenceCaptureSelection } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";

const SOURCE_TYPES: SourceType[] = [
  "peer_reviewed_publication",
  "preprint",
  "grey_literature",
  "vendor_documentation",
];

function optional(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Parses the reference-capture review form (ReferenceCandidateReview.tsx)
 * into the pipeline's selection list. The form is uncontrolled: one checkbox
 * per selectable candidate row (`select_<candidateId>`), each with its own
 * source-type select, optional title and optional document-url input, all
 * suffixed by the same candidate id. Extracted from the server action so the
 * non-trivial FormData → domain-shape mapping stays independently
 * unit-testable (house convention, see routing-labels.ts).
 */
export function parseCaptureSelections(
  formData: FormData,
): ReferenceCaptureSelection[] {
  const candidateIds: string[] = [];
  for (const key of formData.keys()) {
    if (key.startsWith("select_") && !candidateIds.includes(key.slice(7))) {
      candidateIds.push(key.slice(7));
    }
  }

  const selections: ReferenceCaptureSelection[] = [];
  for (const candidateId of candidateIds) {
    const sourceType = String(formData.get(`source_type_${candidateId}`) ?? "");
    if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
      continue;
    }
    const title = optional(formData.get(`title_${candidateId}`));
    const documentUrl = optional(formData.get(`document_url_${candidateId}`));
    selections.push({
      candidateId,
      sourceType: sourceType as SourceType,
      ...(title !== undefined ? { title } : {}),
      ...(documentUrl !== undefined ? { documentUrl } : {}),
    });
  }
  return selections;
}

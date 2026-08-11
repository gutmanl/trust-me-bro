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
 * per candidate row (`select_<candidateId>`), each with its own source-type
 * select, optional title, optional document-url and optional uploaded PDF
 * (`file_<id>`), all suffixed by the same candidate id. Async because reading
 * an uploaded file's bytes is. Extracted from the server action so the
 * non-trivial FormData → domain-shape mapping stays independently
 * unit-testable (house convention, see routing-labels.ts).
 */
export async function parseCaptureSelections(
  formData: FormData,
): Promise<ReferenceCaptureSelection[]> {
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
    const upload = await readUpload(formData.get(`file_${candidateId}`));
    selections.push({
      candidateId,
      sourceType: sourceType as SourceType,
      ...(title !== undefined ? { title } : {}),
      ...(documentUrl !== undefined ? { documentUrl } : {}),
      ...(upload !== undefined ? { upload } : {}),
    });
  }
  return selections;
}

async function readUpload(
  entry: FormDataEntryValue | null,
): Promise<{ content: Buffer; filename: string } | undefined> {
  if (!(entry instanceof File) || entry.size === 0) {
    return undefined;
  }
  return {
    content: Buffer.from(await entry.arrayBuffer()),
    filename: entry.name,
  };
}

"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { captureSource, reviseSource } from "@/lib/pipeline";
import type { CaptureKind, CaptureSourceInput } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";

export interface SourceFormState {
  error: string | null;
  captured?: string;
}

const SOURCE_TYPES: SourceType[] = [
  "peer_reviewed_publication",
  "preprint",
  "grey_literature",
  "vendor_documentation",
];

const CAPTURE_KINDS: CaptureKind[] = ["doi", "arxiv", "url", "upload"];

function optional(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : undefined;
}

export async function captureSourceAction(
  projectId: string,
  _previous: SourceFormState,
  formData: FormData,
): Promise<SourceFormState> {
  const kind = String(formData.get("kind") ?? "");
  const sourceType = String(formData.get("source_type") ?? "");
  if (!CAPTURE_KINDS.includes(kind as CaptureKind)) {
    return { error: "Unbekannte Erfassungsart." };
  }
  if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
    return { error: "Bitte einen Quellentyp wählen." };
  }

  const input: CaptureSourceInput = {
    projectId,
    kind: kind as CaptureKind,
    sourceType: sourceType as SourceType,
    identifier: optional(formData.get("identifier")),
    documentUrl: optional(formData.get("document_url")),
  };

  const title = optional(formData.get("title"));
  if (title) {
    input.manual = {
      title,
      authors: optional(formData.get("authors")),
      year: optional(formData.get("year")),
      container_title: optional(formData.get("container_title")),
    };
  }

  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    input.upload = {
      content: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    };
  }

  const result = await runPipelineAction(() => captureSource(input));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/sources`);
  return { error: null, captured: result.value.id };
}

export interface ReviseFormState {
  error: string | null;
  /** Set after a successful submit: whether a new revision was created. */
  revised?: boolean;
  newRevision?: number;
  recheckedCount?: number;
}

export async function reviseSourceAction(
  projectId: string,
  sourceId: string,
  _previous: ReviseFormState,
  formData: FormData,
): Promise<ReviseFormState> {
  const input = {
    projectId,
    sourceId,
    documentUrl: optional(formData.get("document_url")),
    upload: undefined as { content: Buffer; filename: string } | undefined,
  };
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    input.upload = {
      content: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    };
  }
  const result = await runPipelineAction(() => reviseSource(input));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/sources`);
  return {
    error: null,
    revised: result.value.revised,
    newRevision: result.value.newRevision,
    recheckedCount: result.value.recheckedClaimIds.length,
  };
}

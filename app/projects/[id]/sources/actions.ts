"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { captureSource, freezeSourceSet } from "@/lib/pipeline";
import type { CaptureKind, CaptureSourceInput } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";

export interface SourceFormState {
  error: string | null;
  captured?: string;
}

const SOURCE_TYPES: SourceType[] = [
  "begutachtete_publikation",
  "preprint",
  "grauliteratur",
  "herstellerdokumentation",
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

export async function freezeSourceSetAction(
  projectId: string,
  _previous: SourceFormState,
  _formData: FormData,
): Promise<SourceFormState> {
  const result = await runPipelineAction(() => freezeSourceSet(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidatePath(`/projects/${projectId}/sources`);
  return { error: null };
}

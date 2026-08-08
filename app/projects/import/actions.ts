"use server";

import { redirect } from "next/navigation";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import { importProjectBundle } from "@/lib/pipeline";

export interface ImportBundleFormState {
  error: string | null;
}

export async function importBundleAction(
  _previous: ImportBundleFormState,
  formData: FormData,
): Promise<ImportBundleFormState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Bitte eine .tmb-Datei auswählen." };
  }
  const targetDirectoryName = String(formData.get("directory_name") ?? "");

  const result = await runPipelineAction(async () =>
    importProjectBundle({
      bytes: Buffer.from(await file.arrayBuffer()),
      targetDirectoryName,
    }),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  redirect(`/projects/${result.value.directoryName}`);
}

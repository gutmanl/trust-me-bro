import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { JobKind } from "../core/jobs";

export interface LoadedTemplate {
  readonly text: string;
  /** SHA-256 of the template file, recorded in every trace envelope. */
  readonly sha256: string;
}

/**
 * Reads a versioned prompt template from the repository. Templates are plain
 * files (never edited in place — a new version is a new file), so the content
 * hash is meaningful independent of code changes.
 */
export function loadPromptTemplate(
  kind: JobKind,
  version: string,
): LoadedTemplate {
  const templatePath = fileURLToPath(
    new URL(`./${kind}/v${version}.md`, import.meta.url),
  );
  let text: string;
  try {
    text = fs.readFileSync(templatePath, "utf8");
  } catch (cause) {
    throw new Error(
      `no prompt template for job "${kind}" version "${version}" at ${templatePath}`,
      { cause },
    );
  }
  return {
    text,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

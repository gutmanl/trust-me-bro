import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JobKind } from "../core/jobs";

export interface LoadedTemplate {
  readonly text: string;
  /** SHA-256 of the template file, recorded in every trace envelope. */
  readonly sha256: string;
}

/**
 * Reads a versioned prompt template. Templates are plain files (never edited
 * in place — a new version is a new file), so the content hash is meaningful
 * independent of code changes.
 *
 * Resolution is anchored at the process working directory, NOT at
 * import.meta.url (TMB-48): Next's production build bundles this module into
 * a server chunk whose import.meta.url no longer points anywhere near the
 * template files. Dev server, tests and the packaged launcher all run with a
 * cwd that contains lib/ — the packaging step copies the templates into the
 * standalone directory and the launcher sets cwd there.
 */
export function loadPromptTemplate(
  kind: JobKind,
  version: string,
): LoadedTemplate {
  const templatePath = path.join(
    process.cwd(),
    "lib",
    "adapters",
    "prompts",
    kind,
    `v${version}.md`,
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

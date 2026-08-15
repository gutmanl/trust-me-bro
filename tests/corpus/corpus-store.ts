/**
 * Reads the on-disk corpus. Deliberately eager and synchronous: the corpus
 * is small, and a test that fails because a cassette is missing should say
 * so while it is still obvious which spec asked for it.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  CorpusDocument,
  DocumentManifest,
  HttpCassette,
  LlmCassette,
} from "./cassette";

/**
 * Locates `tests/corpus/` by walking up from the working directory.
 *
 * Deliberately not `import.meta.url`: this module is loaded by vitest (ESM)
 * AND by Playwright's config/global-setup, which Playwright transpiles to
 * CommonJS — where `import.meta` is a syntax error, not a runtime one, so
 * the whole file fails to parse. Walking up also survives being invoked from
 * a subdirectory, which `process.cwd()` alone would not.
 */
function findCorpusRoot(): string {
  let directory = process.cwd();
  for (;;) {
    const candidate = path.join(directory, "tests", "corpus");
    if (fs.existsSync(path.join(candidate, "cassette.ts"))) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        "tests/corpus not found above the working directory — run from " +
          "inside the repository.",
      );
    }
    directory = parent;
  }
}

export const corpusRoot = findCorpusRoot();

export const httpDir = path.join(corpusRoot, "http");
export const llmDir = path.join(corpusRoot, "llm");
export const documentsDir = path.join(corpusRoot, "documents");
export const identifiersDir = path.join(corpusRoot, "identifiers");
export const documentManifestPath = path.join(corpusRoot, "documents.json");

function readJsonFiles<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

export function loadHttpCassettes(): HttpCassette[] {
  return readJsonFiles<HttpCassette>(httpDir);
}

export function loadLlmCassettes(): LlmCassette[] {
  return readJsonFiles<LlmCassette>(llmDir);
}

export function loadDocumentManifest(): DocumentManifest {
  if (!fs.existsSync(documentManifestPath)) {
    return { documents: [] };
  }
  return JSON.parse(fs.readFileSync(documentManifestPath, "utf8"));
}

/**
 * Bytes of a corpus document: the real one when it has been fetched, else
 * the committed seed stand-in, else null. Null rather than throwing — a
 * document-backed cassette should fail with the fetcher's own "run npm run
 * corpus:fetch" message, not with an ENOENT from three frames deeper.
 */
export function readDocument(document: CorpusDocument): Buffer | null {
  for (const relative of [document.file, document.seedFile]) {
    if (relative === undefined) {
      continue;
    }
    const file = path.join(corpusRoot, relative);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file);
    }
  }
  return null;
}

/** True when the real document is present, not just its seed stand-in. */
export function hasRealDocument(document: CorpusDocument): boolean {
  return fs.existsSync(path.join(corpusRoot, document.file));
}

/** The real identifier lists carried over from the thesis repository. */
export function readIdentifierFile(name: string): string {
  return fs.readFileSync(path.join(identifiersDir, name), "utf8");
}

export function listIdentifierFiles(pattern: RegExp): string[] {
  return fs
    .readdirSync(identifiersDir)
    .filter((name) => pattern.test(name))
    .sort();
}

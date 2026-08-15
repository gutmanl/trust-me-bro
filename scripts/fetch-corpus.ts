/**
 * Downloads the corpus documents that are hash-pinned but not committed.
 *
 *   npm run corpus:fetch
 *
 * Large binaries stay out of git — the same discipline the thesis applies to
 * its own frozen corpus, where `korpus-manifest.csv` is committed and
 * `korpus/` is not. `documents.json` carries the URL and the expected
 * SHA-256; this script fetches and verifies.
 *
 * How hard a mismatch fails depends on where the expectation came from, and
 * that distinction is recorded per entry:
 *
 *   sha256_source: "recorded"       observed by the recorder against this
 *                                   exact URL. A mismatch means the document
 *                                   at the far end changed — a real finding,
 *                                   and a hard failure.
 *   sha256_source: "thesis-corpus"  copied from `korpus-manifest.csv`, which
 *                                   describes a locally archived copy. arXiv
 *                                   re-stamps PDFs, so a mismatch here is
 *                                   plausible and reported as a warning with
 *                                   both hashes rather than a failure.
 *
 * Without this script the specs still run: `readDocument` falls back to the
 * committed seed stand-in, and `corpus-integrity.test.ts` reports which
 * documents are real.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nodeHttpFetcher } from "../lib/pipeline/sources/node-http-fetcher";
import type { CorpusDocument } from "../tests/corpus/cassette";

const corpusRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "corpus",
);

async function fetchOne(
  document: CorpusDocument,
): Promise<"ok" | "warned" | "failed"> {
  const target = path.join(corpusRoot, document.file);
  process.stdout.write(`  ${document.name} … `);

  let body: Buffer;
  try {
    const resource = await nodeHttpFetcher.fetch(document.url);
    if (resource.status !== 200 || resource.body.length === 0) {
      console.log(`HTTP ${resource.status}, skipped`);
      return "failed";
    }
    body = resource.body;
  } catch (error) {
    console.log(`unreachable (${(error as Error).message})`);
    return "failed";
  }

  const actual = createHash("sha256").update(body).digest("hex");
  if (document.sha256 && actual !== document.sha256) {
    if (document.sha256_source === "recorded") {
      console.log("HASH MISMATCH");
      console.log(`      expected ${document.sha256}`);
      console.log(`      actual   ${actual}`);
      console.log(
        "      The document at this URL changed since it was recorded. " +
          "Re-record deliberately (npm run corpus:record -- --http) rather " +
          "than overwriting the pin.",
      );
      return "failed";
    }
    console.log("hash differs from the thesis corpus manifest (expected)");
    console.log(`      manifest ${document.sha256}`);
    console.log(`      fetched  ${actual}`);
  } else {
    console.log(`ok (${body.length} bytes)`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return document.sha256 && actual !== document.sha256 ? "warned" : "ok";
}

async function main(): Promise<void> {
  const manifestPath = path.join(corpusRoot, "documents.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("No documents.json — run npx tsx scripts/seed-corpus.ts.");
    process.exitCode = 1;
    return;
  }
  const { documents }: { documents: CorpusDocument[] } = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  );
  if (documents.length === 0) {
    console.log("documents.json lists nothing to fetch.");
    return;
  }

  console.log(`Fetching ${documents.length} corpus document(s):`);
  const results = await Promise.all(documents.map(fetchOne));
  const failed = results.filter((result) => result === "failed").length;

  console.log(
    `\n${results.length - failed}/${results.length} available` +
      (failed > 0
        ? `; ${failed} could not be fetched — those specs fall back to the ` +
          "committed seed stand-in."
        : "."),
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { BundleFormatError } from "./errors";
import { assertSafeRelativePath } from "./safe-path";

/**
 * The one file that may import fflate (architecture-guarded, same pattern
 * as the network/child-process confinement): in-memory ZIP pack/unpack over
 * a flat path→bytes map. Bundle sizes stay process-memory-bounded — a known,
 * accepted prototype limit (no streaming).
 */

export type BundleFiles = Record<string, Uint8Array>;

/** Packs files into ZIP bytes. Entries are sorted by path and stamped with
 * the one given mtime, so identical content yields identical bytes. */
export function zipBundle(files: BundleFiles, mtime: string): Uint8Array {
  const sorted: BundleFiles = {};
  for (const path of Object.keys(files).sort()) {
    sorted[path] = files[path];
  }
  return zipSync(sorted, { mtime: new Date(mtime) });
}

/**
 * Archive limits (S-06). An imported bundle is untrusted input: it arrives
 * from wherever the user got it, and unpacking happens in memory. Without
 * bounds, a small file can expand into an arbitrarily large one (a "zip
 * bomb") and take the process down before any of the bundle's own
 * verification runs.
 *
 * Sized against what a real bundle looks like — a project directory with
 * frozen PDFs — so a legitimate import is never refused.
 */
export const MAX_BUNDLE_ENTRIES = 10_000;
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/**
 * Per-entry ratio ceiling, chosen for separation rather than tightness.
 * Real bundle content sits far below it: already-compressed PDFs are about
 * 1:1, extracted full text and claims.json reach roughly 5-20x. Deflate's
 * structural maximum is about 1032:1, which is what an all-zeros bomb
 * approaches. 200 leaves an order of magnitude of headroom on both sides,
 * so neither a legitimate entry nor a bomb lands near the boundary.
 *
 * Only applied above a floor, because a tiny entry can hit a huge ratio
 * entirely innocently.
 */
export const MAX_COMPRESSION_RATIO = 200;
const RATIO_CHECK_FLOOR_BYTES = 64 * 1024;

/**
 * Unpacks ZIP bytes; rejects non-ZIP input, unsafe entry paths (zip-slip)
 * and archives that breach the limits above — before anything else looks at
 * the contents.
 *
 * The limits are enforced through fflate's entry filter, which runs per
 * entry BEFORE that entry is decompressed and reports both its compressed
 * and its declared original size. Checking after the fact would be no
 * protection: by then the expansion has already happened.
 */
export function unzipBundle(bytes: Uint8Array): BundleFiles {
  let entries: BundleFiles;
  let entryCount = 0;
  let totalBytes = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        entryCount += 1;
        if (entryCount > MAX_BUNDLE_ENTRIES) {
          throw new BundleFormatError(
            `bundle has more than ${MAX_BUNDLE_ENTRIES} entries`,
          );
        }
        if (file.originalSize > MAX_ENTRY_BYTES) {
          throw new BundleFormatError(
            `bundle entry "${file.name}" exceeds the per-entry size limit`,
          );
        }
        totalBytes += file.originalSize;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new BundleFormatError(
            "bundle exceeds the total uncompressed size limit",
          );
        }
        if (
          file.originalSize > RATIO_CHECK_FLOOR_BYTES &&
          file.size > 0 &&
          file.originalSize / file.size > MAX_COMPRESSION_RATIO
        ) {
          throw new BundleFormatError(
            `bundle entry "${file.name}" has an implausible compression ratio`,
          );
        }
        // The checks above all read the DECLARED uncompressed size from the
        // central directory. A hostile archive can declare a tiny original
        // size — slipping under the ratio floor — while shipping a large
        // compressed payload whose decode still burns CPU proportional to
        // the compressed stream, blocking the single-threaded server. A
        // compressed size larger than the declared original (beyond
        // deflate's negligible stored-block overhead) is implausible for any
        // real entry and is the signature of exactly that smuggle, so it is
        // bounded here, before decompression.
        if (
          file.size >
          file.originalSize + Math.ceil(file.originalSize / 100) + 1024
        ) {
          throw new BundleFormatError(
            `bundle entry "${file.name}" stores more than it declares`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof BundleFormatError) {
      throw error;
    }
    throw new BundleFormatError(
      `not a readable .tmb bundle (ZIP): ${String(error)}`,
      { cause: error },
    );
  }
  const files: BundleFiles = {};
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith("/")) {
      continue; // directory marker entries carry no content
    }
    assertSafeRelativePath(path);
    files[path] = content;
  }
  return files;
}

/** UTF-8 helpers so bundle consumers never touch fflate directly. */
export const bundleText = {
  encode: (text: string): Uint8Array => strToU8(text),
  decode: (bytes: Uint8Array): string => strFromU8(bytes),
};

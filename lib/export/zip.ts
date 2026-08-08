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

/** Unpacks ZIP bytes; rejects non-ZIP input and unsafe entry paths
 * (zip-slip) before anything else looks at the contents. */
export function unzipBundle(bytes: Uint8Array): BundleFiles {
  let entries: BundleFiles;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
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

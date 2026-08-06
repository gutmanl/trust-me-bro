import fs from "node:fs";

import { sha256Hex } from "../chain/hash";
import { writeFileAtomic } from "../persistence/atomic-write";
import { blobRelativePath, resolveBlobPath, sha256FromBlobPath } from "./paths";

export interface BlobRef {
  sha256: string;
  relative_path: string;
}

/**
 * Content-addressed blob store of one project directory (file format
 * appendix): file name = SHA-256 of the content, path
 * blobs/<prefix>/<sha256>.<ext>. Deduplication and the trivially checkable
 * binding of every verification to the frozen wording follow from the
 * addressing; revisions of a source coexist instead of overwriting each
 * other.
 */
export interface BlobStore {
  /** Stores content and returns checksum + relative path; a no-op when the
   * identical content already exists (dedup by construction). */
  put(content: Buffer | string, ext: string): BlobRef;
  /** Absolute filesystem path for a relative blob path (traversal-guarded). */
  resolve(relativePath: string): string;
  exists(relativePath: string): boolean;
  read(relativePath: string): Buffer;
  readText(relativePath: string): string;
  /** Recomputes the content hash and compares it with the checksum the path
   * addresses — detects tampered blob files. */
  verifyIntegrity(relativePath: string): boolean;
}

export function createBlobStore(projectDir: string): BlobStore {
  const resolve = (relativePath: string) =>
    resolveBlobPath(projectDir, relativePath);

  return {
    put(content, ext) {
      const buffer =
        typeof content === "string" ? Buffer.from(content, "utf8") : content;
      const sha256 = sha256Hex(buffer);
      const relative_path = blobRelativePath(sha256, ext);
      const absolute = resolve(relative_path);
      if (!fs.existsSync(absolute)) {
        writeFileAtomic(absolute, buffer);
      }
      return { sha256, relative_path };
    },
    resolve,
    exists(relativePath) {
      return fs.existsSync(resolve(relativePath));
    },
    read(relativePath) {
      return fs.readFileSync(resolve(relativePath));
    },
    readText(relativePath) {
      return fs.readFileSync(resolve(relativePath), "utf8");
    },
    verifyIntegrity(relativePath) {
      const absolute = resolve(relativePath);
      if (!fs.existsSync(absolute)) {
        return false;
      }
      return (
        sha256Hex(fs.readFileSync(absolute)) ===
        sha256FromBlobPath(relativePath)
      );
    },
  };
}

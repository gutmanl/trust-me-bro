import path from "node:path";

/** File extension of a blob: lowercase alphanumeric, as in the path schema. */
const EXT_PATTERN = /^[a-z0-9]+$/;

/** Shape of a relative blob path per the file format appendix. */
const BLOB_PATH_PATTERN = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/;

/** Relative blob path for a checksum: blobs/<first two chars>/<sha256>.<ext>. */
export function blobRelativePath(sha256: string, ext: string): string {
  if (!EXT_PATTERN.test(ext)) {
    throw new Error(
      `blob extension "${ext}" is invalid: expected lowercase alphanumerics`,
    );
  }
  return `blobs/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

/**
 * Resolves a relative blob path from claims.json to an absolute path below
 * the project directory. Only exact blob-path shapes are accepted — traversal
 * is ruled out by the pattern, not by sanitizing.
 */
export function resolveBlobPath(
  projectDir: string,
  relativePath: string,
): string {
  if (!BLOB_PATH_PATTERN.test(relativePath)) {
    throw new Error(
      `"${relativePath}" is not a valid blob path (blobs/<prefix>/<sha256>.<ext>)`,
    );
  }
  return path.join(projectDir, relativePath);
}

/** Extracts the checksum a blob path claims to address. */
export function sha256FromBlobPath(relativePath: string): string {
  const match = BLOB_PATH_PATTERN.exec(relativePath);
  if (!match) {
    throw new Error(`"${relativePath}" is not a valid blob path`);
  }
  return relativePath.slice("blobs/xx/".length, "blobs/xx/".length + 64);
}

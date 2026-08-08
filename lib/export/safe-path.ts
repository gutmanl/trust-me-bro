import { BundleFormatError } from "./errors";

/**
 * Zip-slip guard for untrusted bundle uploads: every entry name must be a
 * plain, forward-slash-relative path — no absolute paths, no drive letters,
 * no `.`/`..` segments, no backslashes, no empty segments. Rejection is
 * structural (the path never reaches the filesystem), mirroring how blob
 * paths are validated by shape instead of sanitized.
 */
export function assertSafeRelativePath(entryPath: string): void {
  const segments = entryPath.split("/");
  const unsafe =
    entryPath.length === 0 ||
    entryPath.includes("\\") ||
    entryPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(entryPath) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    );
  if (unsafe) {
    throw new BundleFormatError(
      `bundle entry has an unsafe path: "${entryPath}"`,
    );
  }
}

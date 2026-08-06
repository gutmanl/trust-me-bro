import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Atomic file write: write to a temp file in the SAME directory (same volume
 * — a cross-volume rename would silently degrade to copy+delete), fsync, then
 * rename over the target. An interrupted write leaves at worst an orphaned
 * temp file, never a torn target. rename replaces existing files atomically
 * on NTFS as on POSIX.
 */
export function writeFileAtomic(
  targetPath: string,
  data: string | Buffer,
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

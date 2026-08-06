import { createHash } from "node:crypto";

/** Lowercase hex SHA-256, the only digest the file format uses. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

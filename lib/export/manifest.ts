import { z } from "zod";

import { IsoDateTime, Sha256Hex, sha256Hex } from "../register";
import type { ChainLink } from "../register";
import type { BundleFiles } from "./zip";

/**
 * manifest.json of a .tmb bundle: export timestamp, schema version and the
 * SHA-256 checksums of every contained file. The checksums are the format's
 * external commitment to the register state at export time — the documented
 * countermeasure to the tail truncation that chain verification alone cannot
 * detect (lib/register/chain/verify.ts); chain_head states the committed tip
 * explicitly and legibly. The manifest cannot list itself (it cannot contain
 * its own checksum), a documented limitation.
 */

export const MANIFEST_VERSION = "1.0.0";
export const MANIFEST_PATH = "manifest.json";

export const ManifestFileEntry = z.strictObject({
  path: z.string().min(1),
  sha256: Sha256Hex,
  /** Present exactly for files contained in the bundle; a lean ("ohne
   * Blobs") export lists excluded blobs with included: false — the checksum
   * reference the file format appendix requires. */
  included: z.boolean(),
  bytes: z.int().min(0).optional(),
});
export type ManifestFileEntry = z.infer<typeof ManifestFileEntry>;

export const Manifest = z.strictObject({
  manifest_version: z.literal(MANIFEST_VERSION),
  schema_version: z.string().min(1),
  project: z.strictObject({
    /** Chain-bound id inside claims.json (immutable). */
    inner_id: z.string().min(1),
    /** Workspace directory name at export time (routing identity). */
    directory_name: z.string().min(1),
  }),
  exported_at: IsoDateTime,
  chain_head: z.strictObject({
    seq: z.int().min(1),
    hash: Sha256Hex,
  }),
  includes_blobs: z.boolean(),
  files: z.array(ManifestFileEntry),
});
export type Manifest = z.infer<typeof Manifest>;

export interface BuildManifestInput {
  files: BundleFiles;
  /** Register-referenced blob paths NOT contained in the bundle (lean
   * export), listed with their path-embedded checksum. */
  excludedBlobs: { path: string; sha256: string }[];
  schemaVersion: string;
  innerId: string;
  directoryName: string;
  exportedAt: string;
  chainHead: ChainLink;
  includesBlobs: boolean;
}

export function buildManifest(input: BuildManifestInput): Manifest {
  const included = Object.entries(input.files)
    .map(([path, content]) => ({
      path,
      sha256: sha256Hex(Buffer.from(content)),
      included: true,
      bytes: content.byteLength,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const excluded = input.excludedBlobs
    .map(({ path, sha256 }) => ({ path, sha256, included: false }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    manifest_version: MANIFEST_VERSION,
    schema_version: input.schemaVersion,
    project: {
      inner_id: input.innerId,
      directory_name: input.directoryName,
    },
    exported_at: input.exportedAt,
    chain_head: { seq: input.chainHead.seq, hash: input.chainHead.hash },
    includes_blobs: input.includesBlobs,
    files: [...included, ...excluded],
  };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

import { z } from "zod";

import { SourceType } from "./enums";
import { BlobPath, IsoDateTime, Sha256Hex, SourceId } from "./primitives";

/**
 * Snapshot block of a frozen source: retrieval time, checksum, blob paths
 * and revision number (file format appendix). The optional text blob holds
 * the extracted full text that stage 1 and the agent CLIs read.
 */
export const SourceSnapshot = z
  .strictObject({
    retrieved_at: IsoDateTime,
    sha256: Sha256Hex,
    blob_path: BlobPath,
    text_blob_path: BlobPath.optional(),
    /** Why no text blob exists (TMB-24): the extraction failure, made
     * durable at the source entry instead of living only in UI state. */
    text_extraction_error: z.string().min(1).optional(),
    revision: z.int().min(1),
  })
  .refine((snapshot) => snapshot.blob_path.includes(snapshot.sha256), {
    message: "blob_path must address the snapshot's own sha256 checksum",
    path: ["blob_path"],
  })
  .refine(
    (snapshot) => !(snapshot.text_blob_path && snapshot.text_extraction_error),
    {
      message:
        "text_blob_path and text_extraction_error are mutually exclusive",
      path: ["text_extraction_error"],
    },
  );

/** Result of resolving the source identifier (DOI, arXiv id, URL). */
export const IdentifierVerification = z.strictObject({
  status: z.boolean(),
  at: IsoDateTime,
});

/**
 * Workshop-specific extension fields, placed in the `custom` object that the
 * CSL-JSON specification designates as extension point: stripping `custom`
 * yields a plain CSL-JSON item (format requirement F4).
 */
export const SourceCustom = z.strictObject({
  source_type: SourceType,
  identifier_verified: IdentifierVerification.optional(),
  snapshot: SourceSnapshot.optional(),
  /** Superseded snapshots of earlier revisions (TMB-44), append-only in
   * revision order. The old blobs stay referenced from claims.json — a
   * revision makes them historical, never unreachable (old and new
   * revision coexist; documented extension, additive). */
  previous_snapshots: z.array(SourceSnapshot).optional(),
});

/**
 * A source entry: a regular CSL-JSON item plus the `custom` extension.
 * Only the fields the workshop relies on are constrained; all other CSL
 * fields pass through unvalidated (loose object), since CSL-JSON conformance
 * of the bibliographic core is the responsibility of the producing importer.
 */
export const Source = z
  .looseObject({
    id: SourceId,
    type: z.string().min(1),
    custom: SourceCustom,
  })
  .describe("CSL-JSON item with workshop extension in `custom`");

export type Source = z.infer<typeof Source>;
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

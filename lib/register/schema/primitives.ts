import { z } from "zod";

/**
 * Shared string primitives of the claims.json field schema (file format
 * appendix, normative). All identifiers are restricted to a stable ASCII
 * subset because they become part of RFC 8785-canonicalized, hashed chain
 * entries.
 */

/** ISO-8601 timestamp with mandatory UTC designator or offset. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Lowercase hex SHA-256 checksum. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256 checksum");

/**
 * Relative path into the content-addressed blob store:
 * blobs/<first two hash chars>/<sha256>.<extension>
 */
export const BlobPath = z
  .string()
  .regex(
    /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/,
    "expected a relative blob path blobs/<prefix>/<sha256>.<ext>",
  );

export const ProjectId = z
  .string()
  .regex(
    /^proj_[a-z0-9][a-z0-9._-]*$/,
    'expected a project id like "proj_example-2026"',
  );
export const ClaimId = z
  .string()
  .regex(/^clm_[a-z0-9][a-z0-9_-]*$/, 'expected a claim id like "clm_0001"');
export const SourceId = z
  .string()
  .regex(
    /^src_[a-z0-9][a-z0-9_-]*$/,
    'expected a source id like "src_meyer2025"',
  );
export const EvidenceId = z
  .string()
  .regex(/^ev_[a-z0-9][a-z0-9_-]*$/, 'expected an evidence id like "ev_0001"');

/**
 * Actor of a history entry or project event: a verification stage
 * ("system:<stage>") or the local user ("human:<handle>").
 */
export const ActorId = z
  .string()
  .regex(
    /^(human|system):[a-z0-9][a-z0-9_-]*$/,
    'expected an actor id like "human:lg" or "system:extraction"',
  );

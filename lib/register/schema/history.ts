import { z } from "zod";

import { ClaimStatus, ComplaintCategory, ProjectEventType } from "./enums";
import { ActorId, EvidenceId, IsoDateTime, Sha256Hex } from "./primitives";

/**
 * Chain fields carried by every history entry and project event. The `seq`
 * numbers of all entries of a project form one global, gapless, monotonically
 * increasing sequence; `hash`/`prev_hash` link the entries per the hash-chain
 * construction of the file format appendix (verified in lib/register/chain).
 */
export const ChainFields = z.strictObject({
  seq: z.int().min(1),
  prev_hash: Sha256Hex,
  hash: Sha256Hex,
});

/**
 * A human adjudication decision. `category` is null for confirmations and a
 * complaint category for objections; reviewed evidence ids and duration feed
 * the effort measures (A5) without separate logging infrastructure.
 */
export const Decision = z.strictObject({
  category: ComplaintCategory.nullable(),
  reviewed_evidence_ids: z.array(EvidenceId),
  duration_s: z.number().min(0),
});
export type Decision = z.infer<typeof Decision>;

/**
 * One status transition of a claim, appended by the status machine.
 * `from_status` is null exactly for the creating entry.
 */
export const HistoryEntry = z.strictObject({
  seq: ChainFields.shape.seq,
  at: IsoDateTime,
  actor: ActorId,
  from_status: ClaimStatus.nullable(),
  to_status: ClaimStatus,
  reason: z.string().min(1),
  decision: Decision.optional(),
  prev_hash: ChainFields.shape.prev_hash,
  hash: ChainFields.shape.hash,
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** A project-wide event without claim reference, structurally chain-linked
 * like a history entry. */
export const ProjectEvent = z.strictObject({
  seq: ChainFields.shape.seq,
  at: IsoDateTime,
  actor: ActorId,
  event: ProjectEventType,
  reason: z.string().min(1),
  prev_hash: ChainFields.shape.prev_hash,
  hash: ChainFields.shape.hash,
});
export type ProjectEvent = z.infer<typeof ProjectEvent>;

import { z } from "zod";

import {
  ClaimStatus,
  ComplaintCategory,
  ProjectEventType,
  RoutingReason,
} from "./enums";
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
 * A human adjudication decision. `categories` is empty for confirmations and
 * carries one or more complaint categories for objections (multi-select of
 * the adjudication dialog, TMB-35); reviewed evidence ids and duration feed
 * the effort measures (A5) without separate logging infrastructure.
 */
export const Decision = z.strictObject({
  categories: z.array(ComplaintCategory),
  reviewed_evidence_ids: z.array(EvidenceId),
  duration_s: z.number().min(0),
});
export type Decision = z.infer<typeof Decision>;

/**
 * Text revision of the repair loop (TMB-37): carried by the
 * `beanstandet → ueberarbeitet` history entry so every previous wording
 * stays reconstructable from the chain alone.
 */
export const Revision = z.strictObject({
  previous_text: z.string().min(1),
  new_text: z.string().min(1),
});
export type Revision = z.infer<typeof Revision>;

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
  routing: RoutingReason.optional(),
  revision: Revision.optional(),
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

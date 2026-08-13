import { z } from "zod";

import {
  ClaimStatus,
  ComplaintCategory,
  ProjectEventType,
  RoutingReason,
  SourceType,
} from "./enums";
import {
  ActorId,
  BlobPath,
  ClaimId,
  EvidenceId,
  IsoDateTime,
  Sha256Hex,
  SourceId,
} from "./primitives";
import { ProjectConfig } from "./project";
import { AutoCaptureProvenance } from "./source";

/**
 * Chain fields carried by every history entry and project event. The `seq`
 * numbers of all entries of a project form one global, gapless, monotonically
 * increasing sequence; `hash`/`prev_hash` link the entries per the hash-chain
 * construction of the file format appendix (verified in lib/register/chain).
 * `state_root` commits the register's materialized content state as of the
 * writing transaction (see lib/register/chain/state-root.ts); optional only
 * because entries from before this extension lack it — the appender always
 * sets it (documented extension, additive).
 */
export const ChainFields = z.strictObject({
  seq: z.int().min(1),
  prev_hash: Sha256Hex,
  hash: Sha256Hex,
  state_root: Sha256Hex.optional(),
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
 * `contested → revised` history entry so every previous wording
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
  state_root: ChainFields.shape.state_root,
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/**
 * Config change payload of a `config_changed` event (TMB-46): the complete
 * before/after pair, following the full-snapshot idiom of `Revision`
 * (previous_text/new_text) — the configuration at any point of the history
 * is reconstructable from the chain alone, and a config change past the
 * audit trail is impossible because the value is only written together with
 * this event.
 */
export const ConfigChange = z.strictObject({
  previous: ProjectConfig,
  next: ProjectConfig,
});
export type ConfigChange = z.infer<typeof ConfigChange>;

/**
 * Manual anchor correction payload of a `claim_anchor_revised` event
 * (workbench epic): the complete before/after pair, following the same
 * full-snapshot idiom as `Revision` and `ConfigChange` — the anchor history
 * of a claim is reconstructable from the chain alone. `previous_quote`/
 * `new_quote` are optional because a legacy claim without a captured
 * `anchor_quote` may still have its position-based `previous_anchor`
 * corrected (documented extension, additive).
 */
export const AnchorChange = z.strictObject({
  claim_id: ClaimId,
  previous_anchor: z.string().min(1),
  new_anchor: z.string().min(1),
  previous_quote: z.string().min(1).optional(),
  new_quote: z.string().min(1).optional(),
});
export type AnchorChange = z.infer<typeof AnchorChange>;

/**
 * The retryable input snapshot of a failed source-capture attempt (source
 * work items): everything needed to pre-fill and re-run the attempt, WITHOUT
 * the uploaded document's bytes — an upload is frozen as a content-addressed
 * blob at enqueue time and referenced here by path, keeping the register
 * git-diffable (F3) while still making a retry possible after a restart
 * without re-uploading.
 */
export const CaptureFailureInput = z.strictObject({
  kind: z.enum(["doi", "arxiv", "url", "upload"]),
  source_type: SourceType,
  identifier: z.string().min(1).optional(),
  document_url: z.string().min(1).optional(),
  /** Present only for correction attempts (source correction): the id of
   * the EXISTING source whose identity this input is meant to replace —
   * a correction never creates a source (documented extension, additive). */
  target_source_id: SourceId.optional(),
  manual: z
    .strictObject({
      title: z.string().min(1),
      authors: z.string().min(1).optional(),
      year: z.string().min(1).optional(),
      container_title: z.string().min(1).optional(),
    })
    .optional(),
  upload: z
    .strictObject({
      blob_path: BlobPath,
      filename: z.string().min(1),
    })
    .optional(),
  /** Auto-import provenance of the failed attempt (automatic repair):
   * kept in the durable snapshot so a later automatic re-resolution still
   * has the raw citation text to work from — without it a failed
   * reference-import capture would lose exactly the context the repair
   * needs (documented extension, additive). */
  auto_capture: AutoCaptureProvenance.optional(),
});
export type CaptureFailureInput = z.infer<typeof CaptureFailureInput>;

/**
 * Failure payload of a `source_capture_failed` event (source work items):
 * which work item failed, on which path it entered the workshop, and the
 * input to retry it with. `work_item_id` correlates with a later successful
 * attempt via the source entry's `custom.capture_attempt_id` — the latest
 * failure of a work item is considered resolved once such a source exists,
 * so no "resolved" event is ever needed. For reference-import items the
 * work-item id IS the scan's candidate id.
 */
export const CaptureFailure = z.strictObject({
  work_item_id: z.string().min(1),
  // "correction": the attempt targeted an existing source's identity
  // (source correction) — the input then carries `target_source_id`.
  // "auto_repair": the attempt was enqueued by the automatic repair, not
  // a human — the loop guard keys on this: an auto-repair never fires on
  // an auto_repair-origin failure again.
  origin: z.enum(["manual", "reference_import", "correction", "auto_repair"]),
  input: CaptureFailureInput,
});
export type CaptureFailure = z.infer<typeof CaptureFailure>;

/** What an automatic repair targets: a failed capture attempt (work item)
 * or an already-captured source whose identity is suspect. */
export const RepairActionTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("capture_failure"),
    work_item_id: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("source"), source_id: SourceId }),
]);
export type RepairActionTarget = z.infer<typeof RepairActionTarget>;

/** The corrected identity the automatic repair derived. */
export const RepairActionCandidate = z.strictObject({
  kind: z.enum(["doi", "arxiv", "url"]),
  identifier: z.string().min(1).optional(),
  document_url: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
export type RepairActionCandidate = z.infer<typeof RepairActionCandidate>;

/**
 * Payload of a `source_repair_action` event (automatic repair): what was
 * targeted, what candidate identity the system derived, on which basis,
 * with which confidence — and whether it was applied automatically or
 * only suggested. `quote_fit` carries the disambiguation evidence of the
 * quote-containment check (how many of the failing verbatim excerpts the
 * candidate document contains vs the current frozen text), so a reviewer
 * sees the same numbers the automatic decision saw (documented extension,
 * additive).
 */
export const RepairAction = z.strictObject({
  target: RepairActionTarget,
  mode: z.enum(["suggested", "applied"]),
  basis: z.enum([
    "capture_failure_rematch",
    "identity_unambiguous_rematch",
    "quote_fit_rematch",
  ]),
  candidate: RepairActionCandidate,
  confidence: z.number().min(0).max(1).optional(),
  quote_fit: z
    .strictObject({
      candidate_matches: z.int().min(0),
      current_matches: z.int().min(0),
      checked_excerpts: z.int().min(1),
    })
    .optional(),
});
export type RepairAction = z.infer<typeof RepairAction>;

/**
 * Payload of a `source_identity_corrected` event (source correction): the
 * complete before/after bibliographic core, following the full-snapshot
 * idiom of `Revision`/`ConfigChange`/`AnchorChange` — an auditor reads the
 * old identity, the new identity, the snapshot rotation and every claim the
 * correction pulled back into recheck from this one entry, without
 * replaying the chain (documented extension, additive).
 */
export const IdentityChange = z.strictObject({
  source_id: SourceId,
  previous_item: z.record(z.string(), z.unknown()),
  new_item: z.record(z.string(), z.unknown()),
  snapshot_revision: z.strictObject({
    from: z.int().min(1),
    to: z.int().min(1),
  }),
  recheck_claim_ids: z.array(ClaimId),
});
export type IdentityChange = z.infer<typeof IdentityChange>;

/** A project-wide event without claim reference, structurally chain-linked
 * like a history entry. */
export const ProjectEvent = z.strictObject({
  seq: ChainFields.shape.seq,
  at: IsoDateTime,
  actor: ActorId,
  event: ProjectEventType,
  reason: z.string().min(1),
  /** Only on `config_changed` events (TMB-46). */
  config_change: ConfigChange.optional(),
  /** Only on `claim_anchor_revised` events (workbench epic, documented
   * extension, additive). */
  anchor_change: AnchorChange.optional(),
  /** Only on `source_capture_failed` events (source work items, documented
   * extension, additive). */
  capture_failure: CaptureFailure.optional(),
  /** Only on `source_identity_corrected` events (source correction,
   * documented extension, additive). */
  identity_change: IdentityChange.optional(),
  /** Only on `source_repair_action` events (automatic repair, documented
   * extension, additive). */
  repair_action: RepairAction.optional(),
  /** The single source an extraction bracket event targeted: set on
   * `batch_run_started`/`batch_run_completed` for per-source passes, absent
   * for the project-wide sweep and for events from before this extension —
   * per-source run state derives from this structurally instead of parsing
   * the German `reason` prose (source work items, documented extension,
   * additive). */
  source_id: SourceId.optional(),
  /** The capture work item a `source_capture_dismissed` event resolves
   * (source work items). A plain scalar like `source_id` above — the
   * failure being dismissed already carries its full snapshot in its own
   * event's `capture_failure` (documented extension, additive). */
  work_item_id: z.string().min(1).optional(),
  prev_hash: ChainFields.shape.prev_hash,
  hash: ChainFields.shape.hash,
  state_root: ChainFields.shape.state_root,
});
export type ProjectEvent = z.infer<typeof ProjectEvent>;

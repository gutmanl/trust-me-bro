import { z } from "zod";

import { ExistenceCheckStatus, RelationType } from "./enums";
import { EvidenceId, IsoDateTime, SourceId } from "./primitives";

/**
 * One backend's attribution judgment for a piece of evidence. The adapter
 * layer validates CLI output against this sub-schema before merging it into
 * the register (Grobentwurf), which is why it is exported separately.
 */
export const Judgment = z.strictObject({
  backend: z.string().min(1),
  model: z.string().min(1),
  relation_type: RelationType,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  at: IsoDateTime,
});
export type Judgment = z.infer<typeof Judgment>;

/**
 * Locator of a finding inside a source. Page and section are the common
 * cases; further locator keys (e.g. paragraph, timestamp) pass through.
 */
export const Locator = z.looseObject({
  page: z.int().min(1).optional(),
  section: z.string().optional(),
});

/** Result of the deterministic verbatim-existence check (stage 1). */
export const ExistenceCheck = z.strictObject({
  status: ExistenceCheckStatus,
  at: IsoDateTime,
});

/**
 * Evidence merges Fundstelle and Relation of the artifact model: a finding
 * always originates in the context of exactly one claim. `relation_type` is
 * the *resolved* relation (set by adjudication on divergence); the raw
 * per-backend judgments stay in `judgments[]` and are never overwritten.
 * Fields filled by later verification stages are optional so freshly
 * extracted evidence is representable.
 */
export const Evidence = z.strictObject({
  id: EvidenceId,
  source_id: SourceId,
  locator: Locator,
  verbatim_excerpt: z.string().min(1),
  existence_check: ExistenceCheck.optional(),
  relation_type: RelationType.optional(),
  judgments: z.array(Judgment),
});
export type Evidence = z.infer<typeof Evidence>;

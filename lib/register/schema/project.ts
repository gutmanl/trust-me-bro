import { z } from "zod";

import { BlobPath, IsoDateTime, ProjectId, Sha256Hex } from "./primitives";

/**
 * Reference to the frozen original briefing in the blob store: the input
 * against which extraction is measured, kept unchanged by construction.
 */
export const BriefingImport = z.strictObject({
  imported_at: IsoDateTime,
  sha256: Sha256Hex,
  blob_path: BlobPath,
  tool: z.string().min(1),
});

/**
 * Project identity and state. `id`, `research_question` and `created_at` are
 * immutable after creation — a normative invariant of the format: the genesis
 * hash of the chain is derived from exactly these three fields, and a changed
 * research question is by definition a new project. Immutability is enforced
 * by the persistence layer; the schema validates shape only.
 */
export const Project = z.strictObject({
  id: ProjectId,
  research_question: z.string().min(1),
  created_at: IsoDateTime,
  source_set_revision: z.int().min(1),
  briefing_import: BriefingImport.optional(),
});
export type Project = z.infer<typeof Project>;

/** Reference to one agent-CLI backend. */
export const BackendRef = z.strictObject({
  cli: z.string().min(1),
  model_family: z.string().min(1),
});

/**
 * Project configuration: rubric version, adjudication sample rate and the
 * configured backends. `secondary` is absent when only one model family is
 * available; the pipeline then runs with the divergence rule disabled and
 * this absence is the visible record of that (Grobentwurf).
 */
export const ProjectConfig = z.strictObject({
  rubric_version: z.string().min(1),
  adjudication_sample_rate: z.number().min(0).max(1),
  backends: z.strictObject({
    primary: BackendRef,
    secondary: BackendRef.optional(),
  }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

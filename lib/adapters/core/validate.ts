import type { ZodType } from "zod";

import {
  ExtractionOutput,
  ReferenceParseOutput,
  RelevanceOutput,
  RepairOutput,
  ResearchOutput,
} from "../schema";
// Deep imports on purpose: the two version selectors are internals of their
// schema modules and stay OFF `schema/index.ts` and `adapters/index.ts`, so
// giving this dispatch a version dimension costs no barrel movement.
import { attributionOutputSchemaFor } from "../schema/attribution";
import { rubricOutputSchemaFor } from "../schema/rubric";
import { AdapterValidationError } from "./errors";
import type { JobIO, JobKind } from "./jobs";

/**
 * Per job kind, the schema selector for a resolved prompt template version.
 * The five kinds with a single shape ignore the argument; `attribution` and
 * `rubric` carry two live prompt vintages at once and pick per version.
 */
const OUTPUT_SCHEMA: {
  [K in JobKind]: (promptVersion: string) => ZodType<JobIO[K]["output"]>;
} = {
  research: () => ResearchOutput,
  extraction: () => ExtractionOutput,
  attribution: attributionOutputSchemaFor,
  rubric: rubricOutputSchemaFor,
  repair: () => RepairOutput,
  relevance: () => RelevanceOutput,
  reference_parse: () => ReferenceParseOutput,
};

/**
 * The trust boundary for LLM output: every candidate is validated against
 * the job's result schema before it can leave a backend. Invalid shapes
 * throw — a resolved backend promise always carries a schema-valid output,
 * which is what keeps invalid data structurally unable to reach the register.
 *
 * `promptVersion` selects WHICH contract is enforced: the shape a job's own
 * template asked for, never a shape some other vintage asked for. It is
 * REQUIRED rather than defaulted, so a call site that forgets it is a type
 * error instead of a silent fallback to a contract nobody named. It also
 * cannot be swapped with the adjacent `kind` unnoticed — `kind` is a literal
 * union and a version string is not a `JobKind`.
 *
 * Job INPUT never enters this file: it learns which contract a version
 * speaks and nothing about the claim being judged. The input-dependent
 * clauses (does the technical layer quote this evidence? does it name the
 * rule for THIS claim's type?) live beside it in the orchestrator's
 * output-contract module, and that separation is what keeps this dispatch a
 * pure function of the request's identity.
 */
export function validateJobOutput<K extends JobKind>(
  backend: string,
  kind: K,
  promptVersion: string,
  candidate: unknown,
): JobIO[K]["output"] {
  const parsed = OUTPUT_SCHEMA[kind](promptVersion).safeParse(candidate);
  if (!parsed.success) {
    throw new AdapterValidationError(backend, kind, parsed.error);
  }
  return parsed.data;
}

import type { ZodType } from "zod";

import {
  AttributionOutput,
  ExtractionOutput,
  ReferenceParseOutput,
  RelevanceOutput,
  RepairOutput,
  RubricOutput,
} from "../schema";
import { AdapterValidationError } from "./errors";
import type { JobIO, JobKind } from "./jobs";

const OUTPUT_SCHEMA: { [K in JobKind]: ZodType<JobIO[K]["output"]> } = {
  extraction: ExtractionOutput,
  attribution: AttributionOutput,
  rubric: RubricOutput,
  repair: RepairOutput,
  relevance: RelevanceOutput,
  reference_parse: ReferenceParseOutput,
};

/**
 * The trust boundary for LLM output: every candidate is validated against
 * the job's result schema before it can leave a backend. Invalid shapes
 * throw — a resolved backend promise always carries a schema-valid output,
 * which is what keeps invalid data structurally unable to reach the register.
 */
export function validateJobOutput<K extends JobKind>(
  backend: string,
  kind: K,
  candidate: unknown,
): JobIO[K]["output"] {
  const parsed = OUTPUT_SCHEMA[kind].safeParse(candidate);
  if (!parsed.success) {
    throw new AdapterValidationError(backend, kind, parsed.error);
  }
  return parsed.data;
}

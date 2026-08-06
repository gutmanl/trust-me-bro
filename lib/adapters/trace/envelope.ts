import { z } from "zod";

import { IsoDateTime, Sha256Hex } from "../../register";

/**
 * JSON-RPC-like envelope of one adapter ATTEMPT (file format appendix,
 * traces.json derivation): `method` is the job kind, `params` the job input,
 * and exactly one of `result`/`error` is present. Every attempt — including
 * failed and retried ones — produces one envelope; `finished_at` of a
 * successful attribution attempt equals the merged judgment's `at` (written
 * from the same clock read), which is the correlation between register
 * entries and traces.
 */
export const TraceEnvelope = z
  .strictObject({
    trace_id: z.uuid(),
    method: z.enum(["extraction", "attribution", "rubric", "repair"]),
    params: z.unknown(),
    backend: z.string().min(1),
    /** Null when the attempt failed before the backend reported a model. */
    model: z.string().min(1).nullable(),
    prompt_version: z.string().min(1),
    prompt_sha256: Sha256Hex,
    attempt: z.int().min(1),
    started_at: IsoDateTime,
    finished_at: IsoDateTime,
    result: z.unknown().optional(),
    error: z
      .strictObject({
        kind: z.enum([
          "timeout",
          "process_failure",
          "invalid_output",
          "rate_limited",
        ]),
        name: z.string().min(1),
        message: z.string(),
      })
      .optional(),
  })
  .superRefine((envelope, ctx) => {
    if (envelope.error === undefined && !("result" in envelope)) {
      ctx.addIssue({
        code: "custom",
        message: "an envelope carries either a result or an error",
      });
    }
    if (envelope.error !== undefined && "result" in envelope) {
      ctx.addIssue({
        code: "custom",
        message: "result and error are mutually exclusive",
      });
    }
  });
export type TraceEnvelope = z.infer<typeof TraceEnvelope>;

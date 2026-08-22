import { z } from "zod";

import { GERMAN_RULE_NAMES } from "../schema/plain-contract";
import { usesTwoLayerProse } from "../schema/prose-contract-version";
import { AdapterValidationError } from "./errors";
import type {
  AttributionInput,
  JobIO,
  JobKind,
  JobRequest,
  RubricInput,
} from "./jobs";

/**
 * The two clauses of the two-layer prose contract that need the JOB INPUT
 * (PROMPT-01, ROADMAP Success Criterion 2).
 *
 * They cannot live in the output schema: `OUTPUT_SCHEMA` in `validate.ts` is
 * a static table keyed on kind and version, with no access to `job.input`.
 * Making it input-aware would change `validateJobOutput`'s signature and all
 * four of its call sites — and would give the dispatch an opinion about the
 * claim being judged, which is exactly the separation that keeps it a pure
 * function of the request's identity. So they live BESIDE it instead.
 *
 * Off every barrel: consumed by the orchestrator only.
 */

/**
 * Minimum length, in UTF-16 code units, of the span of the job's own
 * `verbatim_excerpt` that an attribution's technical layer must quote
 * (PITFALLS P-3, mitigation 2).
 *
 * This is what stops the technical layer being ungrounded prose ABOUT an
 * excerpt it never read. Fifteen is short enough that a faithful quotation
 * of even a terse finding clears it, and long enough that clearing it by
 * accident — through shared function words — is not realistic.
 */
export const EXCERPT_ANCHOR_MIN_CHARS = 15;

/**
 * Collapses every run of whitespace to a single space.
 *
 * Applied to BOTH operands before the scan, and that is the whole point: a
 * model copying a quotation out of a line-wrapped excerpt re-wraps it, so a
 * raw substring test would reject a faithful quote and send a correct
 * generation into three retries and an escalation.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when `technical` contains a contiguous span of at least
 * `EXCERPT_ANCHOR_MIN_CHARS` characters of `excerpt`. Both are already
 * whitespace-normalised.
 *
 * A span LONGER than the threshold necessarily contains a window of exactly
 * the threshold, so scanning fixed-width windows decides the general
 * question. Both operands are bounded before they get here — the plain
 * contract's length clauses cap the output and `verbatim_excerpt` is a
 * frozen, size-bounded register field — so this is a bounded scan with no
 * backtracking (threat T-03-12).
 */
function quotesExcerpt(technical: string, excerpt: string): boolean {
  if (excerpt.length < EXCERPT_ANCHOR_MIN_CHARS) {
    // VACUOUSLY satisfied, and deliberately so. Demanding a quotation longer
    // than the excerpt itself would make every generation for that evidence
    // unsatisfiable: three failed attempts and an escalation whose reason no
    // reviewer could act on.
    return true;
  }
  for (
    let start = 0;
    start + EXCERPT_ANCHOR_MIN_CHARS <= excerpt.length;
    start += 1
  ) {
    const window = excerpt.slice(start, start + EXCERPT_ANCHOR_MIN_CHARS);
    if (technical.includes(window)) {
      return true;
    }
  }
  return false;
}

/** The one prose field both clauses inspect. */
interface TechnicalLayer {
  readonly reasoning_technical: string;
}

/**
 * Builds a per-job schema closed over `job.input`, whose failure carries a
 * REAL `ZodError` — which is what `AdapterValidationError`'s constructor
 * requires, and the reason these clauses are expressed as a schema rather
 * than as bare conditionals.
 *
 * Like every check at this boundary it RECORDS issues and never raises: a
 * raised exception would escape as a non-`AdapterError`, and the
 * orchestrator rethrows those as programming errors, killing the run instead
 * of retrying the attempt.
 */
function contractFor(job: JobRequest): z.ZodType {
  return z.unknown().check((payload) => {
    const value = payload.value as Partial<TechnicalLayer>;
    const technical = value.reasoning_technical;
    /* c8 ignore start -- unreachable: validateJobOutput has already proven
       the two-layer shape by the time the orchestrator calls this. The guard
       exists so a future caller cannot turn a shape mistake into a crash. */
    if (typeof technical !== "string") {
      return;
    }
    /* c8 ignore stop */

    if (job.kind === "attribution") {
      const excerpt = (job.input as AttributionInput).evidence.verbatim_excerpt;
      if (
        !quotesExcerpt(
          normalizeWhitespace(technical),
          normalizeWhitespace(excerpt),
        )
      ) {
        payload.issues.push({
          code: "custom",
          input: payload.value,
          path: ["reasoning_technical"],
          message:
            `muss mindestens ${EXCERPT_ANCHOR_MIN_CHARS} zusammenhängende ` +
            "Zeichen aus dem Auszug dieses Belegs wörtlich zitieren — die " +
            "fachliche Ebene belegt am Auszug, sie umschreibt ihn nicht",
        });
      }
      return;
    }

    // rubric — the only other kind the version gate lets through.
    const expected =
      GERMAN_RULE_NAMES[(job.input as RubricInput).claim.claim_type];
    if (!technical.includes(expected)) {
      payload.issues.push({
        code: "custom",
        input: payload.value,
        path: ["reasoning_technical"],
        message:
          `muss die Regelbezeichnung "${expected}" wörtlich nennen — die ` +
          "Regel dieses Aussagetyps, nicht irgendeine der vier",
      });
    }
  });
}

/**
 * The SEMANTIC half of the adapter trust boundary: everything about an output
 * that can only be decided against the input that produced it.
 *
 * Strictly additional to `validateJobOutput`, which has already run — inside
 * the backend and again in the orchestrator — so the output handed here is
 * known to be schema-valid for its own prompt version.
 */
export function assertOutputMatchesInput<K extends JobKind>(
  backend: string,
  job: JobRequest<K>,
  output: JobIO[K]["output"],
): void {
  // Gated on the PROMPT VERSION, first thing, using the same predicate the
  // schema dispatch uses — two ways of deciding the same question is how the
  // two drift. Under a single-reasoning contract neither clause has a
  // subject: there is no `reasoning_technical` to anchor and no place the
  // rule name was ever asked for. Running them anyway would fail every
  // generation in every existing project, three attempts deep.
  //
  // Every OTHER job kind returns here too, and that is deliberate rather
  // than an oversight: extraction, research, repair, relevance and
  // reference_parse carry no prose contract at all, so a future kind that
  // needs one is a deliberate addition to `usesTwoLayerProse`'s table.
  if (!usesTwoLayerProse(job.kind, job.prompt.version)) {
    return;
  }
  const parsed = contractFor(job).safeParse(output);
  if (!parsed.success) {
    throw new AdapterValidationError(backend, job.kind, parsed.error);
  }
}

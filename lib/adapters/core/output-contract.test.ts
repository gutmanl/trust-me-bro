import { describe, expect, it } from "vitest";

import { exampleEvidence, jobFor } from "../__fixtures__/jobs";
import { GERMAN_RULE_NAMES } from "../schema/plain-contract";
import { AdapterValidationError } from "./errors";
import type { JobKind, JobRequest } from "./jobs";
import {
  assertOutputMatchesInput,
  EXCERPT_ANCHOR_MIN_CHARS,
} from "./output-contract";

/**
 * The two contract clauses that cannot live in the output schema, because
 * `OUTPUT_SCHEMA` is a static table with no access to `job.input`.
 *
 * Every clause carries a REJECTING row and an ACCEPTING row. `lib/adapters/
 * core/` sits inside the coverage ratchet and each clause is a branch, so a
 * one-sided clause lowers the branch percentage — and, worse, a contract
 * proven only by its rejections is a contract nobody has shown to be
 * satisfiable.
 */

const EXCERPT = exampleEvidence.verbatim_excerpt;

/** A span of exactly the threshold, lifted out of the excerpt itself. */
const ANCHOR_EXACT = EXCERPT.slice(1, 1 + EXCERPT_ANCHOR_MIN_CHARS);
/** One character short of it. */
const ANCHOR_SHORT = EXCERPT.slice(1, EXCERPT_ANCHOR_MIN_CHARS);

/**
 * There is no attribution v1.2.0 TEMPLATE yet — 03-03 authors it. The version
 * gate reads `job.prompt.version` and nothing else, so naming the version on
 * an otherwise real job is enough to exercise the two-layer arm without
 * inventing a template file this plan has no business creating.
 */
function twoLayerJob<K extends JobKind>(kind: K): JobRequest<K> {
  const base = jobFor(kind);
  return { ...base, prompt: { ...base.prompt, version: "1.2.0" } };
}

function attributionOutput(technical: string) {
  return {
    relation_type: "supports" as const,
    confidence: 0.9,
    reasoning_plain: "Der Auszug trägt die Aussage. Die Richtung stimmt.",
    caveat: null,
    reasoning_technical: technical,
  };
}

function rubricOutput(technical: string) {
  return {
    calibration_result: "licensed" as const,
    reasoning_plain: "Die Formulierung passt zu den Belegen. Sie ist gedeckt.",
    caveat: null,
    reasoning_technical: technical,
  };
}

describe("assertOutputMatchesInput — the excerpt anchor (attribution)", () => {
  const job = twoLayerJob("attribution");

  it(`accepts a technical layer quoting exactly ${EXCERPT_ANCHOR_MIN_CHARS} characters`, () => {
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        job,
        attributionOutput(
          `Der Abschnitt sagt "${ANCHOR_EXACT}" und stützt sie.`,
        ),
      ),
    ).not.toThrow();
  });

  it(`rejects a technical layer quoting only ${EXCERPT_ANCHOR_MIN_CHARS - 1} characters`, () => {
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        job,
        attributionOutput(
          `Der Abschnitt sagt "${ANCHOR_SHORT}" und stützt sie.`,
        ),
      ),
    ).toThrow(AdapterValidationError);
  });

  it("rejects a technical layer quoting a DIFFERENT evidence's excerpt", () => {
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        job,
        attributionOutput(
          'Der Abschnitt sagt "rework rate fell from 18% to 11%" und stützt sie.',
        ),
      ),
    ).toThrow(AdapterValidationError);
  });

  it("rejects ungrounded prose about an excerpt it never read", () => {
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        job,
        attributionOutput(
          "Der Abschnitt deckt die Aussage in ihrem Kontext vollständig ab.",
        ),
      ),
    ).toThrow(AdapterValidationError);
  });

  it("accepts a quotation the model RE-WRAPPED across lines", () => {
    // A model copying out of a line-wrapped excerpt re-wraps it. A raw
    // substring test would reject a faithful quote — which is why both sides
    // are whitespace-normalised before the scan.
    const rewrapped = ANCHOR_EXACT.replace(" ", "\n   ");
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        job,
        attributionOutput(`Der Abschnitt sagt "${rewrapped}" und stützt sie.`),
      ),
    ).not.toThrow();
  });

  it("accepts a single-line quote of a LINE-WRAPPED excerpt (the other direction)", () => {
    const wrappedExcerptJob: JobRequest<"attribution"> = {
      ...job,
      input: {
        ...job.input,
        evidence: {
          ...job.input.evidence,
          verbatim_excerpt: EXCERPT.replace(" ", "\n\t "),
        },
      },
    };
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        wrappedExcerptJob,
        attributionOutput(
          `Der Abschnitt sagt "${ANCHOR_EXACT}" und stützt sie.`,
        ),
      ),
    ).not.toThrow();
  });

  it("is satisfied VACUOUSLY by an excerpt shorter than the threshold", () => {
    // An unsatisfiable clause turns every generation for that evidence into
    // three failed attempts and an escalation whose reason no reviewer could
    // act on. Asserted so the vacuous case is a decision, not an accident.
    const shortExcerptJob: JobRequest<"attribution"> = {
      ...job,
      input: {
        ...job.input,
        evidence: { ...job.input.evidence, verbatim_excerpt: "kurz" },
      },
    };
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        shortExcerptJob,
        attributionOutput("Der Abschnitt deckt die Aussage ab."),
      ),
    ).not.toThrow();
  });
});

describe("assertOutputMatchesInput — the claim-type-correct rule name (rubric)", () => {
  const job = jobFor("rubric", undefined, "1.2.0");
  const correct = GERMAN_RULE_NAMES[job.input.claim.claim_type];

  it("accepts the German rule name mapped from the job's OWN claim_type", () => {
    expect(() =>
      assertOutputMatchesInput(
        "mock",
        job,
        rubricOutput(`Die ${correct} ist erfüllt.`),
      ),
    ).not.toThrow();
  });

  it.each(Object.values(GERMAN_RULE_NAMES).filter((name) => name !== correct))(
    "rejects the rule name %s — one of the four, but not this claim's",
    (wrong) => {
      // 03-01's STATIC clause only asks for one of the four; this one knows
      // which. Both stay live: the static one keeps the rubric schema
      // self-contained, this one runs once and can read the job.
      expect(() =>
        assertOutputMatchesInput(
          "mock",
          job,
          rubricOutput(`Die ${wrong} ist erfüllt.`),
        ),
      ).toThrow(AdapterValidationError);
    },
  );
});

describe("assertOutputMatchesInput — what it deliberately does NOT inspect", () => {
  it.each(["1.0.0", "1.1.0"])(
    "passes an attribution job at prompt version %s straight through",
    (version) => {
      // A single-reasoning output has no technical layer to anchor. Running
      // the clause anyway would fail every generation in every existing
      // project — the same defect the version dispatch exists to prevent,
      // one layer further in.
      const base = jobFor("attribution");
      const job: JobRequest<"attribution"> = {
        ...base,
        prompt: { ...base.prompt, version },
      };
      expect(() =>
        assertOutputMatchesInput("mock", job, {
          relation_type: "supports",
          confidence: 0.9,
          reasoning: "Der Auszug deckt die Aussage ab.",
        }),
      ).not.toThrow();
    },
  );

  it.each(["1.0.0", "1.1.0"])(
    "passes a rubric job at prompt version %s straight through",
    (version) => {
      expect(() =>
        assertOutputMatchesInput("mock", jobFor("rubric", undefined, version), {
          calibration_result: "licensed",
          reasoning: "Die Mindestbelege liegen vor.",
        }),
      ).not.toThrow();
    },
  );

  it.each([
    "research",
    "extraction",
    "repair",
    "relevance",
    "reference_parse",
  ] as const)("never inspects a %s output", (kind) => {
    expect(() =>
      assertOutputMatchesInput("mock", twoLayerJob(kind), {
        anything: "at all",
      } as never),
    ).not.toThrow();
  });
});

describe("assertOutputMatchesInput — the error it raises", () => {
  it("raises AdapterValidationError, so the orchestrator's existing catch retries it", () => {
    // A bare Error would be rethrown as a programming error and kill the run
    // (threat T-03-13). The class is what buys the retry for free.
    let caught: unknown;
    try {
      assertOutputMatchesInput(
        "mock",
        twoLayerJob("attribution"),
        attributionOutput("Ungegründete Prosa ohne jedes Zitat."),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterValidationError);
    const error = caught as AdapterValidationError;
    expect(error.kind).toBe("invalid_output");
    expect(error.backend).toBe("mock");
    expect(error.jobKind).toBe("attribution");
    expect(error.zodError.issues.length).toBeGreaterThan(0);
  });
});

import type { z } from "zod";

import {
  CalibrationResult,
  ClaimType,
  RelationType,
  SourceType,
  SupportDegree,
} from "../../register";
import type { ClaimType as ClaimTypeValue } from "../../register";

/**
 * The machine-checked half of the two-layer prose contract (PROMPT-01,
 * PROMPT-02).
 *
 * TrustMeBro's own convention, not a citation: the plain layer is written
 * for an educated non-specialist — a thesis reviewer expert in something
 * other than this project's evidence rubric. The rules below are the ones a
 * schema can actually decide; everything semantic (does the plain layer drop
 * the qualifier that carried the judgment?) goes to the human diff review,
 * deliberately NOT to another sentence in the prompt: prompting for accuracy
 * was measured to backfire, so an instruction is not a control. The control
 * is this file, at the adapter trust boundary.
 *
 * Off every barrel: imported by `schema/rubric.ts` and `schema/attribution.ts`
 * only.
 */

/**
 * Upper bound on `reasoning_plain`, in UTF-16 code units (JavaScript string
 * length) — the same unit the shipped v1.1.0 templates' "900 characters"
 * instruction already means, and the unit a model's own character intuition
 * approximates. Do NOT "fix" this to grapheme clusters: German prose in this
 * domain contains no astral-plane characters, and changing the unit would
 * silently move the boundary for every already-written template.
 *
 * WHAT IT PROTECTS, which is the only justification this number is allowed
 * to have: the plain layer must not become a second essay. If it is as long
 * as the technical layer the reviewer reads one of the two and the two-layer
 * design has bought nothing. Sizing evidence, measured over the 57 real
 * stored judgment reasonings in the local registers: min 369, median ≈ 750,
 * max 912 characters. At 360 the plain layer is at most ≈ 48 % of a median
 * whole reasoning — still a compression, and enough room in German (which
 * compounds) for a fixed verdict phrase, one rule name and one limiting
 * fact.
 *
 * CALIBRATED, not guessed. 03-01 sized this at 320 and recorded an explicit
 * hook to re-examine it against a real run; the 03-04 comparison run
 * (2026-08-23, `claude-haiku-4-5-20251001`, recorded in
 * `tests/corpus/verdict-comparison/results.ndjson`) is that run. Of 30 failed
 * contract clauses in the v1.2.0 ordering-A arm, exactly two were this cap,
 * at 323 and 329 characters — both marginal overruns rather than second
 * essays. 03-05 raised the number to 360 to admit them with headroom.
 *
 * The direction is not free: this cap may only ever move UP after a
 * measurement. A raised cap can turn a rejected generation into an accepted
 * one and therefore cannot change a verdict a run already recorded, whereas
 * a tightened one would ship a contract stricter than the one that was
 * measured.
 *
 * The RELATIVE guard below (plain no longer than technical) does the
 * load-bearing work; 360 is the absolute backstop.
 */
export const PLAIN_MAX_CHARS = 360;

/**
 * Upper bound on the three prose fields together, so the joined string
 * cannot outgrow what a claim card can hold. Counts the prose only — the
 * role markers add a fixed ≈ 40 characters the model does not write and
 * therefore cannot be asked to budget for.
 *
 * CALIBRATED against the same 03-04 run as the plain cap above, and this is
 * the number that run existed to find. At 1400 this clause fired on 27 of
 * the arm's 30 failed clauses and drove the first-attempt contract pass rate
 * to 10 %, which made both v1.2.0 arms unmeasurable. The original 1400 was
 * sized against SINGLE-reasoning strings of median ≈ 750; a two-layer answer
 * plus a caveat is three prose fields, and the run measured the sum at min
 * 1414, median 1837, max 2342. The old number was not a limit the model was
 * failing to respect — it was a limit the shape could not fit.
 *
 * 2600 admits every joined length that run recorded, with headroom for the
 * 89 ordering-A units and 99 ordering-B units that were never generated
 * under it. Same direction rule as the plain cap: up only, after a
 * measurement, never down.
 */
export const JOINED_MAX_CHARS = 2600;

/**
 * The closed English vocabulary that must never appear in a generated plain
 * layer — DERIVED from the register enums, never hand-maintained, so it
 * cannot drift on membership.
 *
 * `ClaimStatus` is deliberately excluded: it is never shown to the model and
 * the badge tier owns it. Phase 02's display glossary excludes it on exactly
 * the same grounds, and both sides derive from
 * `lib/register/schema/enums.ts`, so the two lists can differ in scope but
 * never in membership.
 */
export const FORBIDDEN_TOKENS: readonly string[] = Object.freeze([
  ...ClaimType.options,
  ...RelationType.options,
  ...SupportDegree.options,
  ...CalibrationResult.options,
  ...SourceType.options,
]);

/** A verdict value the plain layer may be required to restate. */
export type PlainVerdict =
  z.infer<typeof CalibrationResult> | z.infer<typeof RelationType>;

/**
 * The fixed slot-frame: the exact German sentence opener `reasoning_plain`
 * must begin with, per verdict value.
 *
 * This is a STRUCTURAL constraint, not an instruction — it is what makes
 * "the plain layer names a verdict the technical layer does not" mechanically
 * decidable, which is the strongest available mitigation for the
 * overstatement risk. Each phrase states what was FOUND and never how much
 * to trust it: no certainty words, no reassuring or hedging phrasing.
 *
 * The phrases are terminated with a full stop on purpose. Without it
 * `partially_supports`' phrase would have the `supports` phrase as a prefix,
 * and a plain layer could satisfy the wrong verdict's frame.
 */
export const PLAIN_VERDICT_PHRASE: Readonly<Record<PlainVerdict, string>> =
  Object.freeze({
    licensed: "Die Formulierung passt zu den Belegen.",
    weakened: "Die Formulierung geht über die Belege hinaus.",
    pending_adjudication: "Die Regel lässt sich hier nicht eindeutig anwenden.",
    supports: "Der Auszug trägt die Aussage.",
    partially_supports: "Der Auszug trägt die Aussage nur zum Teil.",
    contradicts: "Der Auszug widerspricht der Aussage.",
    not_relevant: "Der Auszug betrifft die Aussage nicht.",
  });

/**
 * German names of the four evidence-rubric rules, one per claim type.
 *
 * Anchoring the technical layer on the raw English `claim_type` token was the
 * cheaper option and was rejected: it would institutionalise exactly the leak
 * this milestone exists to remediate. Measured over the three real local
 * registers, 19 of 19 stored calibration reasonings contain a raw English
 * enum token while 0 of 57 stored judgments do — because the rubric v1.1.0
 * template states its rules keyed on the raw identifiers and then tells the
 * model to name the rule. The model is doing precisely what it was told.
 * German rule names take that number to zero by construction.
 *
 * These literals also appear verbatim in `prompts/rubric/v1.2.0.md`; the
 * SHA pin does not cover that duplication, so `prompt-templates.test.ts`
 * asserts it.
 */
export const GERMAN_RULE_NAMES: Readonly<Record<ClaimTypeValue, string>> =
  Object.freeze({
    quantitative_finding: "Regel für Zahlenbefunde",
    comparative_statement: "Regel für Vergleichsaussagen",
    effectiveness_statement: "Regel für Wirksamkeitsaussagen",
    recommendation: "Regel für Empfehlungen",
  });

/**
 * The three role-marker literals, duplicated from
 * `lib/pipeline/verification/reasoning-join.ts` (which in turn duplicates
 * `app/projects/reasoning-paragraphs.ts`) because `lib/adapters` may not
 * import `lib/pipeline`. Used here only to reject a field that already
 * carries a marker — joining such a field would emit
 * `Einfach gesagt: Einfach gesagt: …`.
 */
const ROLE_MARKERS = ["Einfach gesagt:", "Jedoch:", "Technisch:"] as const;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ONE alternation, ONE pass — Phase 02's proven construction.
 *
 * Two independent guarantees against the `"partially_supports".includes(
 * "supports")` collision, and both are wanted: descending length offers the
 * longer token first, and the underscore sits INSIDE both boundary classes,
 * so a shorter key cannot match inside a longer token at all.
 *
 * NO `i` FLAG, and this is the whole false-positive defence: German
 * capitalises every noun, so a LOWERCASE `preprint` mid-sentence is an enum
 * echo while `Preprint` is the ordinary German noun. Adding case folding
 * would make the check fire on grammatical German prose, whose failure mode
 * (a retry loop on correct text) is worse than the leak it would catch.
 */
const FORBIDDEN_TOKEN_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])(${[...FORBIDDEN_TOKENS]
    .sort((left, right) => right.length - left.length)
    .map(escapeForRegExp)
    .join("|")})(?![A-Za-z0-9_])`,
  "g",
);

/**
 * Display-tier referents a GENERATED layer must never name: internal ids and
 * bracket citations. Phase 02 resolves those per card from the claim's own
 * evidence; prose that hard-codes them is prose that cannot be re-rendered.
 */
const INTERNAL_REFERENT_PATTERN = /(ev_\d|clm_\d|src_|\[\d+\])/;

/** Digit runs with interior dots or commas — see `normalizeNumber`. */
const NUMBER_PATTERN = /\d+(?:[.,]\d+)*/g;

/**
 * Canonicalises one number token so German and mixed notations compare
 * equal WITHOUT losing precision.
 *
 * A dot is a thousands separator only when exactly three digits follow it
 * and no fourth digit does — so `1.000` becomes `1000` while `3.5` stays
 * `3.5` and still meets a German-written `3,5`. The remaining comma is the
 * decimal separator. Comparison is on these normalised STRINGS rather than
 * on parsed floats, which is what keeps `3,50` and `3,5` distinguishable —
 * "restates" means the same number, not a nearby one.
 */
function normalizeNumber(raw: string): string {
  return raw.replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
}

function numberTokens(text: string): string[] {
  return (text.match(NUMBER_PATTERN) ?? []).map(normalizeNumber);
}

/** The prose fields every two-layer output carries. */
export interface TwoLayerProse {
  readonly reasoning_plain: string;
  readonly caveat: string | null;
  readonly reasoning_technical: string;
}

export interface PlainLanguageContractOptions<T extends TwoLayerProse> {
  /** Reads the verdict value the plain layer must restate, from the SAME
   * object — which is why this check lives on the object, not on a field. */
  readonly verdictOf: (value: T) => PlainVerdict;
  /** Rubric only: require `reasoning_technical` to name a German rule name
   * verbatim. Attribution anchors on the excerpt instead (03-02). */
  readonly requireRuleName: boolean;
}

type Issues = z.core.ParsePayload<unknown>["issues"];

function reject(
  issues: Issues,
  value: unknown,
  field: string,
  message: string,
): void {
  issues.push({ code: "custom", input: value, path: [field], message });
}

/**
 * Builds the object-level check attached to a two-layer output schema.
 *
 * It NEVER raises. A raised exception escapes `safeParse` as a plain
 * `Error`, the orchestrator rethrows any non-`AdapterError` as a programming
 * error, and the whole run dies — instead of the retry the boundary is
 * supposed to produce. Every violation is recorded on the check context, so
 * `safeParse` reports `success: false` and `validateJobOutput` turns it into
 * an `AdapterValidationError` like any other schema failure.
 *
 * Never a transforming schema step either: `validateJobOutput` runs twice on
 * every success (once inside the backend, once in the orchestrator), so a
 * non-idempotent transform would fail its own re-validation on every
 * attempt — three attempts, all "failing", and every claim escalated to
 * adjudication while looking like a model-compliance problem. The
 * prohibition is grep-verified, so this comment deliberately does not spell
 * the method call out.
 */
export function plainLanguageContract<T extends TwoLayerProse>(
  options: PlainLanguageContractOptions<T>,
): z.core.CheckFn<T> {
  return (payload) => {
    const value = payload.value;
    const issues = payload.issues;
    const {
      reasoning_plain: plain,
      caveat,
      reasoning_technical: technical,
    } = value;

    for (const [field, text] of [
      ["reasoning_plain", plain],
      ["caveat", caveat],
      ["reasoning_technical", technical],
    ] as const) {
      if (text === null) {
        continue;
      }
      if (/\n{2,}/.test(text)) {
        reject(
          issues,
          value,
          field,
          "darf keine Leerzeile enthalten — ein Absatzumbruch im Feld " +
            "erzeugt beim Zusammenfügen einen Absatz ohne Rollenmarker",
        );
      }
      const marker = ROLE_MARKERS.find((candidate) =>
        text.startsWith(candidate),
      );
      if (marker !== undefined) {
        reject(
          issues,
          value,
          field,
          `darf nicht mit dem Rollenmarker "${marker}" beginnen — die ` +
            "Marker setzt die Pipeline, nicht das Modell",
        );
      }
    }

    for (const [field, text] of [
      ["reasoning_plain", plain],
      ["caveat", caveat],
    ] as const) {
      if (text === null) {
        continue;
      }
      const matches = [...text.matchAll(FORBIDDEN_TOKEN_PATTERN)].map(
        (match) => match[2],
      );
      if (matches.length > 0) {
        // The LONGEST match, because this message is what the model reads on
        // retry: naming `supports` where the text said `partially_supports`
        // would send it looking for a token that is not there.
        const longest = matches.reduce((left, right) =>
          right.length > left.length ? right : left,
        );
        reject(
          issues,
          value,
          field,
          `enthält den englischen Fachbegriff "${longest}" — die einfache ` +
            "Ebene wird in deutscher Prosa ohne Bezeichner geschrieben",
        );
      }
      if (INTERNAL_REFERENT_PATTERN.test(text)) {
        reject(
          issues,
          value,
          field,
          "enthält eine interne Kennung oder eine Klammerziffer — solche " +
            "Verweise setzt die Anzeige, nicht der Text",
        );
      }
    }

    // The length clauses run BEFORE the number tokeniser: bounding the input
    // is what keeps the tokeniser's nested quantifier cheap in practice.
    const plainWithinCap = plain.length <= PLAIN_MAX_CHARS;
    if (!plainWithinCap) {
      reject(
        issues,
        value,
        "reasoning_plain",
        `darf höchstens ${PLAIN_MAX_CHARS} Zeichen lang sein, hat aber ` +
          `${plain.length} — die einfache Ebene ist eine Verdichtung, kein ` +
          "zweiter Aufsatz",
      );
    }
    if (plain.length > technical.length) {
      reject(
        issues,
        value,
        "reasoning_plain",
        "darf nicht länger sein als die fachliche Ebene",
      );
    }
    const joinedLength =
      plain.length + (caveat?.length ?? 0) + technical.length;
    if (joinedLength > JOINED_MAX_CHARS) {
      reject(
        issues,
        value,
        "reasoning_technical",
        `alle drei Textfelder zusammen dürfen höchstens ${JOINED_MAX_CHARS} ` +
          `Zeichen lang sein, sind aber ${joinedLength}`,
      );
    }

    if (plainWithinCap) {
      // ONE direction only. The technical layer may carry numbers the plain
      // layer omits — that is compression, and it is the point. The reverse
      // is a new fact the judgment never established.
      const technicalNumbers = new Set(numberTokens(technical));
      const missing = numberTokens(plain).filter(
        (token) => !technicalNumbers.has(token),
      );
      if (missing.length > 0) {
        reject(
          issues,
          value,
          "reasoning_plain",
          `nennt die Zahl "${missing[0]}", die in der fachlichen Ebene ` +
            "nicht vorkommt — die einfache Ebene gibt wieder, sie urteilt " +
            "nicht neu",
        );
      }
    }

    const expectedPhrase = PLAIN_VERDICT_PHRASE[options.verdictOf(value)];
    if (!plain.startsWith(expectedPhrase)) {
      reject(
        issues,
        value,
        "reasoning_plain",
        `muss mit "${expectedPhrase}" beginnen — die einfache Ebene gibt ` +
          "genau das Ergebnis wieder, das dieses Objekt trägt",
      );
    }

    if (
      options.requireRuleName &&
      !Object.values(GERMAN_RULE_NAMES).some((name) => technical.includes(name))
    ) {
      reject(
        issues,
        value,
        "reasoning_technical",
        "muss eine der vier Regelbezeichnungen wörtlich nennen: " +
          Object.values(GERMAN_RULE_NAMES).join(", "),
      );
    }
  };
}

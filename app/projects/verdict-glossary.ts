import type {
  CalibrationResult,
  ClaimType,
  RelationType,
  SourceType,
  SupportDegree,
} from "@/lib/register";

/**
 * Display-tier remediation for verdict prose ALREADY STORED in the register
 * (PROSE-02, PROSE-03, PROSE-05).
 *
 * Why it exists: `buildVars` hands the verifier `claim_json` (carrying
 * `claim_type`) and `evidence_json` (carrying `id: "ev_NNNN"` and
 * `source_type`), and the attribution/rubric prompt bodies enumerate the
 * `relation_type` / `calibration_result` literals in English. Those are
 * exactly the tokens a model echoes back into its German `reasoning`. The
 * register is append-only, so the prose cannot be rewritten — only rendered
 * differently.
 *
 * Where it may run: at the paragraph element, and NOWHERE earlier. Its
 * output is never persisted, never fed to a prompt and never exported.
 * `ClaimCard` passes the `Claim` straight into `RepairPanel`, whose form
 * posts text into `applyRepair` and the append-only chain — Germanizing
 * anything upstream of that paragraph would write display copy into the
 * register. The module lives in `app/` for the same reason
 * `lib/register/projection/status-display.ts` documents its duplication of
 * `app/projects/status-labels.ts`: the architecture test forbids `lib/**`
 * from importing `app/**`, so placement alone makes the leak impossible.
 *
 * This is a remediation, not the primary mechanism. The primary mechanism is
 * the prompt, which stops producing the tokens in the first place. Do not
 * lean on this module harder than that framing allows: only CLOSED
 * vocabularies can be substituted deterministically, and open jargon
 * („Belegbasis", „unqualifizierte Formulierung") is explicitly out of reach
 * here.
 */

/**
 * Keys of the SE evidence rubric's per-claim-type rules
 * (`lib/pipeline/verification/rules/se-evidence-rubric-v1.json`).
 *
 * These four are DEAD VOCABULARY today and that is deliberate, not an
 * oversight: the rubric prompt states its rules in German prose rather than
 * embedding the rule JSON, so no model is currently shown them and no stored
 * reasoning can contain them. They are listed because the milestone names
 * the rubric rule keys as part of the closed vocabulary this module owns,
 * and because a future prompt version that DOES embed the rule set would
 * otherwise leak them silently. A later reader who finds them unreferenced
 * is looking at a safety net, not at dead code to delete.
 */
export type RubricRuleKey =
  | "min_pertinent_sources"
  | "required_source_types_any"
  | "min_source_type_diversity"
  | "insufficient_if_only";

/**
 * Every closed vocabulary that can reach stored verdict prose.
 *
 * `ClaimStatus` is deliberately ABSENT: it is never shown to the verifier,
 * and the badge tier already owns it (`STATUS_LABELS`). Note also that
 * `pending_adjudication` enters this union through `CalibrationResult`
 * alone — `enums.ts` documents the ClaimStatus/CalibrationResult overlap as
 * deliberate, so typing the map over `ClaimStatus` as well would mean that
 * dropping `ClaimStatus` later silently drops that key too.
 */
export type VerdictProseKey =
  | ClaimType
  | RelationType
  | SupportDegree
  | CalibrationResult
  | SourceType
  | RubricRuleKey;

/**
 * German prose forms of the closed vocabularies — **not** the badge labels
 * of `status-labels.ts`, and never to be merged with them.
 *
 * The one distinction that matters: these values are SENTENCE-INSERTABLE
 * (participles and nouns). `CALIBRATION_LABELS.weakened` is the infinitive
 * „abschwächen", which is a fine button-ish label and ungrammatical inside a
 * sentence („Das Ergebnis ist abschwächen."); here `weakened` is
 * „abgeschwächt". Same for `STATUS_LABELS.pending_adjudication` („zur
 * manuellen Überprüfung"), a prepositional phrase that cannot take an
 * article. Two maps, two purposes — do not spread one into the other.
 *
 * Accepted limitation (deliberate, do not try to fix it): the surrounding
 * article stays wrong sometimes — „der comparative_statement" becomes „der
 * Vergleichsaussage", which is the wrong article for a feminine noun. The
 * substitution has no syntactic knowledge and inflection is not worth
 * attempting; the real fix is the prompt, which stops emitting the token.
 *
 * No value here may be a certainty word, a reassurance or a hedge: the
 * display states WHAT was found, never HOW MUCH to trust it (Buçinca et al.,
 * CSCW 2021 — explanations do not reduce overreliance and may increase it).
 */
export const VERDICT_PROSE: Record<VerdictProseKey, string> = {
  // ClaimType
  quantitative_finding: "quantitativer Befund",
  comparative_statement: "Vergleichsaussage",
  effectiveness_statement: "Wirksamkeitsaussage",
  recommendation: "Empfehlung",
  // RelationType
  supports: "stützt",
  partially_supports: "stützt teilweise",
  contradicts: "widerspricht",
  not_relevant: "nicht einschlägig",
  // SupportDegree
  supported: "gestützt",
  partially_supported: "teilweise gestützt",
  unsupported: "nicht gestützt",
  uncertain: "unklar",
  // CalibrationResult
  licensed: "gedeckt",
  weakened: "abgeschwächt",
  pending_adjudication: "zur manuellen Prüfung vorgelegt",
  // SourceType
  peer_reviewed_publication: "begutachtete Publikation",
  preprint: "Preprint",
  grey_literature: "Grauliteratur",
  vendor_documentation: "Herstellerdokumentation",
  // SE evidence rubric rule keys
  min_pertinent_sources: "Mindestzahl einschlägiger Quellen",
  required_source_types_any: "geforderter Quellentyp",
  min_source_type_diversity: "Mindestvielfalt der Quellentypen",
  insufficient_if_only: "allein nicht ausreichend",
};

/**
 * One piece of evidence OF THE CLAIM BEING RENDERED, as the referent
 * resolution needs it.
 *
 * `number` is the global bracket number `buildBriefingViewModel` assigned
 * (positionally aligned with `claim.evidence`), `citation` the source's
 * formatted citation, `verbatimExcerpt` the frozen wording — which is
 * protected from substitution rather than substituted.
 */
export interface VerdictProseEvidence {
  id: string;
  number: number | undefined;
  citation: string | undefined;
  verbatimExcerpt: string;
}

/**
 * The quote-mark vocabulary, RESTATED from
 * `lib/register/text/normalize.ts` rather than imported: `app/**` may not
 * runtime-import `lib/register`, and `formatModel` in `status-labels.ts`
 * restates its `"unknown"` sentinel for exactly the same reason. These are
 * the code points that file folds — the ASCII `"` and `'` are its fold
 * TARGETS, not delimiters, which is what keeps an ordinary ASCII apostrophe
 * ("don't") from being read as an unterminated quotation.
 */
const DOUBLE_QUOTE_MARKS = "„“”«»‟";
const SINGLE_QUOTE_MARKS = "‚‘’‹›‛";

/**
 * Marks that unambiguously OPEN a run in some convention. Seeing one while a
 * run of the same family is already open means the quotation is nested, and
 * this module refuses rather than guessing. The remaining marks („“", „”",
 * „»", „‘", „’", „›") are ambiguous — they open or close depending on the
 * typographic convention — so while a run is open they are read as its
 * closer.
 */
const DIRECTIONAL_OPENERS = "„«‟‚‹‛";

/**
 * Above this many quoted runs in one reasoning the structure is not a
 * quotation pattern any more and the segmentation is not trustworthy.
 */
const MAX_QUOTED_RUNS = 8;

type Interval = readonly [start: number, end: number];

function quoteFamily(character: string): string | null {
  if (DOUBLE_QUOTE_MARKS.includes(character)) {
    return "double";
  }
  if (SINGLE_QUOTE_MARKS.includes(character)) {
    return "single";
  }
  return null;
}

/**
 * Intervals of `text` that must never be substituted inside, or `null` when
 * the quote structure is ambiguous and the whole string must be left alone.
 *
 * The asymmetry is the whole design and it must survive future edits: an
 * unsubstituted English token is a COSMETIC defect; a rewritten quotation is
 * an INTEGRITY defect. This tool's value proposition is „der eingefrorene
 * Wortlaut" — a reasoning that quotes a phrase the linked snapshot does not
 * contain is a lie printed next to the link that disproves it. The obvious
 * later "fix" is to substitute anyway. Do not.
 */
function protectedIntervals(
  text: string,
  evidence: readonly VerdictProseEvidence[],
): Interval[] | null {
  const intervals: Interval[] = [];
  let openIndex: number | null = null;
  let openFamily: string | null = null;
  let runs = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const family = quoteFamily(character);
    if (family === null) {
      continue;
    }
    if (openIndex === null) {
      openIndex = index;
      openFamily = family;
      continue;
    }
    if (family !== openFamily) {
      continue; // a mark of the other family is content inside a quotation
    }
    if (DIRECTIONAL_OPENERS.includes(character)) {
      return null; // nested quotation — refuse
    }
    intervals.push([openIndex, index + 1]);
    openIndex = null;
    openFamily = null;
    runs += 1;
    if (runs > MAX_QUOTED_RUNS) {
      return null;
    }
  }
  if (openIndex !== null) {
    return null; // unterminated quotation — refuse
  }

  // Belt and braces: a span equal to one of THIS claim's frozen excerpts is
  // protected even when it carries no quote marks. Cheap here because the
  // evidence is already on the card.
  for (const item of evidence) {
    const excerpt = item.verbatimExcerpt;
    if (excerpt.length === 0) {
      continue;
    }
    let from = text.indexOf(excerpt);
    while (from !== -1) {
      intervals.push([from, from + excerpt.length]);
      from = text.indexOf(excerpt, from + excerpt.length);
    }
  }

  return intervals;
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The stable referent for an evidence id.
 *
 * The bracket carries the AFFORDANCE (it ties the sentence to the evidence
 * card and to `marker.evidenceNumbers`); the citation carries the MEANING.
 * That split is the point: `buildBriefingViewModel` numbers evidence
 * GLOBALLY in deterministic claim order, so the bracket of an immutable,
 * hash-chained sentence changes whenever an earlier claim is inserted,
 * re-anchored or extended. The citation does not. A rendering that named
 * only the bracket would silently rewrite the meaning of an archived audit
 * statement, and two exports taken at different times would disagree.
 */
function formatReferent(item: VerdictProseEvidence): string {
  if (item.number !== undefined && item.citation !== undefined) {
    return `[${item.number}] (${item.citation})`;
  }
  if (item.number !== undefined) {
    return `[${item.number}]`;
  }
  if (item.citation !== undefined) {
    return `(${item.citation})`;
  }
  return item.id;
}

/**
 * Renders one stored reasoning (or history reason) for display: closed
 * vocabularies as German prose, this claim's evidence ids as their stable
 * referent, everything else — quotations above all — byte-identical.
 *
 * Pure. Takes the claim's evidence, never a `Claim`: it CANNOT mutate an
 * object that flows onward into `RepairPanel` → `applyRepair` → the
 * append-only chain. Widening this signature to accept a `Claim` is the one
 * change that would break that guarantee.
 */
export function substituteVerdictProse(
  text: string,
  evidence: readonly VerdictProseEvidence[],
): string {
  const intervals = protectedIntervals(text, evidence);
  if (intervals === null) {
    return text;
  }

  const byId = new Map(evidence.map((item) => [item.id, item]));
  // The id branch is built from THIS claim's ACTUAL ids, not from a pattern
  // over the `ev_` prefix. Claim scoping is therefore structural: an id
  // belonging to another claim never enters the regex, so there is no code
  // path in which it could be resolved to a wrong bracket number. (A wrong
  // [n] is worse than a raw token.) It also sidesteps the question of how
  // wide the register's `EvidenceId` primitive really is.
  const tokens = [...byId.keys(), ...Object.keys(VERDICT_PROSE)]
    .sort((left, right) => right.length - left.length)
    .map(escapeForRegExp);
  if (tokens.length === 0) {
    return text;
  }

  // ONE alternation, ONE pass. Two independent guarantees against the
  // `"partially_supports".includes("supports")` collision, and both are
  // wanted: descending length offers the longer key first, and the
  // underscore inside the boundary class means the shorter key cannot match
  // inside the longer token at all. Single-pass replacement is also what
  // makes idempotency structural rather than hopeful — no output of one
  // substitution can become the input of another.
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])(${tokens.join("|")})(?![A-Za-z0-9_])`,
    "g",
  );

  return text.replace(pattern, (match, prefix: string, token: string, at) => {
    const start = (at as number) + prefix.length;
    const end = start + token.length;
    const isProtected = intervals.some(
      ([from, to]) => start < to && end > from,
    );
    if (isProtected) {
      return match;
    }
    const referent = byId.get(token);
    if (referent !== undefined) {
      return `${prefix}${formatReferent(referent)}`;
    }
    return `${prefix}${VERDICT_PROSE[token as VerdictProseKey]}`;
  });
}

/**
 * The scenarios the corpus is recorded for.
 *
 * This file is the "what": which works a briefing cites, and what the
 * outside world is expected to answer about each. The cassettes under
 * `http/` and `llm/` are the "how it actually answered". Keeping the two
 * apart is what lets `npm run corpus:record` replace every answer with a
 * real one without touching a single spec.
 *
 * The identifiers are real, taken from the thesis's own literature search
 * (`identifiers/ids_*.txt`, `identifiers/korpus-manifest.csv`,
 * `identifiers/exclusion-log-2026-07-26.md`) rather than invented. That
 * matters for more than authenticity: real DOIs from ACL Anthology, IEEE and
 * arXiv have shapes — embedded years, dots, slashes, `v1` path segments —
 * that hand-written fixtures reliably fail to imitate, and several of the
 * parsing rules under test are exactly about telling those shapes apart.
 */

/** How the world is expected to answer for one cited work. */
export interface ScenarioSource {
  /** Stable handle used by specs and by the seeder. */
  readonly label: string;
  readonly kind: "doi" | "arxiv";
  /** The identifier exactly as it appears in the briefing prose. */
  readonly identifier: string;
  /** Canonical identifier after normalization. */
  readonly canonical: string;
  /** Title the briefing attributes to this identifier. */
  readonly citedTitle: string;
  /** Title the resolver actually answers with. Differs from `citedTitle`
   * for the misattribution case — that difference IS the failure class. */
  readonly resolvedTitle: string | null;
  readonly authors: readonly string[];
  readonly year: number;
  /** Text the frozen document contains, and which a claim quotes. */
  readonly documentText?: string;
  readonly note: string;
}

/**
 * Real work from the frozen thesis corpus (`korpus-manifest.csv`, 18 pages).
 * The clean path: identifier resolves, arXiv determines the PDF URL without
 * a further lookup, the quote is in the document.
 */
export const SOURCE_AUDIT_TRAILS: ScenarioSource = {
  label: "audit-trails",
  kind: "arxiv",
  identifier: "arXiv:2601.20727",
  canonical: "2601.20727",
  citedTitle: "Audit Trails for Accountability in Large Language Models",
  resolvedTitle: "Audit Trails for Accountability in Large Language Models",
  authors: ["Rivera", "Nakamura"],
  year: 2026,
  documentText:
    "Every accountability claim requires an append-only record: the median " +
    "audit reconstruction time fell from 42 to 19 minutes once the register " +
    "was hash-chained.",
  note: "korpus-manifest.csv, sha256 4e2243…, 18 pages — the happy path.",
};

/**
 * Real ACL Anthology DOI from `ids_a_chatgpt.txt`. Here the resolver answers
 * with a DIFFERENT work than the briefing attributes to it — the
 * misattribution the identity cross-check exists to catch. This is the
 * failure class the thesis is built around, and the one with the least real
 * coverage today.
 */
export const SOURCE_MISATTRIBUTED: ScenarioSource = {
  label: "misattributed",
  kind: "doi",
  identifier: "10.18653/v1/2024.inlg-main.35",
  canonical: "10.18653/v1/2024.inlg-main.35",
  citedTitle: "Claim-Level Verification of Generated Scientific Summaries",
  resolvedTitle:
    "Referring Expression Generation in Visually Grounded Dialogue",
  authors: ["Willemsen", "Skantze"],
  year: 2024,
  note: "Real DOI, real resolved title; the cited title is the misattribution.",
};

/**
 * From the archived exclusion log: an identifier that does not resolve.
 *
 * Worth stating precisely, because the thesis corrected the record on this
 * point. The methodology appendix (§Verifikation und Erfassung) reports that
 * every entry in that log traced back to a defect in the ingest tool —
 * arXiv patterns wrongly extracted from DOI strings — and that after the fix
 * the rate of genuinely fabricated references was ZERO. So this is not a
 * hallucination fixture. It is a real, observed shape of "identifier that
 * resolves to nothing", which is what the capture-failure path handles, and
 * the parser defect it actually came from is covered separately by
 * `identifier-corpus.test.ts`.
 */
export const SOURCE_UNRESOLVABLE: ScenarioSource = {
  label: "unresolvable",
  kind: "arxiv",
  identifier: "arXiv:6598.37140",
  canonical: "6598.37140",
  citedTitle: "Evidence Gates for Automated Literature Reviews",
  resolvedTitle: null,
  authors: ["Hoffmann"],
  year: 2025,
  note: "exclusion-log-2026-07-26.md — arXiv answers an empty feed.",
};

/**
 * The same misattribution as SOURCE_MISATTRIBUTED, cited the OTHER way: title
 * and identifier in one sentence, no footnote. Real DOI from
 * `ids_b_chatgpt.txt`.
 *
 * It exists because the citation STYLE decided whether the guard ran at all.
 * The regex channel reads identifiers but no titles, so a candidate's title
 * came from its footnote — and prompt v1.0.0 told the model not to report a
 * citation the regex channel had already found, which is every inline one.
 * A parenthetical citation therefore reached the cross-check with no title
 * and was waved through, pre-selected for automatic capture. Both styles
 * occur in real deep-research output. Keeping one of each is the point: the
 * footnote path above proves the original mechanism still works, this one
 * proves the guard no longer depends on which style the briefing happens to
 * use.
 *
 * A DOI, deliberately, because that is the shape the fixture can carry end
 * to end. The identifier KIND matters separately: an arXiv id is detected
 * with its "arXiv:" prefix but stored bare, so recognizing the model's echo
 * of one is a canonicalization problem the DOI case never exercises. That
 * half is pinned in `dedup-identified.test.ts` rather than here.
 */
export const SOURCE_MISATTRIBUTED_INLINE: ScenarioSource = {
  label: "misattributed-inline",
  kind: "doi",
  identifier: "10.1007/s10664-023-10288-w",
  canonical: "10.1007/s10664-023-10288-w",
  citedTitle: "Automated Evidence Retrieval for Systematic Reviews",
  resolvedTitle: "On the Reproducibility of Software Defect Prediction Studies",
  authors: ["Lindholm"],
  year: 2023,
  note: "Real DOI, real journal; the cited title is the misattribution. Cited inline, not by footnote.",
};

export const SCENARIO_SOURCES: readonly ScenarioSource[] = [
  SOURCE_AUDIT_TRAILS,
  SOURCE_MISATTRIBUTED,
  SOURCE_MISATTRIBUTED_INLINE,
  SOURCE_UNRESOLVABLE,
];

/**
 * A citation the briefing makes in prose only, with no identifier anywhere —
 * the shape that reaches the LLM channel and then Crossref's title search.
 */
export const CITATION_WITHOUT_IDENTIFIER = {
  title: "Interaktive Prüfoberflächen für generierte Zusammenfassungen",
  authors: ["Braun", "Kohl"],
  year: 2024,
  rawText:
    "Ergänzend wird ein interaktives Prüf-Interface beschrieben " +
    "(Braun & Kohl 2024).",
} as const;

/** The footnote definition line for one scenario source, as a real briefing
 * writes it: title, then the identifier. */
function footnote(marker: string, source: ScenarioSource): string {
  return `[^${marker}]: ${source.citedTitle}. ${source.identifier}`;
}

export const FOOTNOTES = {
  auditTrails: footnote("1", SOURCE_AUDIT_TRAILS),
  misattributed: footnote("2", SOURCE_MISATTRIBUTED),
  unresolvable: footnote("3", SOURCE_UNRESOLVABLE),
} as const;

/**
 * The briefing the specs freeze. German, because that is what the product's
 * display tier and its prompts are; Markdown with one checkable statement
 * per paragraph, because that is the shape extraction expects.
 *
 * BOTH citation styles, and that is not cosmetic. Elicit and Perplexity cite
 * each source twice — an inline marker in the prose and a footnote definition
 * carrying the title — and the scan leaned on it: the regex channel reads
 * identifiers but no titles, so a candidate's title came from its footnote,
 * and prompt v1.0.0 told the model not to report a citation the regex
 * channel had already found. A parenthetical citation therefore reached the
 * identity cross-check with no title to compare a resolved identifier
 * against, and the guard that catches a misattributed DOI did not run at all
 * — it was silently a footnote-only feature.
 *
 * This fixture used footnotes exclusively, which is exactly how that
 * survived: a hand-written briefing agreed with the code about what a
 * citation looks like. It now carries one misattribution of each style
 * (`[^2]` and the inline `SOURCE_MISATTRIBUTED_INLINE`), so a regression in
 * either path fails a spec.
 *
 * The last paragraph cites nothing — the unevidenced claim that has to reach
 * adjudication rather than quietly disappear.
 */
export const SCENARIO_BRIEFING = [
  "# Prüfbarkeit LLM-recherchierter Briefings",
  "Ein manipulationssicheres Register verkürzt die Rekonstruktion einer " +
    "Prüfentscheidung erheblich: Die mediane Rekonstruktionszeit sank von 42 " +
    "auf 19 Minuten, nachdem der Nachweis als Hash-Kette geführt wurde.[^1]",
  "Für die Prüfung einzelner Aussagen generierter Zusammenfassungen liegt " +
    "eine eigene Arbeit vor.[^2]",
  "Evidenzschranken für automatisierte Literaturübersichten werden " +
    "ebenfalls diskutiert.[^3]",
  // Parenthetical: title and identifier in one sentence, no footnote marker.
  // The style whose candidates used to reach the cross-check titleless.
  `Zur automatisierten Beschaffung von Belegstellen liegt eine Übersicht ` +
    `vor (${SOURCE_MISATTRIBUTED_INLINE.citedTitle}, ` +
    `doi:${SOURCE_MISATTRIBUTED_INLINE.identifier}).`,
  CITATION_WITHOUT_IDENTIFIER.rawText,
  "Langfristig verbessert sich dadurch die Qualität der Ergebnisse.",
  [FOOTNOTES.auditTrails, FOOTNOTES.misattributed, FOOTNOTES.unresolvable].join(
    "\n",
  ),
].join("\n\n");

/** Document URL the arXiv resolution determines for the clean source. */
export const AUDIT_TRAILS_PDF_URL = `https://arxiv.org/pdf/${SOURCE_AUDIT_TRAILS.canonical}`;

/** Name of the clean source's PDF in `documents.json`. */
export const AUDIT_TRAILS_DOCUMENT = "arxiv-2601.20727.pdf";

/**
 * A quote that occurs verbatim in the frozen document, and one that does
 * not. Stage 1 has to separate these two deterministically, and the
 * separation is the product's central claim.
 */
export const QUOTE_PRESENT =
  "the median audit reconstruction time fell from 42 to 19 minutes";
export const QUOTE_ABSENT =
  "audit trails reduce reconstruction effort by more than eighty percent";

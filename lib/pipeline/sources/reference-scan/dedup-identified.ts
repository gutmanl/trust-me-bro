import type { ParsedReference } from "../../../adapters";
import { normalizeArxivId, normalizeDoi } from "../identifiers";

/**
 * Drops LLM-parsed references that re-report a citation the regex channel
 * already found by its identifier (reference auto-import).
 *
 * The case, seen on real briefings: a paragraph both links its source inline
 * ("… Quelle: https://…/paper [^1]") — which the DOI/arXiv/URL regex turns
 * into a candidate — AND discusses it in prose ("Harel et al. schreiben: …"),
 * which the LLM extracts as a SEPARATE citation and Crossref then resolves to
 * a DOI. The two describe one work but carry different identifiers (the
 * pasted URL vs. the Crossref DOI), so mergeCandidates — which only collapses
 * identical identifiers — keeps both, and the same paper is suggested twice.
 *
 * A parsed reference is dropped when it carries an identifier span itself, or
 * when (almost) all of its word tokens appear in one already-covered text
 * block. The caller supplies those blocks (run-reference-scan.ts): the
 * briefing paragraphs that carry an inline identifier, AND the footnote
 * definitions already claimed by an inline identifier — so a re-report is
 * caught whether the model copied the prose or the footnote entry, which live
 * in different paragraphs joined only by the marker.
 *
 * Word-token containment, not substring, because the model reformats what it
 * copies (typographic vs. straight quotes, em-dashes, dropped parentheticals).
 * A genuinely different citation — sharing only incidental words — keeps its
 * distinctive author/title tokens and survives.
 *
 * ONE re-report is wanted and kept: the one whose own identifier is a
 * KNOWN one (prompt v1.1.0 asks the model to report the already-detected
 * citations too, with the bibliographic detail the regex channel cannot
 * read). It carries the title an identified seed otherwise lacks, and it
 * cannot duplicate anything — sharing an identifier means mergeCandidates
 * collapses the two by identity key, filling the regex seed's empty
 * title/authors/year from it. Without a title the identity cross-check has
 * nothing to compare a resolved identifier against and never runs, which is
 * what left inline citations unchecked. The duplicate this module exists to
 * stop is the OTHER shape — the same work re-reported under a DIFFERENT
 * identifier (a pasted URL vs. the Crossref DOI), which no merge collapses.
 */

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

/** Fraction of a reference's tokens that must appear in an identified
 * paragraph for it to count as "the same citation". Below 1 to tolerate a
 * stray token the model added. */
const CONTAINMENT_THRESHOLD = 0.8;
/** Below this many tokens a containment ratio is too noisy to trust. */
const MIN_TOKENS = 3;

/**
 * One identifier reduced to the form both sides can be compared in, through
 * the same normalizers the capture path uses.
 *
 * Raw string equality would not do. The regex channel stores an arXiv id
 * canonically ("2601.20727") while the span it detected carries the prefix
 * the briefing wrote ("arXiv:2601.20727"), and the model echoes back
 * whatever shape it read — bare, prefixed, or a resolver URL. Comparing the
 * surface forms would therefore miss every arXiv citation and drop the
 * enrichment, reopening exactly the gap this keep-rule exists to close, for
 * one identifier kind only and without any test noticing.
 */
function canonicalIdentifier(value: string): string {
  const canonical = normalizeDoi(value) ?? normalizeArxivId(value) ?? value;
  return canonical.trim().toLowerCase();
}

/** Whether the reference's OWN identifier is one the regex channel already
 * found — the enrichment case, which merges rather than duplicates. Compared
 * on the identifier fields, not on the raw text: the model echoes the
 * identifier into the field it belongs in, while raw_text is the citation as
 * written and may quote a neighbouring one. */
function echoesKnownIdentifier(
  reference: ParsedReference,
  knownIdentifiers: ReadonlySet<string>,
): boolean {
  return [reference.doi, reference.arxiv_id, reference.url].some(
    (value) =>
      value !== undefined &&
      value.length > 0 &&
      knownIdentifiers.has(canonicalIdentifier(value)),
  );
}

export function dropAlreadyIdentified(
  references: readonly ParsedReference[],
  coveredTexts: readonly string[],
  identifierSpans: readonly string[],
  knownIdentifiers: readonly string[] = [],
): ParsedReference[] {
  const spans = identifierSpans.map((span) => span.toLowerCase());
  const known = new Set(
    knownIdentifiers.map((value) => value.trim().toLowerCase()),
  );
  const coveredTokenSets = coveredTexts.map((text) => new Set(tokenize(text)));

  return references.filter((reference) => {
    if (echoesKnownIdentifier(reference, known)) {
      return true; // enrichment, not duplication — see the module comment
    }
    const lower = reference.raw_text.toLowerCase();
    if (spans.some((span) => span.length > 0 && lower.includes(span))) {
      return false; // the reference text carries the identifier itself
    }
    const tokens = tokenize(reference.raw_text);
    if (tokens.length < MIN_TOKENS) {
      return true; // too little to judge — keep it
    }
    const reReport = coveredTokenSets.some((covered) => {
      const present = tokens.filter((token) => covered.has(token)).length;
      return present / tokens.length >= CONTAINMENT_THRESHOLD;
    });
    return !reReport;
  });
}

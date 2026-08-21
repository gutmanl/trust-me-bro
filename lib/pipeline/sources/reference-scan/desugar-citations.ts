import type { BibtexEntry } from "./bibtex";
import { bestIdentifier, parseBibtex } from "./bibtex";

/**
 * Import-time desugaring of Pandoc citations (BibTeX support).
 *
 * A thesis chapter cites with BibTeX keys — `[@deepfact2026]`,
 * `[@a; @b]` — which say nothing to the reference scan: that scan finds
 * inline DOIs, `arXiv:` ids and URLs (scan-regex.ts) plus Markdown footnote
 * definitions (footnotes.ts). This transform closes the gap in ONE place, at
 * import, BEFORE the briefing is frozen: every cited key becomes a footnote
 * marker `[^key]`, and one footnote definition per cited key is appended
 * carrying the title and the best identifier the `.bib` knows.
 *
 * The output is therefore exactly the convention real briefings (Elicit,
 * Perplexity) already use, which is the whole point of doing it here rather
 * than as a new scan channel: nothing downstream — regex channel, footnote
 * channel, dedup, capture, extraction prompts — has to learn about BibTeX,
 * and the `.bib` itself is never persisted, so no register schema moves.
 *
 * Pure and deterministic; no I/O.
 */

export interface CitationRewriteReport {
  /** One-line German summary of the rewrite, for the import result. */
  summary: string;
  /** German detail lines: skipped `.bib` entries, unresolved keys. Empty
   * when everything resolved cleanly. */
  notes: string[];
  /** Entries the `.bib` yielded. */
  entryCount: number;
  /** Citations (bracket spans) that were rewritten. */
  rewrittenCitationCount: number;
  /** Keys that got a footnote definition, in first-citation order. */
  footnoteKeys: string[];
  /** Keys cited by the text but absent from the `.bib`; left untouched. */
  unresolvedKeys: string[];
}

export interface BriefingCitationRewrite {
  /** The rewritten briefing — this is what gets frozen. */
  text: string;
  report: CitationRewriteReport;
}

/**
 * A Pandoc citation: a bracket span that contains at least one `@key`.
 * Deliberately bracket-scoped — the in-text form (`@key showed …`) is NOT
 * rewritten, because a bare `@` in running prose is far more often a handle
 * or an e-mail than a citation, and a briefing is user prose.
 */
const CITATION_SPAN = /\[[^\[\]]*@[^\[\]]*\]/gu;
/** One key inside such a span, with Pandoc's optional author suppression. */
const CITATION_KEY = /-?@([A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*)/gu;

/**
 * pandoc-crossref namespaces. `[-@sec:einleitung]` is a cross-reference to a
 * section of the same document, not a citation: it must survive the rewrite
 * untouched AND must not be reported as an unresolved key, or every thesis
 * chapter would arrive with a page of false "not found in the bibliography"
 * noise.
 */
const CROSSREF_NAMESPACES = new Set([
  "sec",
  "fig",
  "tbl",
  "eq",
  "lst",
  "def",
  "thm",
  "lem",
  "cor",
  "prop",
  "exm",
  "exr",
]);

/** Labels the briefing already uses, as a marker or as a definition. */
const EXISTING_MARKER = /\[\^([^\]]+)\]/gu;
const EXISTING_DEFINITION = /^\[\^([^\]]+)\]:/u;

/** Parses a `.bib` and rewrites the briefing in one step. */
export function desugarBriefingCitations(
  briefingText: string,
  bibtexSource: string,
): BriefingCitationRewrite {
  const parsed = parseBibtex(bibtexSource);
  return desugarCitations(briefingText, parsed.entries, parsed.warnings);
}

/**
 * Rewrites `[@key]` citations into footnote markers and appends the matching
 * definitions.
 *
 * A key cited but missing from the `.bib` is deliberately left as written —
 * turning it into a footnote marker with no definition would produce a
 * dangling reference the scan would then chase, and dropping it would erase
 * a citation the author made. It is reported instead. A bracket that mixes
 * both kinds keeps the unresolved half as its own `[@key]` citation right
 * behind the markers, so neither property is traded for the other.
 */
export function desugarCitations(
  briefingText: string,
  entries: readonly BibtexEntry[],
  parserWarnings: readonly string[] = [],
): BriefingCitationRewrite {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const citedKeys: string[] = [];
  const unresolved = new Set<string>();
  let rewrittenCitationCount = 0;

  // Pass 1: which keys does the text actually cite? The labels have to be
  // known — and checked for collisions — before a single marker is written,
  // because the collision guard prefixes ALL generated labels or none.
  for (const span of briefingText.matchAll(CITATION_SPAN)) {
    for (const key of keysIn(span[0])) {
      if (byKey.has(key)) {
        if (!citedKeys.includes(key)) {
          citedKeys.push(key);
        }
      } else {
        unresolved.add(key);
      }
    }
  }

  const label = labelling(briefingText, citedKeys);

  // Pass 2: the rewrite itself.
  const rewritten = briefingText.replace(CITATION_SPAN, (span) => {
    const keys = keysIn(span);
    const resolved = keys.filter((key) => byKey.has(key));
    if (resolved.length === 0) {
      return span;
    }
    rewrittenCitationCount += 1;
    const markers = resolved.map((key) => `[^${label(key)}]`).join("");
    const missing = keys.filter((key) => !byKey.has(key));
    return missing.length === 0
      ? markers
      : `${markers}[${missing.map((key) => `@${key}`).join("; ")}]`;
  });

  const definitions = citedKeys.map((key) => {
    const entry = byKey.get(key) as BibtexEntry;
    return `[^${label(key)}]: ${definitionText(entry)}`;
  });
  const text =
    definitions.length === 0
      ? rewritten
      : `${rewritten.replace(/\s+$/u, "")}\n\n${definitions.join("\n")}\n`;

  const unresolvedKeys = [...unresolved].sort();
  return {
    text,
    report: {
      summary: summarize(
        rewrittenCitationCount,
        citedKeys.length,
        entries.length,
      ),
      notes: buildNotes(parserWarnings, unresolvedKeys),
      entryCount: entries.length,
      rewrittenCitationCount,
      footnoteKeys: citedKeys.map(label),
      unresolvedKeys,
    },
  };
}

/** The citation keys inside one bracket span, cross-references removed. */
function keysIn(span: string): string[] {
  const keys: string[] = [];
  for (const match of span.matchAll(CITATION_KEY)) {
    // Pandoc keys may not end in punctuation, but `[@key.]` in hand-written
    // prose does happen; the trailing stop belongs to the sentence.
    const key = match[1].replace(/[.,;:]+$/u, "");
    const namespace = key.includes(":") ? key.slice(0, key.indexOf(":")) : "";
    if (key.length === 0 || CROSSREF_NAMESPACES.has(namespace)) {
      continue;
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * The label→marker mapping, collision-free against the briefing's own
 * footnotes.
 *
 * Prefixing is all-or-nothing on purpose: a briefing where three keys are
 * spelled `[^smith2020]` and one `[^bib-1]` because that single label
 * happened to collide is harder to read than one where the whole generated
 * block shares a prefix. The uniform prefix also keeps the block visibly
 * "the imported bibliography" rather than mixed into the author's own notes.
 */
function labelling(
  briefingText: string,
  keys: readonly string[],
): (key: string) => string {
  const taken = new Set<string>();
  for (const match of briefingText.matchAll(EXISTING_MARKER)) {
    taken.add(match[1]);
  }
  for (const line of briefingText.split(/\r?\n/u)) {
    const definition = EXISTING_DEFINITION.exec(line.trim());
    if (definition) {
      taken.add(definition[1]);
    }
  }

  let prefix = "";
  let attempt = 0;
  while (keys.some((key) => taken.has(prefix + key))) {
    attempt += 1;
    prefix = attempt === 1 ? "bib-" : `bib${attempt}-`;
  }
  return (key: string) => prefix + key;
}

/**
 * The footnote definition for one entry: title first, best identifier
 * second. The title leads because the footnote channel reads the definition
 * as the reference's text and cleans a title out of it; the identifier
 * trails so the regex channel finds it on the same line and the two channels
 * describe ONE citation rather than two.
 */
function definitionText(entry: BibtexEntry): string {
  // Verbatim: a title that ends in a full stop of its own ("Mata v. Avianca,
  // Inc.") keeps it, and only the separator adapts. Trimming the stop would
  // rewrite the source's own name to make the concatenation look tidier.
  const title = entry.fields.title ?? entry.key;
  const identifier = bestIdentifier(entry);
  if (identifier === null) {
    return title;
  }
  return /[.!?]$/u.test(title)
    ? `${title} ${identifier}`
    : `${title}. ${identifier}`;
}

function summarize(citations: number, keys: number, entries: number): string {
  if (entries === 0) {
    return "Keine lesbaren Einträge in der Literaturdatei gefunden – das Briefing wurde unverändert übernommen.";
  }
  if (citations === 0) {
    return `Literaturdatei mit ${entries} ${plural(entries, "Eintrag", "Einträgen")} gelesen; das Briefing enthält keine auflösbaren Zitationen im Format [@schlüssel].`;
  }
  return `${citations} ${plural(citations, "Zitation", "Zitationen")} aus ${entries} ${plural(entries, "Eintrag", "Einträgen")} in ${keys} ${plural(keys, "Fußnote", "Fußnoten")} überführt.`;
}

function buildNotes(
  parserWarnings: readonly string[],
  unresolvedKeys: readonly string[],
): string[] {
  const notes = [...parserWarnings];
  if (unresolvedKeys.length > 0) {
    notes.push(
      `${unresolvedKeys.length} ${plural(unresolvedKeys.length, "Zitierschlüssel", "Zitierschlüssel")} ohne Eintrag in der Literaturdatei – im Text unverändert gelassen: ${unresolvedKeys.join(", ")}.`,
    );
  }
  return notes;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

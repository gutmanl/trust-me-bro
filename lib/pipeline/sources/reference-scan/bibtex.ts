/**
 * Tolerant BibTeX/BibLaTeX reader for the briefing import (BibTeX support).
 *
 * Scope on purpose: this is NOT a BibTeX implementation, it is the subset a
 * Zotero/JabRef export of a thesis bibliography actually contains — entries
 * of the shape `@type{key, field = {…} | "…" | bare, …}` — read well enough
 * to answer two questions per entry: what is the title, and what is the best
 * identifier to hand to the reference scan. Everything else (string macro
 * expansion, cross-references, `@preamble` TeX) is deliberately out.
 *
 * Robustness is the requirement, not a nicety: this input is a file the user
 * picked, and a briefing import must never fail because one entry somewhere
 * in the file is malformed. So the reader is written as a resynchronizing
 * scanner — an entry it cannot decipher is skipped, recorded as a German
 * warning, and scanning continues at the next `@`. It has no failure mode
 * that throws.
 *
 * Pure, no I/O.
 */

/** One parsed bibliography entry. Type and field names are lowercased; field
 * values are LaTeX-de-escaped and whitespace-collapsed. */
export interface BibtexEntry {
  /** The citation key as written — the `key` in `[@key]`. */
  key: string;
  /** Entry type, lowercased (`article`, `online`, `inproceedings`, …). */
  type: string;
  /** Field name (lowercased) → de-escaped value. */
  fields: Record<string, string>;
}

export interface BibtexParseResult {
  entries: BibtexEntry[];
  /** German prose, one line per skipped entry — surfaced in the import
   * report so a user sees what did NOT make it into the briefing. */
  warnings: string[];
}

/**
 * Entry types this reader accepts. Generous on purpose (BibTeX and BibLaTeX
 * together), because the type carries no meaning here beyond "this is a
 * bibliography entry" — the title and the identifier do all the work. An
 * unknown type is still skipped rather than guessed at, so a mis-parse can
 * never invent a source silently: it shows up in the warning list instead.
 */
const KNOWN_ENTRY_TYPES = new Set([
  "article",
  "artwork",
  "audio",
  "book",
  "bookinbook",
  "booklet",
  "collection",
  "conference",
  "dataset",
  "electronic",
  "image",
  "inbook",
  "incollection",
  "inproceedings",
  "inreference",
  "jurisdiction",
  "legal",
  "legislation",
  "letter",
  "manual",
  "mastersthesis",
  "misc",
  "movie",
  "music",
  "mvbook",
  "mvcollection",
  "mvproceedings",
  "mvreference",
  "online",
  "patent",
  "performance",
  "periodical",
  "phdthesis",
  "proceedings",
  "reference",
  "report",
  "review",
  "software",
  "standard",
  "suppbook",
  "suppcollection",
  "suppperiodical",
  "techreport",
  "thesis",
  "unpublished",
  "video",
  "www",
]);

/** Structural directives that are not entries; skipped without a warning. */
const STRUCTURAL_TYPES = new Set(["comment", "preamble", "string"]);

/**
 * Reads a `.bib` file. Never throws: whatever it cannot read becomes a
 * German warning line and the scan resumes at the next `@`.
 */
export function parseBibtex(source: string): BibtexParseResult {
  const entries: BibtexEntry[] = [];
  const warnings: string[] = [];
  const seenKeys = new Set<string>();
  const text = source.replace(/\r\n?/gu, "\n");

  let index = 0;
  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at < 0) {
      break;
    }
    const parsed = readEntry(text, at);
    index = parsed.next;
    if (parsed.entry === null) {
      if (parsed.warning) {
        warnings.push(parsed.warning);
      }
      continue;
    }
    // A duplicate key would make `[@key]` ambiguous. First wins — which is
    // what BibTeX itself does — and the collision is reported rather than
    // resolved silently.
    if (seenKeys.has(parsed.entry.key)) {
      warnings.push(
        `Doppelter BibTeX-Schlüssel „${parsed.entry.key}“ – der spätere Eintrag wurde übersprungen.`,
      );
      continue;
    }
    seenKeys.add(parsed.entry.key);
    entries.push(parsed.entry);
  }

  return { entries, warnings };
}

/**
 * The identifier a citation of this entry should carry into the briefing, in
 * the order the reference scan can do the most with:
 *
 * 1. `arXiv:<id>` — the scan's arXiv channel resolves it against the arXiv
 *    export API without a network guess,
 * 2. `https://doi.org/<doi>` — its DOI channel (a doi.org URL IS a DOI to
 *    `scanRegex`, which is why this is spelled as a URL rather than bare:
 *    a bare DOI in a footnote reads as part of the title),
 * 3. the entry's `url`,
 * 4. nothing — the citation then travels as a title only and the existing
 *    Crossref title resolution takes over.
 */
export function bestIdentifier(entry: BibtexEntry): string | null {
  const arxiv = arxivId(entry);
  if (arxiv) {
    return `arXiv:${arxiv}`;
  }
  const doi = normalizeDoiField(entry.fields.doi);
  if (doi) {
    return `https://doi.org/${doi}`;
  }
  const url = entry.fields.url?.trim();
  if (url && /^https?:\/\//iu.test(url)) {
    return url;
  }
  return null;
}

/** The entry's arXiv id, or null. */
function arxivId(entry: BibtexEntry): string | null {
  const eprint = entry.fields.eprint?.trim();
  if (!eprint) {
    return null;
  }
  // BibTeX spells the archive as `archiveprefix`, BibLaTeX as `eprinttype`;
  // Zotero emits the latter, and the thesis bibliography is a Zotero export.
  // Both are accepted — and so is an `eprint` that declares no archive at all
  // but carries the unmistakable modern arXiv id shape, because that is what
  // a good share of exports in the wild look like and the shape is far too
  // specific to collide with an ISBN or a handle.
  const archive = (
    entry.fields.archiveprefix ??
    entry.fields.eprinttype ??
    ""
  ).toLowerCase();
  const bare = eprint.replace(/^arxiv:\s*/iu, "").trim();
  const declared = archive === "arxiv";
  const shaped = /^\d{4}\.\d{4,5}(v\d+)?$/u.test(bare);
  if (!declared && !shaped) {
    return null;
  }
  return bare.length > 0 ? bare : null;
}

/** Bare DOI from a `doi` field that may have been written as a resolver URL. */
function normalizeDoiField(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const bare = value
    .replace(/^https?:\/\/(dx\.)?doi\.org\//iu, "")
    .replace(/^doi:\s*/iu, "")
    .trim();
  return /^10\.\d{4,9}\/\S+$/u.test(bare) ? bare : null;
}

interface EntryRead {
  entry: BibtexEntry | null;
  /** Index to continue scanning at. Always greater than the `@` it started
   * from, so the caller's loop cannot spin. */
  next: number;
  warning?: string;
}

function readEntry(text: string, at: number): EntryRead {
  const typeMatch = /^@[ \t]*([A-Za-z]+)[ \t]*[{(]/u.exec(text.slice(at));
  if (!typeMatch) {
    return { entry: null, next: at + 1 };
  }
  const type = typeMatch[1].toLowerCase();
  const open = at + typeMatch[0].length - 1;
  const close = matchingBrace(text, open);
  // An unterminated entry would swallow the rest of the file if we trusted
  // it, so the scan resumes right after the opening brace instead: the
  // entries below a broken one are still read.
  const next = close === -1 ? open + 1 : close + 1;

  if (STRUCTURAL_TYPES.has(type)) {
    return { entry: null, next };
  }
  if (close === -1) {
    return {
      entry: null,
      next,
      warning: `Unvollständiger BibTeX-Eintrag vom Typ „@${type}“ übersprungen (schließende Klammer fehlt).`,
    };
  }
  if (!KNOWN_ENTRY_TYPES.has(type)) {
    return {
      entry: null,
      next,
      warning: `BibTeX-Eintrag mit unbekanntem Typ „@${type}“ übersprungen.`,
    };
  }

  const { key, values } = splitFields(text.slice(open + 1, close));
  if (!key) {
    return {
      entry: null,
      next,
      warning: `BibTeX-Eintrag vom Typ „@${type}“ ohne Zitierschlüssel übersprungen.`,
    };
  }
  if (Object.keys(values).length === 0) {
    return {
      entry: null,
      next,
      warning: `BibTeX-Eintrag „${key}“ ohne lesbare Felder übersprungen.`,
    };
  }
  return { entry: { key, type, fields: values }, next };
}

/** Index of the brace closing the group that opens at `open`, or -1. */
function matchingBrace(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

interface EntryFields {
  key: string | null;
  values: Record<string, string>;
}

/**
 * Splits an entry body into its citation key and its fields.
 *
 * Written as a scanner rather than a split on commas because a comma inside
 * a braced value ("Mata v. Avianca, Inc.") is part of the value, and because
 * the thesis bibliography carries `% TODO:` comments after field values —
 * between the comma and the next field name. Both are ordinary here.
 */
function splitFields(body: string): EntryFields {
  let index = 0;
  let key: string | null = null;
  const values: Record<string, string> = {};

  const skipGaps = (): void => {
    for (;;) {
      while (index < body.length && /\s/u.test(body[index])) {
        index += 1;
      }
      if (body[index] !== "%") {
        return;
      }
      const eol = body.indexOf("\n", index);
      index = eol === -1 ? body.length : eol + 1;
    }
  };

  skipGaps();
  // The citation key runs from the opening brace to the first comma. It is
  // the only "field" without a name, which is why it is read separately.
  const keyEnd = body.indexOf(",", index);
  const rawKey = (keyEnd === -1 ? body.slice(index) : body.slice(index, keyEnd))
    .replace(/%[^\n]*/gu, "")
    .trim();
  if (rawKey.length > 0 && !rawKey.includes("=")) {
    key = rawKey;
  }
  index = keyEnd === -1 ? body.length : keyEnd + 1;

  while (index < body.length) {
    skipGaps();
    const nameMatch = /^([A-Za-z][A-Za-z0-9_:+-]*)[ \t\n]*=/u.exec(
      body.slice(index),
    );
    if (!nameMatch) {
      // Not a field start — most commonly the trailing comma before the
      // entry's closing brace. Give up on the remainder rather than guess.
      break;
    }
    index += nameMatch[0].length;
    const name = nameMatch[1].toLowerCase();
    const value = readValue(body, index);
    index = value.next;
    if (value.text !== null && !(name in values)) {
      values[name] = value.text;
    }
    skipGaps();
    if (body[index] === ",") {
      index += 1;
    }
  }

  return { key, values };
}

interface ValueRead {
  text: string | null;
  next: number;
}

/**
 * One field value: a braced group, a quoted string, or a bare word — with
 * `#` concatenation folded together (BibTeX's only string operator a Zotero
 * export actually emits).
 */
function readValue(body: string, from: number): ValueRead {
  const parts: string[] = [];
  let index = from;

  for (;;) {
    while (index < body.length && /[ \t\n]/u.test(body[index])) {
      index += 1;
    }
    const char = body[index];
    if (char === "{") {
      const close = matchingBrace(body, index);
      if (close === -1) {
        parts.push(body.slice(index + 1));
        index = body.length;
      } else {
        parts.push(body.slice(index + 1, close));
        index = close + 1;
      }
    } else if (char === '"') {
      let end = index + 1;
      let depth = 0;
      while (end < body.length) {
        const current = body[end];
        if (current === "\\") {
          end += 2;
          continue;
        }
        if (current === "{") {
          depth += 1;
        } else if (current === "}") {
          depth -= 1;
        } else if (current === '"' && depth === 0) {
          break;
        }
        end += 1;
      }
      parts.push(body.slice(index + 1, Math.min(end, body.length)));
      index = Math.min(end + 1, body.length);
    } else {
      const bare = /^[A-Za-z0-9_:.\-+/]+/u.exec(body.slice(index));
      if (!bare) {
        break;
      }
      parts.push(bare[0]);
      index += bare[0].length;
    }

    // Fold `{A} # " and " # {B}` into one value.
    let lookahead = index;
    while (lookahead < body.length && /[ \t\n]/u.test(body[lookahead])) {
      lookahead += 1;
    }
    if (body[lookahead] === "#") {
      index = lookahead + 1;
      continue;
    }
    break;
  }

  if (parts.length === 0) {
    return { text: null, next: index };
  }
  return { text: deLatex(parts.join("")), next: index };
}

/** TeX accent command → the combining codepoint it stands for. */
const COMBINING: Record<string, string> = {
  '"': "̈", // diaeresis
  "'": "́", // acute
  "`": "̀", // grave
  "^": "̂", // circumflex
  "~": "̃", // tilde
  "=": "̄", // macron
  ".": "̇", // dot above
  u: "̆", // breve
  v: "̌", // caron
  H: "̋", // double acute
  c: "̧", // cedilla
  k: "̨", // ogonek
  r: "̊", // ring above
  d: "̣", // dot below
  b: "̱", // macron below
};

/** Standalone TeX commands that stand for exactly one character. */
const LITERALS: Record<string, string> = {
  ss: "ß",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  aa: "å",
  AA: "Å",
  o: "ø",
  O: "Ø",
  l: "ł",
  L: "Ł",
  i: "ı",
  j: "ȷ",
  textbackslash: "\\",
  textendash: "–",
  textemdash: "—",
};

/**
 * Turns a LaTeX-flavoured field value into the plain text a briefing shows.
 *
 * Order matters, and it is why this is one function rather than a chain of
 * independent replaces: accents have to be resolved while their braces are
 * still there (`{\"a}` and `\"{a}` are the same character written two ways),
 * and only afterwards may the remaining braces — the protective ones around
 * `{FACTS\&EVIDENCE}` or `{{Anthropic}}`, which carry capitalization intent
 * and no text — be dropped.
 */
function deLatex(raw: string): string {
  let text = raw;

  // `{\"a}` → `\"a`, so the accent rules below see a single shape.
  text = text.replace(
    /\{\\(["'`^~.=])\s*\{?([A-Za-z])\}?\}/gu,
    (_match, accent: string, letter: string) => `\\${accent}${letter}`,
  );

  // `\"{a}` and `\"a`.
  text = text.replace(
    /\\(["'`^~.=])\s*(?:\{([A-Za-z])\}|([A-Za-z]))/gu,
    (_match, accent: string, braced: string, bare: string) =>
      `${braced ?? bare}${COMBINING[accent]}`.normalize("NFC"),
  );
  // The letter-named accents (`\c{c}`, `\v{s}`, …), which need the brace to
  // delimit their argument — `\ca` is the command `\ca`, not a cedilla.
  text = text.replace(
    /\\([uvHckrdb])\{([A-Za-z])\}/gu,
    (_match, command: string, letter: string) =>
      `${letter}${COMBINING[command]}`.normalize("NFC"),
  );

  // Standalone commands. The regex is greedy over the command name, so `\AA`
  // is read as one command rather than `\A` followed by an `A`; and it eats
  // the `{}` or the run of spaces that terminates a control word, because TeX
  // does — `\AA ngstr\o m` is "Ångstrøm", not "Å ngstrø m". An unknown
  // command is returned verbatim, terminator included, so nothing is lost.
  text = text.replace(
    /\\([A-Za-z]+)(?:\{\}|[ \t\n]*)/gu,
    (match, command: string) =>
      command in LITERALS ? LITERALS[command] : match,
  );

  // Escaped punctuation.
  text = text.replace(/\\([&%$#_{}])/gu, "$1");

  // TeX dashes and quotes.
  text = text
    .replace(/---/gu, "—")
    .replace(/--/gu, "–")
    .replace(/``/gu, "“")
    .replace(/''/gu, "”");

  // Protective braces have done their job (capitalization) and carry no text.
  text = text.replace(/[{}]/gu, "");

  return text.replace(/\s+/gu, " ").trim();
}

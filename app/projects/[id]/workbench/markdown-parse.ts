/**
 * Dependency-free Markdown parsing for the workbench.
 *
 * Scoped to exactly what the briefing's generated Markdown uses: headings,
 * paragraphs, ordered/unordered lists, a single level of blockquote, fenced
 * code, Pandoc-style footnotes, and four inline markers (strong, em, code,
 * link). No nesting beyond that — `InlineNode` is flat, so e.g. bold text
 * inside a link label is not further parsed, matching the type below.
 *
 * Footnotes earn their place because they are how a researched briefing
 * cites: the deep-research tools this application ingests from write their
 * sources as `[^1]` markers with a trailing block of `[^1]: …` definitions.
 * Left unrecognized they fell through as literal text, so the prose showed
 * raw `[^1]` and the whole reference list collapsed into one run-on
 * paragraph — the citation apparatus, rendered as noise.
 *
 * `parseMarkdownBlock` operates on ONE blank-line-separated block at a time
 * (see the register's `splitBriefingParagraphs`), not a whole document: the
 * workbench attaches claim margin-cards per block, so blocks are the unit of
 * rendering.
 *
 * Both parsers are total: no input throws, and unrecognized or unbalanced
 * syntax falls through as literal text rather than being dropped.
 */

export type InlineNode =
  | { t: "text" | "strong" | "em" | "code"; v: string }
  | { t: "link"; v: string; href: string }
  /** `[^label]` reference marker; `v` is the label without the caret. */
  | { t: "footnote"; v: string };

export type BlockNode =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: InlineNode[] }
  | { t: "paragraph"; inline: InlineNode[] }
  | { t: "list"; ordered: boolean; items: InlineNode[][] }
  | { t: "blockquote"; inline: InlineNode[] }
  | { t: "codeblock"; v: string }
  /** Block of `[^label]: text` definitions — the briefing's reference list. */
  | { t: "footnotes"; items: { label: string; inline: InlineNode[] }[] };

/** Scheme allowlist for `[text](href)`: only http(s) links render as links. */
const HTTP_HREF_RE = /^https?:\/\//i;

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const ORDERED_ITEM_RE = /^\s*\d+[.)][ \t]+(.*)$/;
const UNORDERED_ITEM_RE = /^\s*[-*+][ \t]+(.*)$/;
const BLOCKQUOTE_LINE_RE = /^>[ \t]?(.*)$/;
/** `[^label]: definition text` — one line of the reference list. */
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;

/**
 * Scans `text` left to right, recognizing `` `code` ``, `**strong**`,
 * `*em*`, and `[text](href)` as non-overlapping, non-nested spans. A marker
 * that never finds its closing counterpart — or a link whose href isn't
 * http(s) — is left as literal text instead of being dropped, so every
 * character of the input is accounted for in the output.
 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer.length > 0) {
      nodes.push({ t: "text", v: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        nodes.push({ t: "code", v: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close !== -1) {
        flush();
        nodes.push({ t: "strong", v: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
      buffer += "**";
      i += 2;
      continue;
    }

    if (ch === "*") {
      const close = text.indexOf("*", i + 1);
      if (close !== -1) {
        flush();
        nodes.push({ t: "em", v: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === "[") {
      const closeBracket = text.indexOf("]", i + 1);

      // Footnote marker `[^label]`. Checked before the link branch because
      // both open with "["; a `[^x](href)` would be a link with an odd
      // label, so the "(" lookahead keeps that case with the links.
      if (
        text[i + 1] === "^" &&
        closeBracket > i + 2 &&
        text[closeBracket + 1] !== "("
      ) {
        const label = text.slice(i + 2, closeBracket);
        // No whitespace inside: `[^ ]` and `[^a b]` are not markers, and
        // treating them as such would swallow ordinary bracketed prose.
        if (!/\s/.test(label)) {
          flush();
          nodes.push({ t: "footnote", v: label });
          i = closeBracket + 1;
          continue;
        }
      }

      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          if (HTTP_HREF_RE.test(href)) {
            flush();
            nodes.push({ t: "link", v: label, href });
          } else {
            // Disallowed scheme (javascript:, data:, relative, …): the
            // whole `[text](href)` source falls through as literal text.
            buffer += text.slice(i, closeParen + 1);
          }
          i = closeParen + 1;
          continue;
        }
      }
      buffer += ch;
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}

/** Parses ONE blank-line-separated Markdown block. Anything unrecognized
 * (or malformed, like an unterminated fence) falls back to a paragraph. */
export function parseMarkdownBlock(block: string): BlockNode {
  const trimmed = block.trim();
  const lines = trimmed.split("\n");

  // Fenced code: an opening ``` line and a matching closing ``` line.
  // Content between them is verbatim — no inline parsing.
  if (/^```/.test(lines[0])) {
    const closeIndex = lines.findIndex(
      (line, idx) => idx > 0 && line.trim() === "```",
    );
    if (closeIndex !== -1) {
      return { t: "codeblock", v: lines.slice(1, closeIndex).join("\n") };
    }
  }

  // Heading: the whole (trimmed) block is a single "#..." line. The regex
  // has no multiline flag, so a block with more than one line can never
  // match — headings are single-line by construction.
  const headingMatch = trimmed.match(HEADING_RE);
  if (headingMatch) {
    return {
      t: "heading",
      // Bounded 1-6 by the {1,6} quantifier above.
      level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
      inline: parseInline(headingMatch[2]),
    };
  }

  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  // Footnote definitions: every non-empty line is a `[^label]: text` entry.
  // Checked before the list rules because a definition line matches neither,
  // and before the paragraph fallback because that is where it used to land.
  if (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => FOOTNOTE_DEF_RE.test(line))
  ) {
    const items = nonEmptyLines.map((line) => {
      // Non-null: `every` above already matched this line.
      const match = line.match(FOOTNOTE_DEF_RE) as RegExpMatchArray;
      return { label: match[1], inline: parseInline(match[2]) };
    });
    return { t: "footnotes", items };
  }

  // List: every non-empty line uses the same marker style (ordered or
  // unordered, decided by the first line).
  if (nonEmptyLines.length > 0) {
    const ordered = ORDERED_ITEM_RE.test(nonEmptyLines[0]);
    const itemRe = ordered ? ORDERED_ITEM_RE : UNORDERED_ITEM_RE;
    if (nonEmptyLines.every((line) => itemRe.test(line))) {
      const items = nonEmptyLines.map((line) => {
        const match = line.match(itemRe);
        return parseInline(match ? match[1] : line);
      });
      return { t: "list", ordered, items };
    }
  }

  // Blockquote: every non-empty line is prefixed with ">"; lines are joined
  // with "\n" and inline-parsed as one run (single level of quoting).
  if (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => BLOCKQUOTE_LINE_RE.test(line))
  ) {
    const content = nonEmptyLines
      .map((line) => line.match(BLOCKQUOTE_LINE_RE)?.[1] ?? "")
      .join("\n");
    return { t: "blockquote", inline: parseInline(content) };
  }

  return { t: "paragraph", inline: parseInline(trimmed) };
}

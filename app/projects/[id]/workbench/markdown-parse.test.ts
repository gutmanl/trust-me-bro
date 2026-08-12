import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdownBlock } from "./markdown-parse";

describe("parseInline", () => {
  it("returns no nodes for an empty string", () => {
    expect(parseInline("")).toEqual([]);
  });

  it("parses plain text with no markers as a single text node", () => {
    expect(parseInline("just plain text")).toEqual([
      { t: "text", v: "just plain text" },
    ]);
  });

  it("parses **strong** emphasis", () => {
    expect(parseInline("a **bold** word")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", v: "bold" },
      { t: "text", v: " word" },
    ]);
  });

  it("parses *em* emphasis", () => {
    expect(parseInline("a *italic* word")).toEqual([
      { t: "text", v: "a " },
      { t: "em", v: "italic" },
      { t: "text", v: " word" },
    ]);
  });

  it("parses `code` spans verbatim (no nested inline parsing)", () => {
    expect(parseInline("a `**not bold**` span")).toEqual([
      { t: "text", v: "a " },
      { t: "code", v: "**not bold**" },
      { t: "text", v: " span" },
    ]);
  });

  it("parses [text](href) as a link for http(s) hrefs", () => {
    expect(parseInline("see [docs](https://example.com/x)")).toEqual([
      { t: "text", v: "see " },
      { t: "link", v: "docs", href: "https://example.com/x" },
    ]);
  });

  it("parses a plain http link and an uppercase-scheme http link", () => {
    expect(parseInline("[a](http://x.test) [b](HTTPS://y.test)")).toEqual([
      { t: "link", v: "a", href: "http://x.test" },
      { t: "text", v: " " },
      { t: "link", v: "b", href: "HTTPS://y.test" },
    ]);
  });

  it("rejects a javascript: href, rendering the literal source as text", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { t: "text", v: "[click](javascript:alert(1))" },
    ]);
  });

  it("rejects a data: href, rendering the literal source as text", () => {
    expect(parseInline("[img](data:text/html,x)")).toEqual([
      { t: "text", v: "[img](data:text/html,x)" },
    ]);
  });

  it("rejects a relative href, rendering the literal source as text", () => {
    expect(parseInline("[home](/projects)")).toEqual([
      { t: "text", v: "[home](/projects)" },
    ]);
  });

  it("leaves an unbalanced ** marker as literal text", () => {
    expect(parseInline("**bold without closing")).toEqual([
      { t: "text", v: "**bold without closing" },
    ]);
  });

  it("leaves an unbalanced * marker as literal text", () => {
    expect(parseInline("*italic without closing")).toEqual([
      { t: "text", v: "*italic without closing" },
    ]);
  });

  it("leaves an unbalanced ` marker as literal text", () => {
    expect(parseInline("`code without closing")).toEqual([
      { t: "text", v: "`code without closing" },
    ]);
  });

  it("leaves an unbalanced [ marker as literal text", () => {
    expect(parseInline("[not a link")).toEqual([
      { t: "text", v: "[not a link" },
    ]);
  });

  it("mixes several inline markers in one run", () => {
    expect(
      parseInline("**bold**, *em*, `code`, and [a link](https://x.test)."),
    ).toEqual([
      { t: "strong", v: "bold" },
      { t: "text", v: ", " },
      { t: "em", v: "em" },
      { t: "text", v: ", " },
      { t: "code", v: "code" },
      { t: "text", v: ", and " },
      { t: "link", v: "a link", href: "https://x.test" },
      { t: "text", v: "." },
    ]);
  });
});

describe("parseMarkdownBlock", () => {
  it("returns an empty paragraph for the empty string", () => {
    expect(parseMarkdownBlock("")).toEqual({ t: "paragraph", inline: [] });
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("parses an h%s heading", (level) => {
    const hashes = "#".repeat(level);
    expect(parseMarkdownBlock(`${hashes} Title ${level}`)).toEqual({
      t: "heading",
      level,
      inline: [{ t: "text", v: `Title ${level}` }],
    });
  });

  it("treats a run of 7 #'s as a plain paragraph, not a heading", () => {
    expect(parseMarkdownBlock("####### too many")).toEqual({
      t: "paragraph",
      inline: [{ t: "text", v: "####### too many" }],
    });
  });

  it("parses a plain paragraph with inline formatting", () => {
    expect(parseMarkdownBlock("a **bold** paragraph")).toEqual({
      t: "paragraph",
      inline: [
        { t: "text", v: "a " },
        { t: "strong", v: "bold" },
        { t: "text", v: " paragraph" },
      ],
    });
  });

  it("parses an unordered list, per-line inline-parsed", () => {
    expect(parseMarkdownBlock("- one\n- two\n- three")).toEqual({
      t: "list",
      ordered: false,
      items: [
        [{ t: "text", v: "one" }],
        [{ t: "text", v: "two" }],
        [{ t: "text", v: "three" }],
      ],
    });
  });

  it("parses an unordered list item containing bold text (nested bold-in-item)", () => {
    expect(parseMarkdownBlock("- **bold** item")).toEqual({
      t: "list",
      ordered: false,
      items: [
        [
          { t: "strong", v: "bold" },
          { t: "text", v: " item" },
        ],
      ],
    });
  });

  it("parses an ordered list, per-line inline-parsed", () => {
    expect(parseMarkdownBlock("1. one\n2. two\n3. three")).toEqual({
      t: "list",
      ordered: true,
      items: [
        [{ t: "text", v: "one" }],
        [{ t: "text", v: "two" }],
        [{ t: "text", v: "three" }],
      ],
    });
  });

  it("parses a blockquote, inline-parsed, single level", () => {
    expect(parseMarkdownBlock("> a *quoted* line")).toEqual({
      t: "blockquote",
      inline: [
        { t: "text", v: "a " },
        { t: "em", v: "quoted" },
        { t: "text", v: " line" },
      ],
    });
  });

  it("parses a multi-line blockquote by joining its lines", () => {
    expect(parseMarkdownBlock("> line one\n> line two")).toEqual({
      t: "blockquote",
      inline: [{ t: "text", v: "line one\nline two" }],
    });
  });

  it("parses a fenced code block verbatim, including backticks inside", () => {
    expect(
      parseMarkdownBlock("```\nconst x = `template ${1}`;\n**not bold**\n```"),
    ).toEqual({
      t: "codeblock",
      v: "const x = `template ${1}`;\n**not bold**",
    });
  });

  it("falls back to a paragraph for an unterminated fence", () => {
    // No closing ``` found, so this isn't a codeblock; it falls through to
    // paragraph, which inline-parses as usual. The first two of the three
    // backticks pair up as an (empty) code span, leaving the third
    // unbalanced and thus literal — a legitimate reading of the same
    // marker rules used everywhere else, not a special case.
    expect(parseMarkdownBlock("```\nno closing fence")).toEqual({
      t: "paragraph",
      inline: [
        { t: "code", v: "" },
        { t: "text", v: "`\nno closing fence" },
      ],
    });
  });

  it("falls back to a paragraph for unrecognized/plain block content", () => {
    expect(parseMarkdownBlock("Just a regular sentence.")).toEqual({
      t: "paragraph",
      inline: [{ t: "text", v: "Just a regular sentence." }],
    });
  });

  it("falls back to a paragraph when markers are unbalanced", () => {
    expect(parseMarkdownBlock("Some **unbalanced text")).toEqual({
      t: "paragraph",
      inline: [{ t: "text", v: "Some **unbalanced text" }],
    });
  });

  it("rejects a javascript: link at block level, rendering literal text", () => {
    expect(parseMarkdownBlock("[click me](javascript:alert(1))")).toEqual({
      t: "paragraph",
      inline: [{ t: "text", v: "[click me](javascript:alert(1))" }],
    });
  });
});

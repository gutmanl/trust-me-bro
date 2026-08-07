import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, pre";

/** Serialized article HTML → block texts separated by blank lines. */
function blockText(html: string): string {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const blocks = [...document.querySelectorAll(BLOCK_SELECTOR)]
    .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);
  return blocks.join("\n\n");
}

/**
 * HTML → text with boilerplate removal: Readability isolates the article
 * (dropping navigation, footers, asides); the fallback for pages without a
 * recognizable article is the plain body text. Deterministic for identical
 * bytes — Readability is a pure DOM heuristic.
 */
export function extractHtmlText(content: Buffer): string {
  const { document } = parseHTML(content.toString("utf8"));
  const article = new Readability(document as unknown as Document).parse();
  if (article?.content) {
    const text = blockText(article.content);
    if (text.length > 0) {
      return text;
    }
  }
  const body = document.querySelector("body");
  return (body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

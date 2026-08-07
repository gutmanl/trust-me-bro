import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FullTextExtractionError } from "../errors";
import { containsNormalized } from "../text/normalize";
import { extractFullText } from "./extract";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);
const samplePdf = fs.readFileSync(path.join(fixtures, "sample.pdf"));
const sampleHtml = fs.readFileSync(path.join(fixtures, "sample.html"));

describe("extractFullText for PDFs", () => {
  it("extracts the text layer and keeps quotes findable in normal form", async () => {
    const text = await extractFullText(samplePdf, "pdf");
    // The fixture hyphenates "Review-\nzeit" across lines — the normal-form
    // search must still find the quote (stage-1 requirement).
    expect(containsNormalized(text, "Reviewzeit sank von 42 auf 19")).toBe(
      true,
    );
  });

  it("is deterministic: identical bytes yield identical text", async () => {
    expect(await extractFullText(samplePdf, "pdf")).toBe(
      await extractFullText(samplePdf, "pdf"),
    );
  });

  it("rejects unreadable PDF bytes", async () => {
    await expect(
      extractFullText(Buffer.from("%PDF-1.7 kaputt"), "pdf"),
    ).rejects.toBeInstanceOf(FullTextExtractionError);
  });
});

describe("extractFullText for HTML", () => {
  it("keeps the article and drops navigation/footer boilerplate", async () => {
    const text = await extractFullText(sampleHtml, "html");
    expect(containsNormalized(text, "mediane Reviewzeit sank von 42")).toBe(
      true,
    );
    expect(text).not.toContain("Impressum");
    expect(text).not.toContain("Beispiel-Verlag");
  });

  it("falls back to body text for pages without an article", async () => {
    const text = await extractFullText(
      Buffer.from(
        "<html><body><span>Nur ein kurzer Hinweis.</span></body></html>",
      ),
      "html",
    );
    expect(text).toBe("Nur ein kurzer Hinweis.");
  });
});

describe("extractFullText for text formats and unknowns", () => {
  it("passes txt/md through unchanged", async () => {
    expect(await extractFullText(Buffer.from("Reiner Text."), "txt")).toBe(
      "Reiner Text.",
    );
    expect(await extractFullText(Buffer.from("# Markdown"), "md")).toBe(
      "# Markdown",
    );
  });

  it("rejects unsupported formats and empty results", async () => {
    await expect(
      extractFullText(Buffer.from("bytes"), "docx"),
    ).rejects.toBeInstanceOf(FullTextExtractionError);
    await expect(extractFullText(Buffer.from("   "), "txt")).rejects.toThrow(
      /keinen Text/,
    );
  });
});

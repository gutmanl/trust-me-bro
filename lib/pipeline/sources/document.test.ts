import { describe, expect, it } from "vitest";

import { fakeFetcher } from "./__fixtures__/fake-fetcher";
import {
  DocumentFetchError,
  FullTextExtractionError,
  TextExtractionTimeoutError,
} from "../errors";
import {
  acquireDocument,
  extractTextOrError,
  hasPdfSignature,
} from "./document";

const bytes = Buffer.from("irrelevant");

/** A publisher paywall page, the thing the signature guard exists for. */
const PAYWALL_HTML = Buffer.from(
  "<!doctype html><html><body><h1>Purchase PDF — USD 39.95</h1></body></html>",
  "utf8",
);

describe("extractTextOrError", () => {
  it("returns the extracted text on success", async () => {
    const result = await extractTextOrError(
      bytes,
      "pdf",
      async () => "Volltext",
    );
    expect(result).toEqual({ text: "Volltext" });
  });

  it("records a genuine parse failure softly (TMB-24: capture visibly, never fatal)", async () => {
    const result = await extractTextOrError(bytes, "pdf", async () => {
      throw new FullTextExtractionError("kein Textlayer");
    });
    expect(result).toEqual({ error: "kein Textlayer" });
  });

  it("re-throws a timeout so the capture item fails instead of half-importing", async () => {
    await expect(
      extractTextOrError(bytes, "pdf", async () => {
        throw new TextExtractionTimeoutError(20);
      }),
    ).rejects.toBeInstanceOf(TextExtractionTimeoutError);
  });
});

describe("hasPdfSignature", () => {
  it("accepts a header at the start", () => {
    expect(hasPdfSignature(Buffer.from("%PDF-1.7\nrest"))).toBe(true);
  });

  it("accepts a header preceded by leading bytes, as the extraction does", () => {
    const padded = Buffer.concat([
      Buffer.alloc(600, 0x20),
      Buffer.from("%PDF-1.4\n"),
    ]);
    expect(hasPdfSignature(padded)).toBe(true);
  });

  it("rejects a header pushed past the search window", () => {
    const tooLate = Buffer.concat([
      Buffer.alloc(4096, 0x20),
      Buffer.from("%PDF-1.4\n"),
    ]);
    expect(hasPdfSignature(tooLate)).toBe(false);
  });

  it("rejects html, however it was labelled", () => {
    expect(hasPdfSignature(PAYWALL_HTML)).toBe(false);
  });
});

describe("acquireDocument's PDF signature guard", () => {
  const url = "https://publisher.example.org/paper.pdf";

  it("rejects a host that serves html under application/pdf", async () => {
    const fetcher = fakeFetcher({
      [url]: { contentType: "application/pdf", body: PAYWALL_HTML },
    });
    await expect(
      acquireDocument({ documentUrl: url, expectedExt: "pdf" }, fetcher),
    ).rejects.toThrow(/keine PDF-Signatur/);
  });

  it("rejects it on a manual capture too, which sets no expectedExt", async () => {
    const fetcher = fakeFetcher({
      [url]: { contentType: "application/pdf", body: PAYWALL_HTML },
    });
    await expect(
      acquireDocument({ documentUrl: url }, fetcher),
    ).rejects.toBeInstanceOf(DocumentFetchError);
  });

  it("rejects an upload whose .pdf name is not borne out by its bytes", async () => {
    await expect(
      acquireDocument(
        { upload: { content: PAYWALL_HTML, filename: "paper.pdf" } },
        fakeFetcher({}),
      ),
    ).rejects.toThrow(/keine PDF-Signatur/);
  });

  it("leaves a real PDF alone", async () => {
    const pdf = Buffer.from("%PDF-1.7 fake");
    const fetcher = fakeFetcher({
      [url]: { contentType: "application/pdf", body: pdf },
    });
    await expect(
      acquireDocument({ documentUrl: url, expectedExt: "pdf" }, fetcher),
    ).resolves.toEqual({ content: pdf, ext: "pdf" });
  });

  it("does not touch a document that never claimed to be a PDF", async () => {
    const htmlUrl = "https://publisher.example.org/landing";
    const fetcher = fakeFetcher({
      [htmlUrl]: { contentType: "text/html", body: PAYWALL_HTML },
    });
    await expect(
      acquireDocument({ documentUrl: htmlUrl }, fetcher),
    ).resolves.toEqual({ content: PAYWALL_HTML, ext: "html" });
  });
});

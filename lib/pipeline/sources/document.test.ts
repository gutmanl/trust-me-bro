import { describe, expect, it } from "vitest";

import { FullTextExtractionError, TextExtractionTimeoutError } from "../errors";
import { extractTextOrError } from "./document";

const bytes = Buffer.from("irrelevant");

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

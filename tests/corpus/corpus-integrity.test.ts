/**
 * Guards on the corpus itself.
 *
 * The most important one is the last: it prints how much of the corpus is
 * still synthetic. A record-and-replay corpus decays silently — cassettes
 * outlive the code that recorded them, and "we test against real data" turns
 * into folklore. Making the split an assertion the suite prints on every run
 * is cheaper than a policy nobody enforces.
 */
import { describe, expect, it } from "vitest";

import { extractFullText } from "../../lib/pipeline/fulltext/extract";
import { containsNormalized } from "../../lib/register/text/normalize";
import { httpCassetteKey } from "./cassette";
import {
  loadDocumentManifest,
  loadHttpCassettes,
  loadLlmCassettes,
  readDocument,
} from "./corpus-store";
import { QUOTE_PRESENT, SOURCE_AUDIT_TRAILS } from "./scenarios";

describe("corpus cassettes", () => {
  it("derive their own filename key from their request", () => {
    for (const cassette of loadHttpCassettes()) {
      expect(httpCassetteKey(cassette.url, cassette.accept)).toBe(cassette.key);
    }
  });

  it("carry exactly one body form", () => {
    for (const cassette of loadHttpCassettes()) {
      const forms = [cassette.bodyText, cassette.bodyDocument].filter(
        (form) => form !== undefined,
      );
      expect(
        forms.length,
        `cassette ${cassette.key} (${cassette.url}) must have either an ` +
          "inline bodyText or a bodyDocument reference, not both and not neither",
      ).toBe(1);
    }
  });

  it("reference only documents the manifest knows", () => {
    const names = new Set(
      loadDocumentManifest().documents.map((document) => document.name),
    );
    for (const cassette of loadHttpCassettes()) {
      if (cassette.bodyDocument !== undefined) {
        expect(names).toContain(cassette.bodyDocument);
      }
    }
  });

  it("never carry a contact address or credential into the repository", () => {
    // The recorder redacts on the way in; this is the check that the
    // redaction actually held, because the cost of getting it wrong is a
    // mailbox or an API key in git history.
    for (const cassette of loadHttpCassettes()) {
      expect(cassette.url).not.toMatch(
        /[?&](email|api_?key|token)=(?!REDACTED)/i,
      );
      expect(cassette.url).not.toMatch(/@/);
    }
  });
});

describe("corpus documents", () => {
  it("are readable, real PDFs whose text the pipeline can extract", async () => {
    const documents = loadDocumentManifest().documents;
    expect(documents.length).toBeGreaterThan(0);

    for (const document of documents) {
      const bytes = readDocument(document);
      expect(
        bytes,
        `${document.name} is missing — run npm run corpus:fetch`,
      ).not.toBeNull();
      // A seed stand-in that pdf.js cannot read would make every downstream
      // wording proof vacuous, so this asserts the real extraction path.
      const text = await extractFullText(bytes as Buffer, "pdf");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("contain the quote the stage-1 wording proof looks for", async () => {
    const document = loadDocumentManifest().documents.find((entry) =>
      entry.url.includes(SOURCE_AUDIT_TRAILS.canonical),
    );
    expect(document).toBeDefined();
    const text = await extractFullText(
      readDocument(document!) as Buffer,
      "pdf",
    );
    // Via containsNormalized, not a raw substring: the seed PDF hyphenates
    // across a line break exactly as a real one does, and the point is that
    // the production normalizer sees through it.
    expect(containsNormalized(text, QUOTE_PRESENT)).toBe(true);
  });
});

describe("corpus provenance", () => {
  it("reports how much of it is real", () => {
    const http = loadHttpCassettes();
    const llm = loadLlmCassettes();
    const all = [...http, ...llm];
    const recorded = all.filter(
      (cassette) => cassette.provenance.kind === "recorded",
    );
    const documents = loadDocumentManifest().documents;
    const realDocuments = documents.filter(
      (document) => document.sha256_source === "recorded",
    );

    console.log(
      `\ncorpus: ${recorded.length}/${all.length} cassettes recorded from ` +
        `live services (${http.length} HTTP, ${llm.length} LLM), ` +
        `${realDocuments.length}/${documents.length} documents hash-pinned ` +
        "from a real recording.\n" +
        (recorded.length === all.length
          ? ""
          : "  → npm run corpus:record -- --http --llm  to replace the " +
            "synthetic ones.\n"),
    );

    // Not an assertion on the ratio: a fresh clone legitimately has none
    // recorded, and failing there would make the suite unrunnable for
    // exactly the people who most need it to run. What IS asserted is that
    // every cassette declares which it is.
    for (const cassette of all) {
      expect(["synthetic", "recorded"]).toContain(cassette.provenance.kind);
    }
  });
});

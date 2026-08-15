/**
 * The corpus-integrity guard, exercised against documents rather than
 * assertions about documents.
 *
 * `CLAUDE.md` states the rule this file defends: "Auto-import may only store
 * a document it has proven is a real PDF. Never add a fallback to landing
 * pages or abstracts — the frozen document is what stage-1 verification
 * checks quoted wording against." The interesting question is what "proven"
 * currently means, and the answer is narrower than the sentence suggests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureSource } from "../../lib/pipeline";
import { extractFullText } from "../../lib/pipeline/fulltext/extract";
import { cassetteFetcher } from "../corpus/cassette-fetcher";
import {
  createCorpusProject,
  createCorpusWorkspace,
  type CorpusWorkspace,
} from "../corpus/harness";
import { SCENARIO_BRIEFING } from "../corpus/scenarios";

let workspace: CorpusWorkspace;

beforeEach(() => {
  workspace = createCorpusWorkspace();
});

afterEach(() => {
  workspace.cleanup();
});

const PAYWALL_URL = "https://publisher.example.org/landing/10.18653";

/** A publisher paywall page — the thing that must never enter the corpus
 * dressed as the paper. Real ones look exactly like this. */
const PAYWALL_HTML = Buffer.from(
  [
    '<!doctype html><html lang="en"><head><title>Access this article</title></head>',
    "<body><h1>Claim-Level Verification of Generated Scientific Summaries</h1>",
    "<p>Institutional sign-in required. Purchase PDF — USD 39.95.</p>",
    "<p>Abstract: We present a method for verifying individual claims …</p>",
    "</body></html>",
  ].join("\n"),
  "utf8",
);

describe("a derived url that serves a landing page", () => {
  it("fails the capture instead of freezing the paywall as the paper", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });
    const fetcher = cassetteFetcher({
      adversarial: {
        // Honest server: it says text/html, because it is.
        [PAYWALL_URL]: {
          status: 200,
          contentType: "text/html",
          body: PAYWALL_HTML,
        },
      },
    });

    await expect(
      captureSource(
        {
          projectId: project.projectId,
          kind: "url",
          identifier: PAYWALL_URL,
          sourceType: "peer_reviewed_publication",
          manual: {
            title: "Claim-Level Verification of Generated Scientific Summaries",
          },
          documentUrl: PAYWALL_URL,
          expectedExt: "pdf",
        },
        { fetcher },
      ),
    ).rejects.toThrow(/ist kein PDF/);

    const register = await project.read();
    expect(register.sources).toHaveLength(0);
  });
});

describe("a derived url that LIES about its content type", () => {
  /**
   * KNOWN GAP — pinned, not fixed.
   *
   * `expectedExt` is the whole of the "proof". It compares the server's
   * declared `Content-Type` (falling back to the URL's filename extension)
   * against "pdf" — it never looks at the bytes, so there is no `%PDF-`
   * magic-number check and no requirement that `unpdf` parse the document
   * before it is frozen. A server that labels an HTML paywall
   * `application/pdf` therefore walks straight past the guard.
   *
   * What saves the corpus is the layer behind it, and only partly: text
   * extraction fails, so the source is stored with a `text_extraction_error`
   * and NO text blob, which means stage 1's wording proof can never pass
   * against it. The claim ends up in front of a human rather than
   * auto-confirmed against a paywall — the right outcome, reached by
   * accident rather than by the check that was supposed to reach it.
   *
   * The cost of the gap is a corpus entry that looks captured and is not:
   * `briefing.md` and the export bundle both carry a frozen "document" that
   * is a sales page. This test asserts today's behaviour so a future
   * magic-byte check has to come here and change it deliberately.
   */
  it("stores the file anyway, and only text extraction stops it", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });
    const fetcher = cassetteFetcher({
      adversarial: {
        [PAYWALL_URL]: {
          status: 200,
          // The lie.
          contentType: "application/pdf",
          body: PAYWALL_HTML,
        },
      },
    });

    const source = await captureSource(
      {
        projectId: project.projectId,
        kind: "url",
        identifier: PAYWALL_URL,
        sourceType: "peer_reviewed_publication",
        manual: {
          title: "Claim-Level Verification of Generated Scientific Summaries",
        },
        documentUrl: PAYWALL_URL,
        expectedExt: "pdf",
      },
      { fetcher },
    );

    // It got in.
    const snapshot = (
      source as unknown as {
        custom: {
          snapshot: {
            blob_path: string;
            text_blob_path?: string;
            text_extraction_error?: string;
          };
        };
      }
    ).custom.snapshot;
    expect(snapshot.blob_path).toMatch(/\.pdf$/);

    // And this is the only reason it cannot do damage: no text layer, so
    // nothing to prove a quote against.
    expect(snapshot.text_blob_path).toBeUndefined();
    expect(snapshot.text_extraction_error).toBeDefined();

    // The bytes really are HTML — confirming the guard was bypassed rather
    // than the fixture being wrong.
    await expect(extractFullText(PAYWALL_HTML, "pdf")).rejects.toThrow();
  });
});

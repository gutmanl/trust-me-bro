/**
 * The corpus-integrity guard, exercised against documents rather than
 * assertions about documents.
 *
 * `CLAUDE.md` states the rule this file defends: "Auto-import may only store
 * a document it has proven is a real PDF. Never add a fallback to landing
 * pages or abstracts — the frozen document is what stage-1 verification
 * checks quoted wording against." The interesting question is what "proven"
 * means, and these two blocks are the answer: the declared content type must
 * say PDF, and the bytes must bear it out. The second half postdates the
 * first — this file originally pinned its absence — so the pair is kept
 * together, an honest server and a lying one, to document what each catches.
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
   * The harder half of the same rule. `expectedExt` compares CLAIMS — the
   * declared `Content-Type`, falling back to the URL's filename — so a host
   * that labels an HTML paywall `application/pdf` satisfies it completely.
   * It used to walk straight past the guard on exactly that basis, and this
   * block pinned that as known behaviour.
   *
   * `acquireDocument` now reads the document as well as its label: anything
   * about to be frozen under a `.pdf` blob path must carry the `%PDF-`
   * signature. Only the signature, never "did unpdf parse it" — a scanned
   * paper without a text layer is a real PDF and must stay capturable
   * (TMB-24), its missing text recorded at the source entry.
   *
   * What makes the difference visible is WHERE the failure lands. Before, the
   * paywall became a captured source whose text extraction had failed: a
   * corpus entry that looked captured and was not, travelling into
   * `briefing.md` and the export bundle, stopped from doing damage only
   * because stage 1 could never prove a quote against a missing text blob —
   * the right outcome reached by accident. Now the capture fails outright, in
   * front of the reviewer, by the check meant to reach it.
   */
  it("fails the capture rather than freezing a sales page as the paper", async () => {
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
    ).rejects.toThrow(/keine PDF-Signatur/);

    // Nothing entered the corpus — neither the source nor a blob claiming to
    // be its document.
    const register = await project.read();
    expect(register.sources).toHaveLength(0);

    // The bytes really are HTML, so the guard rejected the document rather
    // than the fixture being wrong.
    await expect(extractFullText(PAYWALL_HTML, "pdf")).rejects.toThrow();
  });

  /**
   * The guard is keyed on the resolved extension, not on `expectedExt`, so
   * it holds for a document the USER chose too — a manual capture sets no
   * `expectedExt` at all and used to reach the blob store unexamined.
   */
  it("holds for a manual capture, which sets no expectedExt", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });
    const fetcher = cassetteFetcher({
      adversarial: {
        [PAYWALL_URL]: {
          status: 200,
          contentType: "application/pdf",
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
        },
        { fetcher },
      ),
    ).rejects.toThrow(/keine PDF-Signatur/);

    const register = await project.read();
    expect(register.sources).toHaveLength(0);
  });
});

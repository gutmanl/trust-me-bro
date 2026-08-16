/**
 * The pipeline walked end to end against the recorded corpus.
 *
 * The existing `lifecycle.e2e.test.ts` proves the register composes: it
 * hand-writes every transaction and then holds the result up against the
 * schema, the chain and the real `tmb verify` binary. What it cannot prove is
 * that the *use-cases* survive real data, because it never calls one. This
 * file starts where that one stops — every step here is the function the web
 * layer calls, driven by responses recorded from (or shaped after) the
 * services this system actually depends on.
 *
 * One spec per failure class the recent work addressed, because a single
 * mega-walk tells you something broke without telling you what.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureSource,
  exportProjectBundle,
  getReferenceCandidates,
  startExistenceCheck,
  startReferenceScan,
  startSourceExtraction,
} from "../../lib/pipeline";
import { cassetteFetcher } from "../corpus/cassette-fetcher";
import {
  corpusOrchestrator,
  createCorpusProject,
  createCorpusWorkspace,
  statusesOf,
  type CorpusWorkspace,
} from "../corpus/harness";
import {
  extractionSeed,
  HALLUCINATED_SOURCE_EXTRACTION,
  misquotingExtractionSeed,
  REFERENCE_PARSE_SEED,
} from "../corpus/llm-seed";
import { createReplayBackend } from "../corpus/replay-backend";
import {
  AUDIT_TRAILS_PDF_URL,
  QUOTE_ABSENT,
  QUOTE_PRESENT,
  CITATION_WITHOUT_IDENTIFIER,
  SCENARIO_BRIEFING,
  SOURCE_AUDIT_TRAILS,
  SOURCE_MISATTRIBUTED,
  SOURCE_MISATTRIBUTED_INLINE,
  SOURCE_UNRESOLVABLE,
} from "../corpus/scenarios";

let workspace: CorpusWorkspace;

beforeEach(() => {
  workspace = createCorpusWorkspace();
});

afterEach(() => {
  workspace.cleanup();
  // The Unpaywall opt-in below is one spec's business, not the file's.
  vi.unstubAllEnvs();
});

/** Captures the clean source through the real capture path. */
async function captureCleanSource(
  projectId: string,
  fetcher = cassetteFetcher(),
) {
  return captureSource(
    {
      projectId,
      kind: "arxiv",
      identifier: SOURCE_AUDIT_TRAILS.identifier,
      sourceType: "peer_reviewed_publication",
    },
    { fetcher },
  );
}

describe("reference scan over a real briefing", () => {
  it("finds every cited work and derives a PDF url for each identifier", async () => {
    // Unpaywall is opt-in, and this spec opts in. The recorded Crossref
    // record for the ACL DOI carries an EMPTY `link[]` — the synthetic
    // fixture used to invent a PDF entry there — so the real derivation only
    // reaches a document through Unpaywall, which knows the work is open
    // access. Without an address configured that step is skipped and the
    // candidate legitimately gets no document at all; asserting THAT would
    // leave the open-access branch of the chain untested against real data.
    // The cassette key redacts the address, so any value replays.
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", "corpus@example.org");
    const project = await createCorpusProject({
      briefing: SCENARIO_BRIEFING,
      backend: createReplayBackend({ seed: REFERENCE_PARSE_SEED }),
    });
    const fetcher = cassetteFetcher();

    const handle = await startReferenceScan(project.projectId, {
      orchestrator: project.orchestrator,
      fetcher,
      // The Crossref 429 path sleeps; the corpus never returns one, but a
      // spec must not be able to hang if a recording later does.
      sleep: async () => {},
    });
    await handle.done;

    // Asserted first, and in every spec that fetches: Crossref and Unpaywall
    // both swallow fetch errors by contract, so a missing recording would be
    // silently reinterpreted as "the service had nothing" and the assertions
    // below would pass for the wrong reason.
    expect(fetcher.misses()).toEqual([]);

    const candidates = await getReferenceCandidates(project.projectId);
    const byIdentifier = new Map(
      candidates.map((candidate) => [
        candidate.doi ?? candidate.arxiv_id ?? candidate.title ?? "",
        candidate,
      ]),
    );

    // Four identifiers from the regex channel — three cited by footnote, one
    // inline — plus the prose-only citation the LLM channel reported. The
    // inline one is reported by BOTH channels and must collapse to a single
    // candidate: same identifier, one identity key.
    expect(candidates).toHaveLength(5);
    expect([...byIdentifier.keys()]).toEqual(
      expect.arrayContaining([
        SOURCE_AUDIT_TRAILS.canonical,
        SOURCE_MISATTRIBUTED.canonical,
        SOURCE_MISATTRIBUTED_INLINE.canonical,
        SOURCE_UNRESOLVABLE.canonical,
      ]),
    );

    // The fixed derivation order, both branches of it: arXiv determines its
    // PDF url with no network call, the DOI needs Crossref's link[]. Neither
    // is allowed to fall back to a landing page.
    expect(byIdentifier.get(SOURCE_AUDIT_TRAILS.canonical)?.document_url).toBe(
      AUDIT_TRAILS_PDF_URL,
    );
    expect(
      byIdentifier.get(SOURCE_AUDIT_TRAILS.canonical)?.document_url_source,
    ).toBe("arxiv");
    // Crossref answered with no link at all for this DOI, so the chain fell
    // through to Unpaywall — the third branch, and the one that knows about
    // open access rather than guessing from a URL.
    expect(
      byIdentifier.get(SOURCE_MISATTRIBUTED.canonical)?.document_url,
    ).toMatch(/\.pdf$/);
    expect(
      byIdentifier.get(SOURCE_MISATTRIBUTED.canonical)?.document_url_source,
    ).toBe("unpaywall");

    // Crossref answered the title lookup and had nothing. That is NOT an
    // outage, and the candidate must not claim one — the two take different
    // branches downstream.
    const proseOnly = candidates.find(
      (candidate) => candidate.method === "unresolved",
    );
    expect(proseOnly?.title).toBe(CITATION_WITHOUT_IDENTIFIER.title);
    expect(proseOnly?.crossref_unavailable).toBeUndefined();
  });
});

describe("failure class: the identifier resolves to a different work", () => {
  it("flags the mismatch and withholds the candidate from auto-capture", async () => {
    const project = await createCorpusProject({
      briefing: SCENARIO_BRIEFING,
      backend: createReplayBackend({ seed: REFERENCE_PARSE_SEED }),
    });
    const fetcher = cassetteFetcher();

    const handle = await startReferenceScan(project.projectId, {
      orchestrator: project.orchestrator,
      fetcher,
      sleep: async () => {},
    });
    await handle.done;
    expect(fetcher.misses()).toEqual([]);

    const candidates = await getReferenceCandidates(project.projectId);
    const misattributed = candidates.find(
      (candidate) => candidate.doi === SOURCE_MISATTRIBUTED.canonical,
    );
    expect(misattributed).toBeDefined();

    // The briefing says one thing, doi.org says another. The scan records the
    // disagreement rather than silently adopting the resolved metadata.
    expect(misattributed?.identity_conflict).toBe(true);
    // German, because this is display-tier prose, and it names the work the
    // identifier really points at — the reviewer needs both halves to decide.
    expect(misattributed?.identity_conflict_note).toContain(
      SOURCE_MISATTRIBUTED.resolvedTitle,
    );
    expect(misattributed?.identity_conflict_note).toContain(
      "mögliche halluzinierte Kennung",
    );
    // The consequence that matters: a conflicted candidate is never
    // pre-selected, so the unattended capture pass cannot swallow it.
    expect(misattributed?.selected).toBe(false);

    // The clean sources are unaffected — a conflict on one citation must not
    // make the scan defensive about the rest.
    const clean = candidates.find(
      (candidate) => candidate.arxiv_id === SOURCE_AUDIT_TRAILS.canonical,
    );
    expect(clean?.identity_conflict).toBeUndefined();
    expect(clean?.selected).toBe(true);
  });

  /**
   * The same guard on a citation written inline — title and identifier in one
   * sentence, no footnote. This is the case the check used to miss entirely,
   * and missing it was invisible: the candidate looked clean and was
   * pre-selected for automatic capture.
   *
   * What makes it work is not the cross-check, which is unchanged, but the
   * title reaching it: prompt v1.1.0 asks the model to report the citations
   * the regex channel already found, so the inline citation arrives with the
   * title the briefing claims for it, and the merge puts that title on the
   * identifier the regex channel read.
   */
  it("flags it for an inline citation too, not just a footnote", async () => {
    const project = await createCorpusProject({
      briefing: SCENARIO_BRIEFING,
      backend: createReplayBackend({ seed: REFERENCE_PARSE_SEED }),
    });
    const fetcher = cassetteFetcher();

    const handle = await startReferenceScan(project.projectId, {
      orchestrator: project.orchestrator,
      fetcher,
      sleep: async () => {},
    });
    await handle.done;
    expect(fetcher.misses()).toEqual([]);

    const candidates = await getReferenceCandidates(project.projectId);
    const inline = candidates.find(
      (candidate) => candidate.doi === SOURCE_MISATTRIBUTED_INLINE.canonical,
    );
    expect(inline).toBeDefined();

    // The title the LLM channel supplied for an already-detected identifier —
    // without it the cross-check has nothing to compare and returns silently.
    expect(inline?.title).toBe(SOURCE_MISATTRIBUTED_INLINE.citedTitle);
    expect(inline?.identity_conflict).toBe(true);
    expect(inline?.identity_conflict_note).toContain(
      SOURCE_MISATTRIBUTED_INLINE.resolvedTitle,
    );
    expect(inline?.selected).toBe(false);
  });
});

describe("failure class: the identifier resolves to nothing", () => {
  it("fails the capture with a reason rather than storing an empty source", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });

    await expect(
      captureSource(
        {
          projectId: project.projectId,
          kind: "arxiv",
          identifier: SOURCE_UNRESOLVABLE.identifier,
          sourceType: "peer_reviewed_publication",
        },
        { fetcher: cassetteFetcher() },
      ),
    ).rejects.toThrow(/arXiv kennt keine Arbeit/);

    // Nothing half-written: a failed resolution must leave the register
    // exactly as it was.
    const register = await project.read();
    expect(register.sources).toHaveLength(0);
    expect(register.claims).toHaveLength(0);
  });
});

describe("failure class: extraction quotes wording the document lacks", () => {
  it("passes the claim whose quote is present and fails the one whose is not", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });
    const fetcher = cassetteFetcher();
    const source = await captureCleanSource(project.projectId, fetcher);

    // Two extraction passes over the same source: one quoting the document
    // verbatim, one quoting a plausible sentence that is not in it. Stage 1
    // is deterministic and model-free, and this is the assertion that says so.
    for (const seed of [
      extractionSeed(source.id),
      misquotingExtractionSeed(source.id),
    ]) {
      const handle = await startSourceExtraction(project.projectId, source.id, {
        orchestrator: corpusOrchestrator(createReplayBackend({ seed })),
      });
      await handle.done;
    }

    const existence = await startExistenceCheck(project.projectId, { fetcher });
    await existence.done;

    const register = await project.read();
    const byStatus = statusesOf(register);
    const supported = register.claims.find((claim) =>
      claim.evidence.some((evidence) =>
        evidence.verbatim_excerpt.includes(QUOTE_PRESENT),
      ),
    );
    const misquoted = register.claims.find((claim) =>
      claim.evidence.some((evidence) =>
        evidence.verbatim_excerpt.includes(QUOTE_ABSENT),
      ),
    );

    expect(supported?.status).toBe("existence_checked");
    // A misquote is never silently dropped and never auto-failed: it goes to
    // a human.
    expect(misquoted?.status).toBe("pending_adjudication");
    expect(byStatus.discarded).toBeUndefined();
    // Room for the real document: when `documents/` holds the recorded
    // 18-page PDF, the capture parses THAT with unpdf — the entire point of
    // recording — at ~650 ms alone and past the 5 s default under a loaded
    // full-suite run. The cost is the subject here, not fixture waste.
  }, 30_000);
});

describe("failure class: extraction cites a source that was never captured", () => {
  it("keeps the claim and drops only the invented evidence", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });
    const fetcher = cassetteFetcher();
    const source = await captureCleanSource(project.projectId, fetcher);

    // Authored, not recorded: no real model produces this on demand.
    const handle = await startSourceExtraction(project.projectId, source.id, {
      orchestrator: corpusOrchestrator(
        createReplayBackend({ overrides: HALLUCINATED_SOURCE_EXTRACTION }),
      ),
    });
    await handle.done;

    const register = await project.read();
    const claim = register.claims.at(-1);
    expect(claim).toBeDefined();
    // The statement survives — dropping it would hide an unsupported claim,
    // which is the opposite of what this tool is for. Its fabricated
    // citation does not.
    expect(claim?.evidence).toHaveLength(0);
    expect(claim?.status).toBe("pending_adjudication");
    for (const evidence of register.claims.flatMap((entry) => entry.evidence)) {
      expect(register.sources.map((entry) => entry.id)).toContain(
        evidence.source_id,
      );
    }
  });
});

describe("the whole walk, ending where an auditor starts", () => {
  it("exports a bundle the standalone verifier accepts", async () => {
    const project = await createCorpusProject({ briefing: SCENARIO_BRIEFING });
    const fetcher = cassetteFetcher();
    const source = await captureCleanSource(project.projectId, fetcher);

    const extraction = await startSourceExtraction(
      project.projectId,
      source.id,
      {
        orchestrator: corpusOrchestrator(
          createReplayBackend({ seed: extractionSeed(source.id) }),
        ),
      },
    );
    await extraction.done;

    const existence = await startExistenceCheck(project.projectId, { fetcher });
    await existence.done;

    const bundle = await exportProjectBundle(project.projectId, {
      includeBlobs: true,
    });
    expect(bundle.bytes.byteLength).toBeGreaterThan(0);

    // The frozen document travelled with the bundle: without it, an auditor
    // cannot re-run the wording proof, which is the one check that needs no
    // model and no network.
    const register = await project.read();
    const snapshot = (
      register.sources[0] as { custom?: { snapshot?: { blob_path?: string } } }
    ).custom?.snapshot;
    expect(snapshot?.blob_path).toBeDefined();
    expect(
      fs.existsSync(
        path.join(
          workspace.projectDir(project.projectId),
          snapshot?.blob_path as string,
        ),
      ),
    ).toBe(true);

    const verification = await workspace.store(project.projectId).verify();
    expect(verification.errors).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});

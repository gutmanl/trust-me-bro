import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBlobStore } from "../../../register";
import type { BlobStore, Claim, Source } from "../../../register";
import { IdentifierResolutionError } from "../../errors";
import {
  ARXIV_ATOM_RESPONSE,
  CSL_JSON_RESPONSE,
  fakeFetcher,
} from "../../sources/__fixtures__/fake-fetcher";
import { checkClaimExistence } from "./existence-check";
import { checkSourceCached, checkSourceLive } from "./source-check";
import type { SourceCheckCache } from "./source-check";

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const SNAPSHOT_CONTENT = "frozen document bytes";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_a",
    type: "article-journal",
    custom: {
      source_type: "peer_reviewed_publication",
      snapshot: {
        retrieved_at: "2026-08-01T08:00:00Z",
        sha256: sha256(SNAPSHOT_CONTENT),
        blob_path: `blobs/aa/${"a".repeat(64)}.pdf`,
        revision: 1,
      },
    },
    ...overrides,
  } as Source;
}

describe("checkSourceLive", () => {
  it("passes a DOI source whose identifier still resolves", async () => {
    const fetcher = fakeFetcher({
      "https://doi.org/": { body: Buffer.from(CSL_JSON_RESPONSE) },
    });
    const source = makeSource({ DOI: "10.1109/TSE.2025.3489012" });
    await expect(checkSourceLive(source, fetcher)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("fails a DOI the resolver definitively rejects (HTTP status)", async () => {
    const fetcher = fakeFetcher({}); // every URL answers 404
    const source = makeSource({ DOI: "10.9999/tot" });
    await expect(checkSourceLive(source, fetcher)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("HTTP 404"),
    });
  });

  it("propagates transport failures as run errors, never as failed", async () => {
    const failing = {
      fetch: async () => {
        throw new Error("DNS down");
      },
    };
    const source = makeSource({ DOI: "10.9999/netz" });
    await expect(checkSourceLive(source, failing)).rejects.toBeInstanceOf(
      IdentifierResolutionError,
    );
  });

  it("compares a URL source against the frozen snapshot hash", async () => {
    const url = "https://example.org/report";
    const source = makeSource({ URL: url });
    const same = fakeFetcher({
      [url]: { body: Buffer.from(SNAPSHOT_CONTENT) },
    });
    await expect(checkSourceLive(source, same)).resolves.toMatchObject({
      ok: true,
    });
    const changed = fakeFetcher({ [url]: { body: Buffer.from("edited") } });
    await expect(checkSourceLive(source, changed)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("weicht vom eingefrorenen Schnappschuss"),
    });
    const gone = fakeFetcher({});
    await expect(checkSourceLive(source, gone)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("nicht erreichbar"),
    });
  });

  it("re-resolves arXiv sources and re-fetches the PDF", async () => {
    const source = makeSource({ URL: "https://arxiv.org/abs/2401.12345" });
    const fetcher = fakeFetcher({
      "https://export.arxiv.org/": { body: Buffer.from(ARXIV_ATOM_RESPONSE) },
      "https://arxiv.org/pdf/": { body: Buffer.from(SNAPSHOT_CONTENT) },
    });
    await expect(checkSourceLive(source, fetcher)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("passes uploads without identifier or URL vacuously", async () => {
    const fetcher = fakeFetcher({});
    await expect(checkSourceLive(makeSource(), fetcher)).resolves.toMatchObject(
      { ok: true, detail: expect.stringContaining("keine Live-Prüfung") },
    );
    expect(fetcher.calls).toHaveLength(0);
  });
});

describe("checkClaimExistence", () => {
  let dir: string;
  let blobs: BlobStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-stage1-"));
    blobs = createBlobStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeClaim(excerpts: string[]): Claim {
    return {
      id: "clm_0001",
      text: "Testclaim.",
      claim_type: "quantitative_finding",
      status: "captured",
      briefing_anchor: "p1",
      provenance: {
        tool: "t",
        model: "m",
        extracted_at: "2026-08-01T08:00:00Z",
        search_path: "s",
      },
      evidence: excerpts.map((excerpt, index) => ({
        id: `ev_${String(index + 1).padStart(4, "0")}`,
        source_id: "src_a",
        locator: { page: 1 },
        verbatim_excerpt: excerpt,
        judgments: [],
      })),
      history: [
        {
          seq: 2,
          at: "2026-08-01T08:00:00Z",
          actor: "system:extraction",
          from_status: null,
          to_status: "captured",
          reason: "Test.",
          prev_hash: "0".repeat(64),
          hash: "1".repeat(64),
        },
      ],
    };
  }

  function sourceWithText(text: string): {
    source: Source;
    byId: Map<string, Source>;
  } {
    const blob = blobs.put(text, "txt");
    const source = makeSource();
    source.custom.snapshot = {
      ...source.custom.snapshot!,
      text_blob_path: blob.blobPath,
    };
    return { source, byId: new Map([[source.id, source]]) };
  }

  it("proves the wording under whitespace/hyphenation normalization", async () => {
    const { byId } = sourceWithText("Die Review-\nzeit sank    deutlich.");
    const claim = makeClaim(["die Reviewzeit sank deutlich"]);
    const cache: SourceCheckCache = new Map([
      ["src_a", Promise.resolve({ ok: true, detail: "" })],
    ]);
    const results = await checkClaimExistence(claim, byId, {
      blobs,
      fetcher: fakeFetcher({}),
      cache,
    });
    expect(results).toEqual([
      expect.objectContaining({ evidenceId: "ev_0001", status: "passed" }),
    ]);
  });

  it("fails content deviations and text-extraction-error sources", async () => {
    const { byId } = sourceWithText("Die Reviewzeit sank deutlich.");
    const claim = makeClaim(["die Reviewzeit stieg deutlich"]);
    const cache: SourceCheckCache = new Map([
      ["src_a", Promise.resolve({ ok: true, detail: "" })],
    ]);
    const [deviation] = await checkClaimExistence(claim, byId, {
      blobs,
      fetcher: fakeFetcher({}),
      cache,
    });
    expect(deviation.status).toBe("failed");

    const broken = makeSource();
    broken.custom.snapshot = {
      ...broken.custom.snapshot!,
      text_extraction_error: "kein Textlayer",
    };
    const [noText] = await checkClaimExistence(
      makeClaim(["egal"]),
      new Map([["src_a", broken]]),
      { blobs, fetcher: fakeFetcher({}), cache },
    );
    expect(noText.status).toBe("failed");
    expect(noText.detail).toContain("kein Textlayer");
  });

  it("fails evidence of a source whose live check failed, without reading blobs", async () => {
    const { byId } = sourceWithText("Inhalt");
    const claim = makeClaim(["Inhalt"]);
    const cache: SourceCheckCache = new Map([
      ["src_a", Promise.resolve({ ok: false, detail: "HTTP 404" })],
    ]);
    const [result] = await checkClaimExistence(claim, byId, {
      blobs,
      fetcher: fakeFetcher({}),
      cache,
    });
    expect(result).toMatchObject({
      status: "failed",
      detail: "HTTP 404",
    });
  });

  it("checks each source once per run via the cache", async () => {
    const { source, byId } = sourceWithText("Inhalt A und Inhalt B");
    source.URL = "https://example.org/doc";
    source.custom.snapshot = {
      ...source.custom.snapshot!,
      sha256: sha256(SNAPSHOT_CONTENT),
    };
    const fetcher = fakeFetcher({
      "https://example.org/doc": { body: Buffer.from(SNAPSHOT_CONTENT) },
    });
    const cache: SourceCheckCache = new Map();
    const claim = makeClaim(["Inhalt A", "Inhalt B"]);
    await checkClaimExistence(claim, byId, { blobs, fetcher, cache });
    await checkClaimExistence(claim, byId, { blobs, fetcher, cache });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("exposes checkSourceCached for reuse across claims", async () => {
    const fetcher = fakeFetcher({});
    const cache: SourceCheckCache = new Map();
    const source = makeSource();
    const first = await checkSourceCached(source, fetcher, cache);
    const second = await checkSourceCached(source, fetcher, cache);
    expect(first).toEqual(second);
    expect(cache.size).toBe(1);
  });
});

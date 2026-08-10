import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  CROSSREF_WORK_NO_LINK_RESPONSE,
  CROSSREF_WORK_WITH_PDF_LINK_RESPONSE,
  fakeFetcher,
  UNPAYWALL_NO_OA_RESPONSE,
  UNPAYWALL_OA_RESPONSE,
} from "../__fixtures__/fake-fetcher";
import { deriveDocumentUrl } from "./derive-document-url";

const DOI = "10.1109/TSE.2025.3489012";
const CROSSREF_WORK_URL = `https://api.crossref.org/works/${encodeURIComponent(DOI)}`;
const UNPAYWALL_URL = "https://api.unpaywall.org/v2/";

// getUnpaywallEmail() falls through to the real ~/.trustmebro/config.json
// when TMB_CONFIG_PATH is unset — point it at a scratch (non-existent by
// default) file so every test is isolated from the developer machine's
// actual configuration.
let configPath: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-derive-docurl-"));
  configPath = path.join(dir, "config.json");
  vi.stubEnv("TMB_CONFIG_PATH", configPath);
  vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
});

describe("deriveDocumentUrl", () => {
  it("derives the arXiv PDF URL without any network call, taking priority over a DOI", async () => {
    const fetcher = fakeFetcher({});
    const result = await deriveDocumentUrl(
      { arxivId: "2401.12345", doi: DOI },
      { fetcher },
    );
    expect(result).toEqual({
      documentUrl: "https://arxiv.org/pdf/2401.12345",
      source: "arxiv",
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("uses Crossref's own PDF link when arXiv is absent and a link exists", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_WORK_URL]: {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORK_WITH_PDF_LINK_RESPONSE),
      },
    });
    const result = await deriveDocumentUrl({ doi: DOI }, { fetcher });
    expect(result).toEqual({
      documentUrl: "https://publisher.example.org/paper.pdf",
      source: "crossref_pdf",
    });
    // Unpaywall never consulted once Crossref already answered.
    expect(fetcher.calls.some((c) => c.url.includes("unpaywall"))).toBe(false);
  });

  it("falls back to Unpaywall when Crossref has no PDF link and an e-mail is configured", async () => {
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", "lg@example.org");
    const fetcher = fakeFetcher({
      [CROSSREF_WORK_URL]: {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORK_NO_LINK_RESPONSE),
      },
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_OA_RESPONSE),
      },
    });
    const result = await deriveDocumentUrl({ doi: DOI }, { fetcher });
    expect(result).toEqual({
      documentUrl: "https://oa.example.org/best.pdf",
      source: "unpaywall",
    });
  });

  it("skips Unpaywall (no call at all) when no e-mail is configured", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_WORK_URL]: {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORK_NO_LINK_RESPONSE),
      },
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_OA_RESPONSE),
      },
    });
    const result = await deriveDocumentUrl({ doi: DOI }, { fetcher });
    expect(result).toEqual({});
    expect(fetcher.calls.some((c) => c.url.includes("unpaywall"))).toBe(false);
  });

  it("resolves to no document_url, never throwing, when every step comes up empty", async () => {
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", "lg@example.org");
    const fetcher = fakeFetcher({
      [CROSSREF_WORK_URL]: {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORK_NO_LINK_RESPONSE),
      },
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_NO_OA_RESPONSE),
      },
    });
    await expect(deriveDocumentUrl({ doi: DOI }, { fetcher })).resolves.toEqual(
      {},
    );
  });

  it("is never fatal on network errors anywhere in the chain", async () => {
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", "lg@example.org");
    const fetcher = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(deriveDocumentUrl({ doi: DOI }, { fetcher })).resolves.toEqual(
      {},
    );
  });

  it("returns nothing, without any network call, when neither identifier is present", async () => {
    const fetcher = fakeFetcher({});
    await expect(deriveDocumentUrl({}, { fetcher })).resolves.toEqual({});
    expect(fetcher.calls).toHaveLength(0);
  });
});

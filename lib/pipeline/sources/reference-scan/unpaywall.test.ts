import { describe, expect, it, vi } from "vitest";

import {
  UNPAYWALL_FALLBACK_LOCATION_RESPONSE,
  UNPAYWALL_NO_OA_RESPONSE,
  UNPAYWALL_OA_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import { fetchUnpaywallPdfUrl } from "./unpaywall";

const DOI = "10.1109/TSE.2025.3489012";
const UNPAYWALL_URL = "https://api.unpaywall.org/v2/";

describe("fetchUnpaywallPdfUrl", () => {
  it("returns best_oa_location's url_for_pdf on an OA hit", async () => {
    const fetcher = fakeFetcher({
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_OA_RESPONSE),
      },
    });
    await expect(
      fetchUnpaywallPdfUrl(DOI, "lg@example.org", fetcher),
    ).resolves.toBe("https://oa.example.org/best.pdf");
    expect(fetcher.calls[0]?.url).toContain("email=lg%40example.org");
  });

  it("falls back to the first non-empty oa_locations[] entry when best_oa_location has none", async () => {
    const fetcher = fakeFetcher({
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_FALLBACK_LOCATION_RESPONSE),
      },
    });
    await expect(
      fetchUnpaywallPdfUrl(DOI, "lg@example.org", fetcher),
    ).resolves.toBe("https://oa.example.org/fallback.pdf");
  });

  it("returns undefined when there is no open-access location at all", async () => {
    const fetcher = fakeFetcher({
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_NO_OA_RESPONSE),
      },
    });
    await expect(
      fetchUnpaywallPdfUrl(DOI, "lg@example.org", fetcher),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on a non-200 response, never throwing", async () => {
    const fetcher = fakeFetcher({ [UNPAYWALL_URL]: { status: 500 } });
    await expect(
      fetchUnpaywallPdfUrl(DOI, "lg@example.org", fetcher),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on a network error, never throwing", async () => {
    const fetcher = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(
      fetchUnpaywallPdfUrl(DOI, "lg@example.org", fetcher),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on malformed JSON", async () => {
    const fetcher = fakeFetcher({
      [UNPAYWALL_URL]: { status: 200, body: Buffer.from("not json") },
    });
    await expect(
      fetchUnpaywallPdfUrl(DOI, "lg@example.org", fetcher),
    ).resolves.toBeUndefined();
  });

  it("skips the call entirely when no e-mail is configured", async () => {
    const fetcher = fakeFetcher({
      [UNPAYWALL_URL]: {
        contentType: "application/json",
        body: Buffer.from(UNPAYWALL_OA_RESPONSE),
      },
    });
    await expect(
      fetchUnpaywallPdfUrl(DOI, null, fetcher),
    ).resolves.toBeUndefined();
    expect(fetcher.calls).toHaveLength(0);
  });
});

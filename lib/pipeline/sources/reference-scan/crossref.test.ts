import { describe, expect, it, vi } from "vitest";

import {
  CROSSREF_WORKS_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import { searchCrossref } from "./crossref";

const CROSSREF_URL = "https://api.crossref.org/works";

describe("searchCrossref", () => {
  it("returns the extracted works on a 200 response", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORKS_RESPONSE),
      },
    });
    const works = await searchCrossref("Effects of AI on Code Review", fetcher);
    expect(works).toEqual([
      {
        doi: "10.1109/TSE.2025.3489012",
        title: "Effects of AI Assistants on Code Review Duration",
        authors: ["Meyer"],
        year: 2025,
        venue: "IEEE Transactions on Software Engineering",
      },
    ]);
    expect(fetcher.calls[0].url).toContain("query.bibliographic=");
  });

  it("returns [] on a network error, never throwing", async () => {
    const fetcher = {
      fetch: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    };
    await expect(searchCrossref("x", fetcher)).resolves.toEqual([]);
  });

  it("returns [] on a non-200, non-429 response", async () => {
    const fetcher = fakeFetcher({ [CROSSREF_URL]: { status: 500 } });
    await expect(searchCrossref("x", fetcher)).resolves.toEqual([]);
  });

  it("returns [] on malformed JSON", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: { status: 200, body: Buffer.from("not json") },
    });
    await expect(searchCrossref("x", fetcher)).resolves.toEqual([]);
  });

  it("waits once and retries once on a 429 with a Retry-After <= 10s, then succeeds", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: [
        { status: 429, retryAfterMs: 5_000 },
        {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORKS_RESPONSE),
        },
      ],
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const works = await searchCrossref("x", fetcher, { sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(works).toHaveLength(1);
    expect(fetcher.calls).toHaveLength(2);
  });

  it("gives up after a second 429 (retries exactly once)", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: [
        { status: 429, retryAfterMs: 1_000 },
        { status: 429, retryAfterMs: 1_000 },
      ],
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const works = await searchCrossref("x", fetcher, { sleep });
    expect(works).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetcher.calls).toHaveLength(2);
  });

  it("gives up immediately on a 429 with no Retry-After header", async () => {
    const fetcher = fakeFetcher({ [CROSSREF_URL]: { status: 429 } });
    const sleep = vi.fn();
    const works = await searchCrossref("x", fetcher, { sleep });
    expect(works).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher.calls).toHaveLength(1);
  });

  it("gives up immediately on a 429 with a Retry-After over 10s", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: { status: 429, retryAfterMs: 15_000 },
    });
    const sleep = vi.fn();
    const works = await searchCrossref("x", fetcher, { sleep });
    expect(works).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetcher.calls).toHaveLength(1);
  });
});

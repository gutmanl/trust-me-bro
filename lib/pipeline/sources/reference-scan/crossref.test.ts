import { describe, expect, it, vi } from "vitest";

import {
  CROSSREF_WORK_NON_PDF_LINK_RESPONSE,
  CROSSREF_WORK_NO_LINK_RESPONSE,
  CROSSREF_WORK_WITH_PDF_LINK_RESPONSE,
  CROSSREF_WORKS_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import { fetchCrossrefWorkByDoi, searchCrossref } from "./crossref";

const CROSSREF_URL = "https://api.crossref.org/works";
const CROSSREF_WORK_URL =
  "https://api.crossref.org/works/10.1109%2FTSE.2025.3489012";

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

  it("extracts pdfUrl from a link[] entry with content-type application/pdf", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            status: "ok",
            message: {
              items: [JSON.parse(CROSSREF_WORK_WITH_PDF_LINK_RESPONSE).message],
            },
          }),
        ),
      },
    });
    const works = await searchCrossref("x", fetcher);
    expect(works[0]?.pdfUrl).toBe("https://publisher.example.org/paper.pdf");
  });

  it("ignores non-PDF link entries (never a landing page)", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            status: "ok",
            message: {
              items: [JSON.parse(CROSSREF_WORK_NON_PDF_LINK_RESPONSE).message],
            },
          }),
        ),
      },
    });
    const works = await searchCrossref("x", fetcher);
    expect(works[0]?.pdfUrl).toBeUndefined();
  });

  it("leaves pdfUrl undefined when there is no link[] at all", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_URL]: {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            status: "ok",
            message: {
              items: [JSON.parse(CROSSREF_WORK_NO_LINK_RESPONSE).message],
            },
          }),
        ),
      },
    });
    const works = await searchCrossref("x", fetcher);
    expect(works[0]?.pdfUrl).toBeUndefined();
  });
});

describe("fetchCrossrefWorkByDoi", () => {
  it("returns the extracted work, including pdfUrl, on a 200 response", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_WORK_URL]: {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORK_WITH_PDF_LINK_RESPONSE),
      },
    });
    const work = await fetchCrossrefWorkByDoi(
      "10.1109/TSE.2025.3489012",
      fetcher,
    );
    expect(work).toMatchObject({
      doi: "10.1109/TSE.2025.3489012",
      pdfUrl: "https://publisher.example.org/paper.pdf",
    });
  });

  it("returns null on a network error, never throwing", async () => {
    const fetcher = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(
      fetchCrossrefWorkByDoi("10.1109/TSE.2025.3489012", fetcher),
    ).resolves.toBeNull();
  });

  it("returns null on a non-200 response", async () => {
    const fetcher = fakeFetcher({ [CROSSREF_WORK_URL]: { status: 404 } });
    await expect(
      fetchCrossrefWorkByDoi("10.1109/TSE.2025.3489012", fetcher),
    ).resolves.toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const fetcher = fakeFetcher({
      [CROSSREF_WORK_URL]: { status: 200, body: Buffer.from("not json") },
    });
    await expect(
      fetchCrossrefWorkByDoi("10.1109/TSE.2025.3489012", fetcher),
    ).resolves.toBeNull();
  });
});

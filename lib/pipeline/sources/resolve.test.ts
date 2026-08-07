import { describe, expect, it } from "vitest";

import { IdentifierResolutionError } from "../errors";
import {
  ARXIV_ATOM_RESPONSE,
  ARXIV_EMPTY_FEED,
  CSL_JSON_RESPONSE,
  fakeFetcher,
} from "./__fixtures__/fake-fetcher";
import { resolveArxiv, resolveDoi } from "./resolve";

describe("resolveDoi", () => {
  it("negotiates CSL-JSON from doi.org and drops the resolver id", async () => {
    const fetcher = fakeFetcher({
      "https://doi.org/10.1109/": {
        contentType: "application/vnd.citationstyles.csl+json",
        body: Buffer.from(CSL_JSON_RESPONSE),
      },
    });
    const { item, documentUrl } = await resolveDoi(
      "10.1109/TSE.2025.3489012",
      fetcher,
    );
    expect(item.id).toBeUndefined();
    expect(item.title).toBe("Effects of AI Assistants on Code Review Duration");
    expect(item.DOI).toBe("10.1109/TSE.2025.3489012");
    expect(documentUrl).toBeUndefined();
    expect(fetcher.calls[0].options?.accept).toBe(
      "application/vnd.citationstyles.csl+json",
    );
    // The DOI suffix must keep its slash un-encoded for doi.org.
    expect(fetcher.calls[0].url).toBe(
      "https://doi.org/10.1109/TSE.2025.3489012",
    );
  });

  it("throws IdentifierResolutionError for HTTP errors and bad JSON", async () => {
    await expect(
      resolveDoi("10.1000/unbekannt", fakeFetcher({})),
    ).rejects.toBeInstanceOf(IdentifierResolutionError);
    await expect(
      resolveDoi(
        "10.1000/kaputt",
        fakeFetcher({
          "https://doi.org/10.1000/kaputt": { body: Buffer.from("<html>") },
        }),
      ),
    ).rejects.toBeInstanceOf(IdentifierResolutionError);
  });

  it("wraps network failures", async () => {
    const fetcher = {
      fetch: () => Promise.reject(new Error("offline")),
    };
    await expect(resolveDoi("10.1000/x", fetcher)).rejects.toBeInstanceOf(
      IdentifierResolutionError,
    );
  });
});

describe("resolveArxiv", () => {
  it("maps the Atom entry onto a CSL core with derived PDF URL", async () => {
    const fetcher = fakeFetcher({
      "https://export.arxiv.org/": {
        contentType: "application/atom+xml",
        body: Buffer.from(ARXIV_ATOM_RESPONSE),
      },
    });
    const { item, documentUrl } = await resolveArxiv("2401.12345", fetcher);
    expect(item.title).toBe("Large Language Models for Code Review");
    expect(item.author).toEqual([
      { family: "Meyer", given: "Anna" },
      { family: "Schulz", given: "Ben" },
    ]);
    expect(item.issued).toEqual({ "date-parts": [[2024]] });
    expect(item.URL).toBe("https://arxiv.org/abs/2401.12345");
    expect(documentUrl).toBe("https://arxiv.org/pdf/2401.12345");
  });

  it("throws for unknown ids (empty feed) and HTTP errors", async () => {
    await expect(
      resolveArxiv(
        "2401.99999",
        fakeFetcher({
          "https://export.arxiv.org/": { body: Buffer.from(ARXIV_EMPTY_FEED) },
        }),
      ),
    ).rejects.toBeInstanceOf(IdentifierResolutionError);
    await expect(
      resolveArxiv("2401.12345", fakeFetcher({})),
    ).rejects.toBeInstanceOf(IdentifierResolutionError);
  });

  it("wraps network failures", async () => {
    const fetcher = {
      fetch: () => Promise.reject(new Error("offline")),
    };
    await expect(resolveArxiv("2401.12345", fetcher)).rejects.toBeInstanceOf(
      IdentifierResolutionError,
    );
  });
});

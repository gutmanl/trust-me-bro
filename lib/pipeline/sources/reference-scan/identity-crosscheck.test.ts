import { describe, expect, it } from "vitest";

import {
  CROSSREF_WORKS_RESPONSE,
  CSL_JSON_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import type { CandidateSeed } from "./candidate";
import { crossCheckIdentifiedSeed } from "./identity-crosscheck";

const WRONG_PAPER_CSL = JSON.stringify({
  type: "article-journal",
  title: "Yak Husbandry in High-Altitude Pastoral Systems",
  author: [{ family: "Dorje", given: "T." }],
  issued: { "date-parts": [[1998]] },
  DOI: "10.9999/halluziniert.123",
});

const SEED: CandidateSeed = {
  raw_text: "Meyer, A. (2025). Effects of AI Assistants …",
  method: "doi",
  doi: "10.9999/halluziniert.123",
  title: "Effects of AI Assistants on Code Review Duration",
  authors: ["Anna Meyer"],
  year: 2025,
};

describe("crossCheckIdentifiedSeed", () => {
  it("flags a conflict and attaches the title's own hypothesis", async () => {
    const fetcher = fakeFetcher({
      "https://doi.org/": {
        contentType: "application/vnd.citationstyles.csl+json",
        body: Buffer.from(WRONG_PAPER_CSL),
      },
      "https://api.crossref.org/works?": {
        contentType: "application/json",
        body: Buffer.from(CROSSREF_WORKS_RESPONSE),
      },
    });
    const checked = await crossCheckIdentifiedSeed(SEED, fetcher);
    expect(checked.identity_conflict).toBe(true);
    expect(checked.identity_conflict_note).toContain("anderen Werk");
    expect(checked.alternate_title_match?.doi).toBe("10.1109/TSE.2025.3489012");
  });

  it("passes a seed whose identifier agrees with its title untouched", async () => {
    const fetcher = fakeFetcher({
      "https://doi.org/": {
        contentType: "application/vnd.citationstyles.csl+json",
        body: Buffer.from(CSL_JSON_RESPONSE),
      },
    });
    const checked = await crossCheckIdentifiedSeed(
      { ...SEED, doi: "10.1109/TSE.2025.3489012" },
      fetcher,
    );
    expect(checked.identity_conflict).toBeUndefined();
  });

  it("fails open when the identifier does not resolve", async () => {
    const checked = await crossCheckIdentifiedSeed(SEED, fakeFetcher({}));
    expect(checked).toEqual(SEED);
  });

  it("skips seeds without a title to compare against", async () => {
    const seed: CandidateSeed = {
      raw_text: "https://doi.org/10.9999/x",
      method: "doi",
      doi: "10.9999/x",
    };
    expect(await crossCheckIdentifiedSeed(seed, fakeFetcher({}))).toEqual(seed);
  });
});

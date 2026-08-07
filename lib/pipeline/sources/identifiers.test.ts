import { describe, expect, it } from "vitest";

import { isHttpUrl, normalizeArxivId, normalizeDoi } from "./identifiers";

describe("normalizeDoi", () => {
  it("accepts bare, prefixed and resolver-URL forms", () => {
    expect(normalizeDoi("10.1109/TSE.2025.3489012")).toBe(
      "10.1109/TSE.2025.3489012",
    );
    expect(normalizeDoi("doi:10.1109/TSE.2025.3489012")).toBe(
      "10.1109/TSE.2025.3489012",
    );
    expect(normalizeDoi("https://doi.org/10.1109/TSE.2025.3489012")).toBe(
      "10.1109/TSE.2025.3489012",
    );
  });

  it("strips trailing punctuation from pasted text", () => {
    expect(normalizeDoi("10.1000/xyz123.")).toBe("10.1000/xyz123");
  });

  it("rejects non-DOIs", () => {
    expect(normalizeDoi("https://example.org/paper")).toBeNull();
    expect(normalizeDoi("")).toBeNull();
  });
});

describe("normalizeArxivId", () => {
  it("accepts bare, prefixed and URL forms and drops the version", () => {
    expect(normalizeArxivId("2401.12345")).toBe("2401.12345");
    expect(normalizeArxivId("arXiv:2401.12345v2")).toBe("2401.12345");
    expect(normalizeArxivId("https://arxiv.org/abs/2401.12345")).toBe(
      "2401.12345",
    );
  });

  it("rejects non-arXiv input", () => {
    expect(normalizeArxivId("10.1000/xyz123")).toBeNull();
    expect(normalizeArxivId("kein-identifier")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it("accepts http(s) and rejects everything else", () => {
    expect(isHttpUrl("https://example.org/paper.pdf")).toBe(true);
    expect(isHttpUrl("http://example.org")).toBe(true);
    expect(isHttpUrl("ftp://example.org")).toBe(false);
    expect(isHttpUrl("kein url")).toBe(false);
  });
});

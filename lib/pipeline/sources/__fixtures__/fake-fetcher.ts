import type { FetchedResource, FetchOptions, HttpFetcher } from "../fetch-port";

export interface RecordedFetch {
  url: string;
  options: FetchOptions | undefined;
}

/**
 * Test double of the HttpFetcher port: serves canned responses by URL
 * prefix and records every call. Unknown URLs yield a 404. A route may also
 * be an ARRAY of responses, consumed one per call to that prefix (the last
 * entry sticks once exhausted) — used to script a 429-then-success sequence
 * for the Crossref Retry-After retry path.
 */
export function fakeFetcher(
  routes: Record<string, Partial<FetchedResource> | Partial<FetchedResource>[]>,
): HttpFetcher & { calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const callCounts = new Map<string, number>();
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      const match = Object.entries(routes).find(([prefix]) =>
        url.startsWith(prefix),
      );
      if (!match) {
        return { status: 404, contentType: null, body: Buffer.alloc(0) };
      }
      const [prefix, config] = match;
      let entry: Partial<FetchedResource>;
      if (Array.isArray(config)) {
        const index = callCounts.get(prefix) ?? 0;
        entry = config[Math.min(index, config.length - 1)];
        callCounts.set(prefix, index + 1);
      } else {
        entry = config;
      }
      return {
        status: entry.status ?? 200,
        contentType: entry.contentType ?? null,
        body: entry.body ?? Buffer.alloc(0),
        ...(entry.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: entry.retryAfterMs }),
      };
    },
  };
}

export const CSL_JSON_RESPONSE = JSON.stringify({
  id: "resolver-echo",
  type: "article-journal",
  title: "Effects of AI Assistants on Code Review Duration",
  author: [{ family: "Meyer", given: "A." }],
  issued: { "date-parts": [[2025, 11]] },
  "container-title": "IEEE Transactions on Software Engineering",
  DOI: "10.1109/TSE.2025.3489012",
});

export const ARXIV_ATOM_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Large Language Models
      for Code Review</title>
    <published>2024-01-23T18:00:00Z</published>
    <author><name>Anna Meyer</name></author>
    <author><name>Ben Schulz</name></author>
  </entry>
</feed>`;

export const ARXIV_EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

/** A single-item Crossref /works response (reference auto-import), shaped
 * defensively-extractable per crossref.ts: DOI, title array, author array
 * with family names, issued date-parts, container-title array. */
export const CROSSREF_WORKS_RESPONSE = JSON.stringify({
  status: "ok",
  message: {
    items: [
      {
        DOI: "10.1109/TSE.2025.3489012",
        title: ["Effects of AI Assistants on Code Review Duration"],
        author: [{ family: "Meyer", given: "Anna" }],
        issued: { "date-parts": [[2025]] },
        "container-title": ["IEEE Transactions on Software Engineering"],
      },
    ],
  },
});

/** A healthy Crossref /works response with zero matching items (reference
 * auto-import, I3): status 200, valid JSON, genuinely nothing found — distinct
 * from a network error / non-200 / malformed body, which is what actually
 * makes Crossref "unavailable" (see crossref.ts's `unavailable` flag). */
export const CROSSREF_EMPTY_RESULTS_RESPONSE = JSON.stringify({
  status: "ok",
  message: { items: [] },
});

/** A single-work Crossref /works/<doi> response (reference auto-import,
 * Task 3b document-url derivation) whose link[] carries a PDF entry —
 * `fetchCrossrefWorkByDoi` should extract its URL as `pdfUrl`. */
/**
 * A Crossref work whose link[] entries are shaped like a PDF but carry
 * content-type "unspecified" — the real ACM/IEEE shape that made a
 * perfectly good PDF link invisible to the strict step 2 of the derivation
 * chain (the landing page is deliberately listed first, so a test that
 * passes cannot be picking the first entry by accident).
 */
export const CROSSREF_WORK_UNSPECIFIED_PDF_LINK_RESPONSE = JSON.stringify({
  status: "ok",
  message: {
    DOI: "10.1109/TSE.2025.3489012",
    title: ["Effects of AI Assistants on Code Review Duration"],
    author: [{ family: "Meyer", given: "Anna" }],
    issued: { "date-parts": [[2025]] },
    "container-title": ["IEEE Transactions on Software Engineering"],
    link: [
      {
        URL: "https://publisher.example.org/doi/10.1109/TSE.2025.3489012",
        "content-type": "unspecified",
      },
      {
        URL: "https://publisher.example.org/doi/pdf/10.1109/TSE.2025.3489012",
        "content-type": "unspecified",
      },
    ],
  },
});

export const CROSSREF_WORK_WITH_PDF_LINK_RESPONSE = JSON.stringify({
  status: "ok",
  message: {
    DOI: "10.1109/TSE.2025.3489012",
    title: ["Effects of AI Assistants on Code Review Duration"],
    author: [{ family: "Meyer", given: "Anna" }],
    issued: { "date-parts": [[2025]] },
    "container-title": ["IEEE Transactions on Software Engineering"],
    link: [
      {
        URL: "https://publisher.example.org/landing/10.1109",
        "content-type": "text/html",
        "content-version": "vor",
        "intended-application": "similarity-checking",
      },
      {
        URL: "https://publisher.example.org/paper.pdf",
        "content-type": "application/pdf",
        "content-version": "vor",
        "intended-application": "text-mining",
      },
    ],
  },
});

/** Same work, but link[] holds only a non-PDF entry — no pdfUrl should be
 * extracted (never fall back to a landing page). */
export const CROSSREF_WORK_NON_PDF_LINK_RESPONSE = JSON.stringify({
  status: "ok",
  message: {
    DOI: "10.1109/TSE.2025.3489012",
    title: ["Effects of AI Assistants on Code Review Duration"],
    author: [{ family: "Meyer", given: "Anna" }],
    link: [
      {
        URL: "https://publisher.example.org/landing/10.1109",
        "content-type": "text/html",
      },
    ],
  },
});

/** Same work with no link[] at all. */
export const CROSSREF_WORK_NO_LINK_RESPONSE = JSON.stringify({
  status: "ok",
  message: {
    DOI: "10.1109/TSE.2025.3489012",
    title: ["Effects of AI Assistants on Code Review Duration"],
    author: [{ family: "Meyer", given: "Anna" }],
  },
});

/** Unpaywall response (reference auto-import, Task 3b) with a best OA
 * location carrying a PDF URL. */
export const UNPAYWALL_OA_RESPONSE = JSON.stringify({
  doi: "10.1109/TSE.2025.3489012",
  best_oa_location: {
    url_for_pdf: "https://oa.example.org/best.pdf",
  },
  oa_locations: [{ url_for_pdf: "https://oa.example.org/best.pdf" }],
});

/** Unpaywall response with no best_oa_location but a usable oa_locations[]
 * fallback entry. */
export const UNPAYWALL_FALLBACK_LOCATION_RESPONSE = JSON.stringify({
  doi: "10.1109/TSE.2025.3489012",
  best_oa_location: null,
  oa_locations: [
    { url_for_pdf: null },
    { url_for_pdf: "https://oa.example.org/fallback.pdf" },
  ],
});

/** Unpaywall response for a work with no open-access location at all. */
export const UNPAYWALL_NO_OA_RESPONSE = JSON.stringify({
  doi: "10.1109/TSE.2025.3489012",
  best_oa_location: null,
  oa_locations: [],
});

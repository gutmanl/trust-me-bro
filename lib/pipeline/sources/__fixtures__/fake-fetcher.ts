import type { FetchedResource, FetchOptions, HttpFetcher } from "../fetch-port";

export interface RecordedFetch {
  url: string;
  options: FetchOptions | undefined;
}

/**
 * Test double of the HttpFetcher port: serves canned responses by URL
 * prefix and records every call. Unknown URLs yield a 404.
 */
export function fakeFetcher(
  routes: Record<string, Partial<FetchedResource>>,
): HttpFetcher & { calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
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
      return {
        status: match[1].status ?? 200,
        contentType: match[1].contentType ?? null,
        body: match[1].body ?? Buffer.alloc(0),
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

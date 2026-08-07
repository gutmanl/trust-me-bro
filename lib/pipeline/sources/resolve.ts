import { XMLParser } from "fast-xml-parser";

import { IdentifierResolutionError } from "../errors";
import type { CslName } from "./csl";
import type { HttpFetcher } from "./fetch-port";

/**
 * Identifier resolution (TMB-23): DOI via doi.org content negotiation —
 * the resolver answers with CSL-JSON directly, no translation layer (F4) —
 * and arXiv via the export API's Atom feed, mapped onto a CSL-JSON core.
 */

const CSL_ACCEPT = "application/vnd.citationstyles.csl+json";

/** Resolved bibliographic core plus, where derivable, the document URL. */
export interface ResolvedMetadata {
  item: Record<string, unknown>;
  /** URL of the source document, when the identifier determines one
   * (arXiv PDF); DOI landing pages are paywalled too often to guess. */
  documentUrl?: string;
}

export async function resolveDoi(
  doi: string,
  fetcher: HttpFetcher,
): Promise<ResolvedMetadata> {
  const url = `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, "/")}`;
  let resource;
  try {
    resource = await fetcher.fetch(url, { accept: CSL_ACCEPT });
  } catch (error) {
    throw new IdentifierResolutionError(
      `DOI "${doi}" konnte nicht aufgelöst werden (Netzwerkfehler).`,
      { cause: error },
    );
  }
  if (resource.status !== 200) {
    throw new IdentifierResolutionError(
      `DOI "${doi}" konnte nicht aufgelöst werden (HTTP ${resource.status}).`,
    );
  }
  let item: Record<string, unknown>;
  try {
    item = JSON.parse(resource.body.toString("utf8"));
  } catch (error) {
    throw new IdentifierResolutionError(
      `Antwort des DOI-Resolvers für "${doi}" ist kein gültiges CSL-JSON.`,
      { cause: error },
    );
  }
  // The resolver echoes its own id/indexing fields; the register mints ids.
  delete item.id;
  if (typeof item.DOI !== "string") {
    item.DOI = doi;
  }
  return { item };
}

interface AtomAuthor {
  name?: string;
}

function atomAuthorsToCsl(authors: AtomAuthor | AtomAuthor[]): CslName[] {
  const list = Array.isArray(authors) ? authors : [authors];
  return list
    .map((author) => (author.name ?? "").trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const words = name.split(/\s+/);
      return words.length > 1
        ? {
            family: words[words.length - 1],
            given: words.slice(0, -1).join(" "),
          }
        : { literal: name };
    });
}

export async function resolveArxiv(
  arxivId: string,
  fetcher: HttpFetcher,
): Promise<ResolvedMetadata> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
  let resource;
  try {
    resource = await fetcher.fetch(url, { accept: "application/atom+xml" });
  } catch (error) {
    throw new IdentifierResolutionError(
      `arXiv-Id "${arxivId}" konnte nicht aufgelöst werden (Netzwerkfehler).`,
      { cause: error },
    );
  }
  if (resource.status !== 200) {
    throw new IdentifierResolutionError(
      `arXiv-Id "${arxivId}" konnte nicht aufgelöst werden (HTTP ${resource.status}).`,
    );
  }
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(
    resource.body.toString("utf8"),
  ) as Record<string, unknown>;
  const feed = parsed.feed as
    { entry?: Record<string, unknown> | Record<string, unknown>[] } | undefined;
  const entry = Array.isArray(feed?.entry) ? feed?.entry[0] : feed?.entry;
  if (!entry || typeof entry.title !== "string") {
    throw new IdentifierResolutionError(
      `arXiv kennt keine Arbeit mit der Id "${arxivId}".`,
    );
  }

  const item: Record<string, unknown> = {
    type: "article",
    title: entry.title.replace(/\s+/g, " ").trim(),
    URL: `https://arxiv.org/abs/${arxivId}`,
  };
  if (entry.author) {
    item.author = atomAuthorsToCsl(entry.author as AtomAuthor | AtomAuthor[]);
  }
  if (typeof entry.published === "string") {
    const year = Number(entry.published.slice(0, 4));
    if (Number.isInteger(year)) {
      item.issued = { "date-parts": [[year]] };
    }
  }
  const doi = entry["arxiv:doi"];
  if (typeof doi === "string" && doi.length > 0) {
    item.DOI = doi;
  }
  return { item, documentUrl: `https://arxiv.org/pdf/${arxivId}` };
}

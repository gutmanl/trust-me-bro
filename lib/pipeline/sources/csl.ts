import type { Source } from "../../register";

/**
 * CSL-JSON handling of the source capture. The register keeps sources as
 * loose CSL-JSON items plus the workshop's `custom` block (F4: stripping
 * `custom` yields a plain CSL-JSON item). This module builds the
 * bibliographic core; capture.ts adds the `custom` block.
 */

/** One CSL-JSON author entry. */
export type CslName = { family: string; given?: string } | { literal: string };

/** The manual metadata the capture forms offer. */
export interface ManualMetadata {
  title: string;
  /** "Nachname, Vorname; Nachname, Vorname" or free text. */
  authors?: string;
  year?: string;
  container_title?: string;
  url?: string;
}

/** Parses the manual author field: entries split by ";", each either
 * "Family, Given" or a literal name. */
export function parseAuthors(raw: string): CslName[] {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const comma = entry.indexOf(",");
      if (comma > 0) {
        const family = entry.slice(0, comma).trim();
        const given = entry.slice(comma + 1).trim();
        return given ? { family, given } : { family };
      }
      return { literal: entry };
    });
}

/** Bibliographic core of a manually described source (URL or upload). */
export function buildManualCslItem(
  meta: ManualMetadata,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: meta.url ? "webpage" : "document",
    title: meta.title,
  };
  if (meta.authors && meta.authors.trim().length > 0) {
    item.author = parseAuthors(meta.authors);
  }
  if (meta.year && /^\d{4}$/.test(meta.year.trim())) {
    item.issued = { "date-parts": [[Number(meta.year.trim())]] };
  }
  if (meta.container_title && meta.container_title.trim().length > 0) {
    item["container-title"] = meta.container_title.trim();
  }
  if (meta.url) {
    item.URL = meta.url;
  }
  return item;
}

// F4 filter projection; moved into the register core with TMB-6 (the export
// epic's references.csl.json derivation shares it), re-exported here so the
// capture module and the pipeline barrel keep their import path.
export { toPlainCsl } from "../../register";

/** First author's family name, if determinable. */
export function firstAuthorFamily(
  item: Record<string, unknown>,
): string | undefined {
  const authors = item.author;
  if (!Array.isArray(authors) || authors.length === 0) {
    return undefined;
  }
  // Author entries are schema-unvalidated `unknown`: `previous_identities[].item`
  // is a bare `z.record(z.string(), z.unknown())` and `Source` is a looseObject,
  // and for a DOI-resolved source the array comes verbatim out of the resolver's
  // response (resolve.ts JSON.parses and stores `item` unfiltered). A `null`
  // entry must therefore degrade to "no author" — reading `.family` off it threw
  // a TypeError, and this function runs inside the project page's server
  // render, so one malformed entry in the append-only register took the whole
  // page down and with it the only UI that can correct the source.
  // Same guard shape as reference-scan/crossref.ts.
  const first = authors[0] as Record<string, unknown> | null | undefined;
  if (first === null || typeof first !== "object") {
    return undefined;
  }
  if (typeof first.family === "string" && first.family.length > 0) {
    return first.family;
  }
  // TRIMMED length, not raw length: a whitespace-only literal determines no
  // name, but the raw-length gate let it through and the trim-split-last-word
  // extraction below then yielded the EMPTY STRING — a value that is
  // `!== undefined` and still means "no author". Same shape as `nameOf` in
  // auto-repair/repair-input.ts.
  //
  // Why that mattered. This function has FOUR callers, and each of them asks
  // "is there an author?" of its result:
  //   1. formatCitationItem below — `const head = family ? … : …`, truthiness;
  //   2. deriveOriginalIdentity (sources/original-identity.ts) — which asked
  //      `!== undefined`;
  //   3. mintSourceId via sources/capture.ts, guarded in ids.ts by
  //      `hint.family && hint.family.trim().length > 0`;
  //   4. reference-scan/identity-crosscheck.ts — `authors: family ? [family] : []`.
  // One, three and four rejected the empty string exactly as they reject
  // `undefined`, so they read it as "no author". Caller two did not, so it saw
  // an author where the other three saw none: it emitted the archived title as
  // its own line while formatCitationItem was simultaneously using that same
  // title as the citation head, printing the paper's name twice (G-01-3).
  // Returning a value that is defined and yet means "no author" makes the
  // answer depend on which caller asks; returning `undefined` makes it one
  // answer everywhere.
  if (typeof first.literal === "string" && first.literal.trim().length > 0) {
    const words = first.literal.trim().split(/\s+/);
    return words[words.length - 1];
  }
  return undefined;
}

/** Publication year from issued date-parts, if present. */
export function issuedYear(item: Record<string, unknown>): number | undefined {
  const issued = item.issued as Record<string, unknown> | undefined;
  const parts = issued?.["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const year = parts[0][0];
    return typeof year === "number" ? year : undefined;
  }
  return undefined;
}

/**
 * Citation label of a bare CSL-JSON item, with `fallbackLabel` standing in when
 * the item names neither an author nor a title. Split out of `formatCitation`
 * so an archived identity (`custom.previous_identities[].item` — a plain item
 * with no `custom` block, hence not a `Source`) formats through exactly this
 * code path: a second formatter would drift and the original identity would
 * stop reading like the current one.
 */
export function formatCitationItem(
  item: Record<string, unknown>,
  fallbackLabel: string,
): string {
  const family = firstAuthorFamily(item);
  const year = issuedYear(item);
  const container = item["container-title"];
  const title = item.title;

  const authors = item.author;
  const etAl = Array.isArray(authors) && authors.length > 1 ? " et al." : "";
  // TRIMMED non-empty, not merely "of type string": an empty or whitespace-only
  // title used to be preferred over `fallbackLabel` — the very parameter this
  // function was split out of `formatCitation` to introduce — so the citation
  // came out empty, or, with a container, as a string beginning in a comma. The
  // same guard `original-identity.ts` already applies to `item.id` one layer up;
  // both read the same schema-unvalidated record, so both must mean the same
  // thing by "usable string" (WR-02).
  //
  // The title is returned UNCHANGED when the guard passes. A guard decides
  // whether to show the source's own words; it never rewrites them — the
  // archived title is evidence, not UI copy.
  const head = family
    ? `${family}${etAl}${year ? ` (${year})` : ""}`
    : typeof title === "string" && title.trim().length > 0
      ? title
      : fallbackLabel;
  const tail =
    typeof container === "string" && container.length > 0
      ? `, ${container}`
      : "";
  return `${head}${tail}`;
}

/**
 * Human-readable citation label ("Meyer (2025), IEEE TSE") — used as
 * SourceContext.citation for extraction jobs and in the sources list.
 */
export function formatCitation(source: Source): string {
  return formatCitationItem(source as Record<string, unknown>, source.id);
}

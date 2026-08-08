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
  const first = authors[0] as Record<string, unknown>;
  if (typeof first.family === "string" && first.family.length > 0) {
    return first.family;
  }
  if (typeof first.literal === "string" && first.literal.length > 0) {
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
 * Human-readable citation label ("Meyer (2025), IEEE TSE") — used as
 * SourceContext.citation for extraction jobs and in the sources list.
 */
export function formatCitation(source: Source): string {
  const item = source as Record<string, unknown>;
  const family = firstAuthorFamily(item);
  const year = issuedYear(item);
  const container = item["container-title"];
  const title = item.title;

  const authors = item.author;
  const etAl = Array.isArray(authors) && authors.length > 1 ? " et al." : "";
  const head = family
    ? `${family}${etAl}${year ? ` (${year})` : ""}`
    : typeof title === "string"
      ? title
      : source.id;
  const tail =
    typeof container === "string" && container.length > 0
      ? `, ${container}`
      : "";
  return `${head}${tail}`;
}

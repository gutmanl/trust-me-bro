import type { Source } from "../../../register";
import { parseAuthors } from "../csl";
import type { SourceWorkItemOrigin } from "../work-items/types";
import type { DerivedCitationMeta } from "./derive-candidate";

/**
 * Which work-item origins an automatic repair may act on (automatic
 * repair): everything EXCEPT an automatic repair's own attempt — a failed
 * `auto_repair` item is the structural loop guard and is never re-evaluated.
 *
 * The rule lives here alone because three places read it and must never
 * disagree: the auto-chain's fan-out behind a failed capture, and both ends
 * of the evaluator's TOCTOU window. Nothing in this module reaches back to
 * the chain, which is why the chain may import it statically where every
 * other automatic-repair module has to be resolved lazily.
 */
export function repairableOrigin(origin: SourceWorkItemOrigin): boolean {
  return origin !== "auto_repair";
}

/** The manual citation fields the capture form and the durable failure
 * snapshot both carry — the subset a title rematch can use. */
export interface ManualCitationFields {
  title: string;
  authors?: string;
  year?: string;
}

/**
 * One CSL-JSON name rendered as the plain "Vorname Nachname" string the
 * Crossref query wants. The order matters beyond looks: the matcher scores
 * the FIRST author by taking the last word as the family name, so a
 * "Nachname, Vorname" string would score its given name against Crossref's
 * family name and silently never match.
 */
function nameOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const name = entry as {
    family?: unknown;
    given?: unknown;
    literal?: unknown;
  };
  if (typeof name.literal === "string" && name.literal.trim().length > 0) {
    return name.literal.trim();
  }
  if (typeof name.family === "string" && name.family.trim().length > 0) {
    const given = typeof name.given === "string" ? name.given.trim() : "";
    return given.length > 0
      ? `${given} ${name.family.trim()}`
      : name.family.trim();
  }
  return undefined;
}

function renderedNames(entries: readonly unknown[]): string[] {
  return entries.flatMap((entry) => {
    const name = nameOf(entry);
    return name !== undefined ? [name] : [];
  });
}

function parsedYear(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && /^\d{4}$/.test(trimmed)
    ? Number(trimmed)
    : undefined;
}

/**
 * Citation metadata from a human-entered capture form (automatic repair):
 * the fields are already structured, so the rematch skips the LLM parse a
 * raw citation line needs and queries Crossref directly. The author field
 * goes through the capture form's OWN parser, so the repair reads the
 * "Nachname, Vorname; …" convention exactly as the form wrote it.
 */
export function citationMetaFromManual(
  manual: ManualCitationFields,
): DerivedCitationMeta {
  const year = parsedYear(manual.year);
  return {
    title: manual.title,
    authors: renderedNames(parseAuthors(manual.authors ?? "")),
    ...(year !== undefined ? { year } : {}),
  };
}

/** The year out of a CSL `issued` block (`{"date-parts": [[2025]]}`). */
function issuedYear(issued: unknown): number | undefined {
  if (typeof issued !== "object" || issued === null) {
    return undefined;
  }
  const parts = (issued as { "date-parts"?: unknown })["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) {
    return undefined;
  }
  const year: unknown = parts[0][0];
  return typeof year === "number" ? year : undefined;
}

/**
 * Citation metadata from a source's own CSL core (automatic repair): the
 * provenance available for a MANUALLY captured source, which carries no raw
 * citation line to re-parse.
 *
 * Undefined without a usable title — the Crossref title match would have
 * nothing to score against, and an author-only query is noise that clears
 * the confidence bar for the wrong reasons.
 */
export function citationMetaFromSource(
  source: Source,
): DerivedCitationMeta | undefined {
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (title.length === 0) {
    return undefined;
  }
  const authors = Array.isArray(source.author)
    ? renderedNames(source.author)
    : [];
  const year = issuedYear(source.issued);
  return { title, authors, ...(year !== undefined ? { year } : {}) };
}

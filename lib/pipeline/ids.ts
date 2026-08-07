/**
 * Pure id helpers of the pipeline layer. The register validates id shape
 * (schema/primitives.ts) but never invents ids — minting is pipeline
 * responsibility. This module is free of Node APIs so client components may
 * import it directly for live id suggestions.
 */

const MAX_SLUG_LENGTH = 40;

const TRANSLITERATIONS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

/**
 * Reduces free text (typically the research question) to the id-safe ASCII
 * subset of the register's id patterns: lowercase, German transliterations,
 * hyphen-separated. Returns an empty string when nothing survives.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => TRANSLITERATIONS[char])
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}

/** Suggests a project id ("proj_<slug>") from the research question. */
export function mintProjectId(researchQuestion: string): string {
  const slug = slugify(researchQuestion);
  return `proj_${slug || "projekt"}`;
}

/** Next sequential claim id ("clm_0001", "clm_0002", …). */
export function nextClaimId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const match = /^clm_(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `clm_${String(max + 1).padStart(4, "0")}`;
}

/** Evidence id within one claim ("ev_0001", …) — evidence ids are only
 * required to be unique per claim (persistence integrity check). */
export function evidenceIdAt(index: number): string {
  return `ev_${String(index + 1).padStart(4, "0")}`;
}

/**
 * Mints a source id ("src_meyer2025") from author/year, falling back to the
 * title. Collisions get a numeric suffix — ids must be unique per register
 * (referential integrity check of the persistence layer).
 */
export function mintSourceId(
  hint: { family?: string; year?: number; title?: string },
  existing: ReadonlySet<string>,
): string {
  const base =
    hint.family && hint.family.trim().length > 0
      ? `${slugify(hint.family)}${hint.year ?? ""}`
      : slugify(hint.title ?? "") || "quelle";
  const candidate = `src_${base}`;
  if (!existing.has(candidate)) {
    return candidate;
  }
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!existing.has(next)) {
      return next;
    }
  }
}

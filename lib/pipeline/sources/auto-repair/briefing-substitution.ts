import type { Source } from "../../../register";
import { publishBriefingRevision } from "../../briefing-revision";
import { requireProjectStore } from "../../projects";
import { formatCitation } from "../csl";
import { sourceIdentifiers } from "../reference-scan/candidate";
import { parseFootnoteDefinitions } from "../reference-scan/footnotes";
import { AUTO_REPAIR_ACTOR } from "./evaluate-capture-failure";

/**
 * Mechanical briefing substitution after an identity correction (automatic
 * repair): the frozen briefing prose still carries the OLD — wrong —
 * identifier strings and footnote bibliography. This deterministically
 * replaces exactly those artifacts (inline DOI/arXiv/URL strings, the
 * footnote definition's bibliographic line) with the corrected ones and
 * publishes the result as an ordinary audited briefing revision. Never an
 * LLM, never any prose beyond the identifier/footnote strings.
 */
export function substituteIdentifierOccurrences(
  briefingText: string,
  previousItem: Record<string, unknown>,
  newItem: Record<string, unknown>,
): { text: string; changed: boolean } {
  const oldIds = sourceIdentifiers(previousItem as unknown as Source);
  const newIds = sourceIdentifiers(newItem as unknown as Source);

  const replacements: Array<[string, string]> = [];
  const oldDoi =
    typeof previousItem.DOI === "string" ? previousItem.DOI : undefined;
  // The verbatim CSL value, not sourceIdentifiers' lowercased comparison
  // form — the substituted text should read like a real citation.
  const newDoi = typeof newItem.DOI === "string" ? newItem.DOI : undefined;
  const newDoiUrl = newDoi ? `https://doi.org/${newDoi}` : undefined;
  if (oldDoi && (newDoi ?? newIds.url)) {
    replacements.push([oldDoi, newDoi ?? (newIds.url as string)]);
  }
  if (oldIds.url && (newIds.url ?? newDoiUrl)) {
    replacements.push([oldIds.url, newIds.url ?? (newDoiUrl as string)]);
  }
  if (oldIds.arxivId && newIds.arxivId && oldIds.arxivId !== newIds.arxivId) {
    replacements.push([oldIds.arxivId, newIds.arxivId]);
  }

  let text = briefingText;
  let changed = false;

  // Footnote definitions that cite the corrected work by its OLD strings
  // get a fresh bibliographic line built from the corrected core — BEFORE
  // the inline replacements, which would otherwise rewrite the identifier
  // inside the very line this pass is matching against.
  const identifiers = [oldDoi, oldIds.url, oldIds.arxivId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (identifiers.length > 0 && replacements.length > 0) {
    const newCitationTail = newDoi
      ? ` https://doi.org/${newDoi}`
      : newIds.url
        ? ` ${newIds.url}`
        : "";
    const newLine = `${formatCitation(newItem as unknown as Source)}${newCitationTail}`;
    for (const def of parseFootnoteDefinitions(briefingText)) {
      if (!identifiers.some((id) => def.rawText.includes(id))) {
        continue;
      }
      const oldLine = `[^${def.marker}]: ${def.rawText}`;
      const replacementLine = `[^${def.marker}]: ${newLine}`;
      if (text.includes(oldLine) && oldLine !== replacementLine) {
        text = text.split(oldLine).join(replacementLine);
        changed = true;
      }
    }
  }

  for (const [needle, replacement] of replacements) {
    if (needle.length > 0 && needle !== replacement && text.includes(needle)) {
      text = text.split(needle).join(replacement);
      changed = true;
    }
  }

  return { text, changed };
}

/**
 * Runs the substitution for one corrected source, off the auto-chain
 * (between runs — publishBriefingRevision refuses while a run is active):
 * reads the latest `source_identity_corrected` event's before/after core,
 * substitutes, and publishes under the auto-repair system actor. No
 * occurrence of the old identifier ⇒ no revision. An unpublished workbench
 * draft blocks publishing (it would be clobbered) ⇒ the substitution is
 * skipped — the identity correction itself already landed; the manual
 * passage repair remains available to catch the text up later.
 */
export async function runBriefingSubstitution(
  projectId: string,
  sourceId: string,
): Promise<{ published: boolean }> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const briefing = register.project.briefing_import;
  if (!briefing) {
    return { published: false };
  }
  const correction = register.project_events.findLast(
    (event) =>
      event.event === "source_identity_corrected" &&
      event.identity_change?.source_id === sourceId,
  );
  const change = correction?.identity_change;
  if (!change) {
    return { published: false };
  }
  const text = store.blobs().readText(briefing.blob_path);
  const substituted = substituteIdentifierOccurrences(
    text,
    change.previous_item,
    change.new_item,
  );
  if (!substituted.changed) {
    return { published: false };
  }
  if (store.readDraft() !== null) {
    // Publishing would clobber the reviewer's unsaved draft — a decision
    // only they can make. The correction stands; the inline text lags until
    // the draft resolves (manual passage repair covers the rest).
    console.warn(
      `auto-repair: briefing substitution for "${sourceId}" skipped — ` +
        "unpublished draft present",
    );
    return { published: false };
  }
  await publishBriefingRevision(projectId, {
    text: substituted.text,
    reason:
      `Mechanische Textanpassung nach Korrektur der Quellenkennung von ` +
      `${sourceId}: alte Kennung(en) und Fußnoten-Bibliografie durch die ` +
      `korrigierten ersetzt.`,
    actor: AUTO_REPAIR_ACTOR,
  });
  return { published: true };
}

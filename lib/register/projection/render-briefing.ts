import type { Claim } from "../schema/claim";
import type { ClaimsRegister } from "../schema/register";
import type { ClaimMarkerVM } from "./briefing-view";
import { buildBriefingViewModel, CONFIRMED_STATUSES } from "./briefing-view";
import { countRepairCycles } from "./counts";
import { RELATION_LABEL_DE, STATUS_LABEL_DE } from "./status-display";

/**
 * Renders briefing.md from the frozen briefing original and the register.
 *
 * The output is a pure, deterministic function of its inputs: no clock, no
 * locale, LF-only line endings. Anchor resolution, claim ordering and the
 * global evidence numbering come from the shared briefing view model
 * (briefing-view.ts) — the interactive review UI consumes the same
 * projection, so the two can never drift. Same blob + same register yields a
 * byte-identical file. The file carries no truth of its own — it is
 * regenerated at any time from blob and claims.json.
 *
 * The status/relation enum values are internal English identifiers; this
 * German output document must never show one directly, so every place they
 * would otherwise surface goes through the German display maps in
 * status-display.ts instead.
 */

function statusLabel(claim: Claim): string {
  switch (claim.status) {
    case "confirmed":
      return "bestätigt (manuell überprüft)";
    case "auto_confirmed":
      return "automatisch bestätigt (stichprobenweise nachprüfbar)";
    default:
      return `NICHT BESTÄTIGT – Status: ${STATUS_LABEL_DE[claim.status]}`;
  }
}

/**
 * The marker block under a paragraph.
 *
 * S-02: a repair writes a new `claim.text`, but the paragraphs above are
 * the frozen original and are never rewritten — so a repaired claim used to
 * show the original, already-rejected wording next to a confirmation marker
 * while the accepted correction appeared nowhere at all. That is a
 * correctness defect in the primary deliverable, not a presentation
 * question.
 *
 * The paragraphs stay untouched: they are frozen source material, and
 * rewriting them would break the relationship between briefing blob and
 * projection, undermining the very check that compares quoted wording
 * against the frozen document. Instead the verified wording is stated
 * explicitly beneath the marker — and only for claims that were actually
 * repaired, so the ordinary case, where paragraph and claim agree, gains no
 * noise.
 */
function claimLines(
  claim: Claim,
  evidenceNumbers: number[],
  suffix = "",
): string[] {
  const marker = CONFIRMED_STATUSES.has(claim.status) ? "✓" : "⚠";
  const refs =
    evidenceNumbers.length > 0
      ? ` · Belege ${evidenceNumbers.map((n) => `[${n}]`).join(" ")}`
      : " · ohne Beleg";
  const lines = [
    `> ${marker} **${claim.id}** · ${statusLabel(claim)}${refs}${suffix}`,
  ];
  if (countRepairCycles(claim) > 0) {
    lines.push(`> · Geprüfte Fassung: „${claim.text}"`);
  }
  return lines;
}

/**
 * Renders a locator (page/section plus pass-through keys) as compact German
 * text — the one locator display rule, shared with the evidence detail
 * panel of the review UI.
 */
export function formatLocator(locator: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof locator.page === "number") {
    parts.push(`S. ${locator.page}`);
  }
  if (typeof locator.section === "string") {
    parts.push(`Abschn. ${locator.section}`);
  }
  for (const [key, value] of Object.entries(locator).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (key !== "page" && key !== "section") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join(", ");
}

/**
 * Optional findings the projection cannot compute itself without inverting
 * the layering. `sharedModelFamily` says that the briefing was researched
 * by this application with a backend of the same model family as the
 * primary verification backend — determined in lib/pipeline, where
 * modelFamilyOf lives, and passed down. Absent means "no such finding",
 * which is also what every existing caller passing nothing gets.
 */
export interface BriefingRenderContext {
  sharedModelFamily?: boolean;
}

export function renderBriefing(
  briefingOriginal: string,
  register: ClaimsRegister,
  context: BriefingRenderContext = {},
): string {
  const view = buildBriefingViewModel(briefingOriginal, register);

  const lines: string[] = [];
  lines.push(
    "<!-- Generierte Projektion aus claims.json – trägt keine eigene Wahrheit." +
      " Regenerierbar; Änderungen hier gehen verloren. -->",
    "",
    `# ${register.project.research_question}`,
    "",
    `**Projekt:** ${register.project.id}`,
    "",
    // Three states, not two: a briefing whose claims have not been extracted
    // yet has nothing open AND nothing checked, and calling that "IN PRÜFUNG
    // – 0 Aussage(n) offen" would be as misleading here as "GEPRÜFT" was
    // before. This is the state every freshly imported briefing renders in,
    // since freezeBriefing writes this file before any claim exists.
    register.claims.length === 0
      ? `**Prüfstand:** NICHT BEGONNEN – noch keine Aussagen aus dem Briefing erfasst`
      : view.isFullyAdjudicated
        ? `**Prüfstand:** GEPRÜFT – keine Aussage zur manuellen Überprüfung offen` +
          (view.unconfirmedCount > 0
            ? ` (${view.unconfirmedCount} Aussage(n) nicht bestätigt)`
            : "")
        : `**Prüfstand:** IN PRÜFUNG – ${view.openCount} Aussage(n) zur manuellen Überprüfung offen`,
    "",
    ...(context.sharedModelFamily
      ? [
          // Travels with the artifact rather than living only on screen:
          // whoever reads the bundle later sees the limitation without the
          // application.
          "**Hinweis zur Unabhängigkeit:** Briefing und Prüfung stammen aus" +
            " derselben Modellfamilie. Die Urteile der Stufen 2 und 3" +
            " (Belegprüfung, Bewertung gegen das Bewertungsschema) sind" +
            " dadurch nicht unabhängig. Stufe 1 – die Zitatprüfung des" +
            " Wortlauts gegen das eingefrorene Dokument – ist" +
            " davon nicht betroffen.",
          "",
        ]
      : []),
    // Without this the two tiers of the document are easy to confuse: the
    // paragraphs are frozen input, the markers are the current verified
    // state, and after a repair the two deliberately differ.
    "Die Absätze geben den eingefrorenen Originalwortlaut des Briefings" +
      " wieder und bleiben unverändert. Die Markierungen darunter geben den" +
      " geprüften Stand wieder; wurde eine Aussage repariert, steht ihre" +
      " geprüfte Fassung dort ausdrücklich.",
    "",
    "---",
  );

  for (const paragraph of view.paragraphs) {
    lines.push("", paragraph.text);
    for (const marker of paragraph.claims) {
      lines.push("", ...claimLines(marker.claim, marker.evidenceNumbers));
    }
  }

  if (view.unanchored.length > 0) {
    lines.push("", "---", "", "## Nicht zuordenbare Aussagen");
    for (const marker of view.unanchored) {
      lines.push(
        "",
        ...claimLines(
          marker.claim,
          marker.evidenceNumbers,
          ` · Anker: ${marker.claim.briefing_anchor}`,
        ),
      );
    }
  }

  const totalEvidence = Object.keys(view.evidenceNumbers).length;
  if (totalEvidence > 0) {
    lines.push("", "---", "", "## Belege");
    for (const marker of view.orderedClaims) {
      appendEvidenceLines(lines, marker);
    }
  }

  return `${lines.join("\n")}\n`;
}

function appendEvidenceLines(lines: string[], marker: ClaimMarkerVM): void {
  for (const [index, evidence] of marker.claim.evidence.entries()) {
    const number = marker.evidenceNumbers[index];
    const locator = formatLocator(evidence.locator as Record<string, unknown>);
    const relation = evidence.relation_type
      ? RELATION_LABEL_DE[evidence.relation_type]
      : "unbewertet";
    lines.push(
      "",
      `${number}. ${evidence.source_id}${locator ? `, ${locator}` : ""} · ${relation} · ` +
        `„${evidence.verbatim_excerpt}"`,
    );
  }
}

import type { Claim } from "../schema/claim";
import type { ClaimsRegister } from "../schema/register";
import type { ClaimMarkerVM } from "./briefing-view";
import { buildBriefingViewModel, CONFIRMED_STATUSES } from "./briefing-view";

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
 */

function statusLabel(claim: Claim): string {
  switch (claim.status) {
    case "bestaetigt":
      return "bestätigt (adjudiziert)";
    case "automatisch_bestaetigt":
      return "automatisch bestätigt (stichprobenweise nachprüfbar)";
    default:
      return `NICHT BESTÄTIGT – Status: ${claim.status}`;
  }
}

function claimLine(claim: Claim, evidenceNumbers: number[]): string {
  const marker = CONFIRMED_STATUSES.has(claim.status) ? "✓" : "⚠";
  const refs =
    evidenceNumbers.length > 0
      ? ` · Belege ${evidenceNumbers.map((n) => `[${n}]`).join(" ")}`
      : " · ohne Beleg";
  return `> ${marker} **${claim.id}** · ${statusLabel(claim)}${refs}`;
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

export function renderBriefing(
  briefingOriginal: string,
  register: ClaimsRegister,
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
    view.isGeprueft
      ? `**Prüfstand:** GEPRÜFT – kein Claim zur Adjudikation offen` +
          (view.unconfirmedCount > 0
            ? ` (${view.unconfirmedCount} Claim(s) nicht bestätigt)`
            : "")
      : `**Prüfstand:** IN PRÜFUNG – ${view.openCount} Claim(s) zur Adjudikation offen`,
    "",
    "---",
  );

  for (const paragraph of view.paragraphs) {
    lines.push("", paragraph.text);
    for (const marker of paragraph.claims) {
      lines.push("", claimLine(marker.claim, marker.evidenceNumbers));
    }
  }

  if (view.unanchored.length > 0) {
    lines.push("", "---", "", "## Nicht zuordenbare Claims");
    for (const marker of view.unanchored) {
      lines.push(
        "",
        `${claimLine(marker.claim, marker.evidenceNumbers)} · Anker: ${marker.claim.briefing_anchor}`,
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
    const relation = evidence.relation_type ?? "unbewertet";
    lines.push(
      "",
      `${number}. ${evidence.source_id}${locator ? `, ${locator}` : ""} · ${relation} · ` +
        `„${evidence.verbatim_excerpt}"`,
    );
  }
}

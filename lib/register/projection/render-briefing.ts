import type { Claim } from "../schema/claim";
import type { ClaimsRegister } from "../schema/register";

/**
 * Renders briefing.md from the frozen briefing original and the register.
 *
 * The output is a pure, deterministic function of its inputs: no clock, no
 * locale, LF-only line endings, and all orderings derived from stable keys
 * (anchor position, then claim id) rather than array order. Same blob + same
 * register therefore yields a byte-identical file. The file carries no truth
 * of its own — it is regenerated at any time from blob and claims.json.
 *
 * Anchor convention: `briefing_anchor` values of the form p<N> refer to the
 * N-th paragraph (1-based) of the briefing original, where paragraphs are
 * separated by blank lines. Claims with anchors that do not resolve are
 * listed in a dedicated section instead of being dropped.
 */

const CONFIRMED_STATUSES = new Set(["bestaetigt", "automatisch_bestaetigt"]);

interface AnchoredClaim {
  claim: Claim;
  paragraphIndex: number | null;
}

function anchorParagraphIndex(
  claim: Claim,
  paragraphCount: number,
): number | null {
  const match = /^p([1-9][0-9]*)$/.exec(claim.briefing_anchor);
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return index < paragraphCount ? index : null;
}

function compareClaims(a: AnchoredClaim, b: AnchoredClaim): number {
  const pa = a.paragraphIndex ?? Number.MAX_SAFE_INTEGER;
  const pb = b.paragraphIndex ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) {
    return pa - pb;
  }
  return a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0;
}

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

function formatLocator(locator: Record<string, unknown>): string {
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
  const normalized = briefingOriginal.replace(/\r\n?/g, "\n").trim();
  const paragraphs = normalized.length > 0 ? normalized.split(/\n{2,}/) : [];

  const anchored: AnchoredClaim[] = register.claims
    .map((claim) => ({
      claim,
      paragraphIndex: anchorParagraphIndex(claim, paragraphs.length),
    }))
    .sort(compareClaims);

  // Global inline evidence numbering in deterministic claim order.
  const evidenceNumber = new Map<string, number>();
  for (const { claim } of anchored) {
    for (const evidence of claim.evidence) {
      evidenceNumber.set(`${claim.id}/${evidence.id}`, evidenceNumber.size + 1);
    }
  }

  const openCount = register.claims.filter(
    (claim) => claim.status === "zur_adjudikation",
  ).length;
  const unconfirmedCount = register.claims.filter(
    (claim) => !CONFIRMED_STATUSES.has(claim.status),
  ).length;

  const lines: string[] = [];
  lines.push(
    "<!-- Generierte Projektion aus claims.json – trägt keine eigene Wahrheit." +
      " Regenerierbar; Änderungen hier gehen verloren. -->",
    "",
    `# ${register.project.research_question}`,
    "",
    `**Projekt:** ${register.project.id}`,
    "",
    openCount === 0
      ? `**Prüfstand:** GEPRÜFT – kein Claim zur Adjudikation offen` +
          (unconfirmedCount > 0
            ? ` (${unconfirmedCount} Claim(s) nicht bestätigt)`
            : "")
      : `**Prüfstand:** IN PRÜFUNG – ${openCount} Claim(s) zur Adjudikation offen`,
    "",
    "---",
  );

  for (const [index, paragraph] of paragraphs.entries()) {
    lines.push("", paragraph);
    const claimsHere = anchored.filter(
      (entry) => entry.paragraphIndex === index,
    );
    for (const { claim } of claimsHere) {
      lines.push(
        "",
        claimLine(
          claim,
          claim.evidence.map(
            (evidence) =>
              evidenceNumber.get(`${claim.id}/${evidence.id}`) as number,
          ),
        ),
      );
    }
  }

  const unanchored = anchored.filter((entry) => entry.paragraphIndex === null);
  if (unanchored.length > 0) {
    lines.push("", "---", "", "## Nicht zuordenbare Claims");
    for (const { claim } of unanchored) {
      lines.push(
        "",
        `${claimLine(
          claim,
          claim.evidence.map(
            (evidence) =>
              evidenceNumber.get(`${claim.id}/${evidence.id}`) as number,
          ),
        )} · Anker: ${claim.briefing_anchor}`,
      );
    }
  }

  if (evidenceNumber.size > 0) {
    lines.push("", "---", "", "## Belege");
    for (const { claim } of anchored) {
      for (const evidence of claim.evidence) {
        const number = evidenceNumber.get(
          `${claim.id}/${evidence.id}`,
        ) as number;
        const locator = formatLocator(
          evidence.locator as Record<string, unknown>,
        );
        const relation = evidence.relation_type ?? "unbewertet";
        lines.push(
          "",
          `${number}. ${evidence.source_id}${locator ? `, ${locator}` : ""} · ${relation} · ` +
            `„${evidence.verbatim_excerpt}"`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

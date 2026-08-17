import type { ClaimStatus, RelationType } from "../schema/enums";

/**
 * German display labels for the (now English) status/relation enum values,
 * used ONLY by the German briefing.md projection (render-briefing.ts) so its
 * output never leaks an English enum identifier into German prose. Not
 * exported via lib/register/index.ts: this module is render-briefing's
 * internal concern, not part of the register's public surface.
 *
 * Duplicated with app/projects/status-labels.ts (the review UI's own German
 * display labels) intentionally: the architecture test forbids app → register
 * runtime imports, so the two label maps are independent by construction.
 */

export const STATUS_LABEL_DE: Record<ClaimStatus, string> = {
  captured: "erfasst",
  existence_checked: "Zitate geprüft",
  prechecked: "vorgeprüft",
  auto_confirmed: "automatisch bestätigt",
  pending_adjudication: "zur manuellen Überprüfung",
  confirmed: "bestätigt",
  contested: "beanstandet",
  revised: "überarbeitet",
  discarded: "verworfen",
  recheck_required: "Nachprüfung erforderlich",
};

export const RELATION_LABEL_DE: Record<RelationType, string> = {
  supports: "stützt",
  partially_supports: "stützt teilweise",
  contradicts: "widerspricht",
  not_relevant: "nicht relevant",
};

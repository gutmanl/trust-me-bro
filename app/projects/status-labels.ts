import type {
  CalibrationResult,
  ClaimStatus,
  RelationType,
  SourceType,
  SupportDegree,
} from "@/lib/register";

/** German display labels of the ASCII-transliterated status enum. */
export const STATUS_LABELS: Record<ClaimStatus, string> = {
  captured: "erfasst",
  existence_checked: "existenzgeprüft",
  prechecked: "vorgeprüft",
  auto_confirmed: "automatisch bestätigt",
  pending_adjudication: "zur Adjudikation",
  confirmed: "bestätigt",
  contested: "beanstandet",
  revised: "überarbeitet",
  discarded: "verworfen",
  recheck_required: "Nachprüfung erforderlich",
};

/** Order in which status counts are displayed (workflow order). */
export const STATUS_ORDER: ClaimStatus[] = [
  "captured",
  "existence_checked",
  "prechecked",
  "auto_confirmed",
  "pending_adjudication",
  "confirmed",
  "contested",
  "revised",
  "discarded",
  "recheck_required",
];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  peer_reviewed_publication: "begutachtete Publikation",
  preprint: "Preprint",
  grey_literature: "Grauliteratur",
  vendor_documentation: "Herstellerdokumentation",
};

export const RELATION_LABELS: Record<RelationType, string> = {
  supports: "stützt",
  partially_supports: "stützt teilweise",
  contradicts: "widerspricht",
  not_relevant: "nicht einschlägig",
};

export const SUPPORT_LABELS: Record<SupportDegree, string> = {
  supported: "Supported",
  partially_supported: "Partially Supported",
  unsupported: "Unsupported",
  uncertain: "Uncertain",
};

export const CALIBRATION_LABELS: Record<CalibrationResult, string> = {
  licensed: "lizenziert",
  weakened: "abschwächen",
  pending_adjudication: "zur Adjudikation",
};

/** Status pill styling (amber = awaiting adjudication, green = confirmed,
 * red = complained/discarded, slate = in-pipeline) shared by the claim
 * lists, the briefing markers and the adjudication queue. */
export function statusBadgeClassName(status: ClaimStatus): string {
  switch (status) {
    case "pending_adjudication":
      return "bg-amber-100 text-amber-800";
    case "recheck_required":
      return "bg-orange-100 text-orange-800";
    case "auto_confirmed":
    case "confirmed":
      return "bg-green-100 text-green-800";
    case "contested":
    case "discarded":
      return "bg-red-100 text-red-800";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  });
}

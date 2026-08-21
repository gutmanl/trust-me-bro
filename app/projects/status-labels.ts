import type {
  CalibrationResult,
  ClaimStatus,
  ClaimType,
  RelationType,
  SourceType,
  SupportDegree,
} from "@/lib/register";

/** German display labels of the ASCII-transliterated status enum. */
export const STATUS_LABELS: Record<ClaimStatus, string> = {
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

/**
 * German display labels of the claim classification that steers the SE
 * evidence rubric. Displayed in the pre-check disclosure: the rubric rule
 * that decided the verdict is keyed on exactly this value
 * (`se-evidence-rubric-v1.json` `claim_types`), so naming the type is what
 * makes the two rows below it read as consequences rather than as unrelated
 * verdicts.
 *
 * Deliberately separate from `VERDICT_PROSE` in `verdict-glossary.ts`, which
 * carries the same four German strings today: this map labels a `dd`
 * element, that one supplies sentence-insertable prose. They are two maps
 * for the same reason `CALIBRATION_LABELS.weakened` („abschwächen",
 * infinitive) and the glossary's `weakened` („abgeschwächt", participle)
 * must be two — the claim-type values merely happen to coincide because a
 * noun phrase works in both positions. Do not spread one into the other.
 */
export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  quantitative_finding: "quantitativer Befund",
  comparative_statement: "Vergleichsaussage",
  effectiveness_statement: "Wirksamkeitsaussage",
  recommendation: "Empfehlung",
};

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
  not_relevant: "nicht relevant",
};

export const SUPPORT_LABELS: Record<SupportDegree, string> = {
  supported: "gestützt",
  partially_supported: "teilweise gestützt",
  unsupported: "nicht gestützt",
  uncertain: "unklar",
};

export const CALIBRATION_LABELS: Record<CalibrationResult, string> = {
  licensed: "freigegeben",
  weakened: "abschwächen",
  pending_adjudication: "zur manuellen Überprüfung",
};

/** Status pill styling (amber = awaiting adjudication, green = confirmed,
 * red = complained/discarded, slate = in-pipeline) shared by the claim
 * lists, the briefing markers and the adjudication queue. */
/**
 * Display form of a recorded model name (S-11). The adapter layer stores the
 * English sentinel "unknown" when a backend could not determine which model
 * served a request; the display tier names that gap in German instead of
 * showing the raw token. Any real model name passes through verbatim — it is
 * provenance, not copy.
 *
 * The sentinel is restated here rather than imported, exactly like the enum
 * values keying the label maps above: app/ reads the pipeline barrel only.
 */
export function formatModel(model: string): string {
  return model === "unknown" ? "Modell nicht ermittelt" : model;
}

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

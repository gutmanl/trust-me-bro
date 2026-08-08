import type { ClaimStatus } from "@/lib/register";

/** German display labels of the ASCII-transliterated status enum. */
export const STATUS_LABELS: Record<ClaimStatus, string> = {
  erfasst: "erfasst",
  existenzgeprueft: "existenzgeprüft",
  vorgeprueft: "vorgeprüft",
  automatisch_bestaetigt: "automatisch bestätigt",
  zur_adjudikation: "zur Adjudikation",
  bestaetigt: "bestätigt",
  beanstandet: "beanstandet",
  ueberarbeitet: "überarbeitet",
  verworfen: "verworfen",
};

/** Order in which status counts are displayed (workflow order). */
export const STATUS_ORDER: ClaimStatus[] = [
  "erfasst",
  "existenzgeprueft",
  "vorgeprueft",
  "automatisch_bestaetigt",
  "zur_adjudikation",
  "bestaetigt",
  "beanstandet",
  "ueberarbeitet",
  "verworfen",
];

/** Status pill styling (amber = awaiting adjudication, green = confirmed,
 * red = complained/discarded, slate = in-pipeline) shared by the claim
 * lists, the briefing markers and the adjudication queue. */
export function statusBadgeClassName(status: ClaimStatus): string {
  switch (status) {
    case "zur_adjudikation":
      return "bg-amber-100 text-amber-800";
    case "automatisch_bestaetigt":
    case "bestaetigt":
      return "bg-green-100 text-green-800";
    case "beanstandet":
    case "verworfen":
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

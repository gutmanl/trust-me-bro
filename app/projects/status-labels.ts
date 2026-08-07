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

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  });
}

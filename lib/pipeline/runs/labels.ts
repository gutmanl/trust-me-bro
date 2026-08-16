/**
 * The one German label vocabulary for everything that can occupy a
 * project's single-writer seat (run visibility): runner runs and the
 * auto-chain's off-runner triggers alike.
 *
 * A leaf on purpose — the runner, the chain, the status layer and the
 * error messages all need these, and a second copy (the client used to
 * keep its own map) is exactly the two-sources-of-truth failure this
 * subsystem is being cured of. The client re-exports from here via the
 * barrel.
 */
const RUN_KIND_LABELS: Record<string, string> = {
  extraction: "Aussagen-Erfassung",
  verification: "KI-Prüfung",
  reference_scan: "Referenz-Scan",
  source_capture: "Quellenerfassung",
  research: "Recherche",
  relevance: "Relevanzprüfung",
  existence_check: "Zitatprüfung",
  // The off-runner chain triggers (run visibility): invisible before, now
  // named wherever an activity is shown or blamed.
  capture_failure_repair: "Automatische Reparatur (Erfassung)",
  source_repair_evaluation: "Automatische Reparatur (Quellenprüfung)",
  anchor_repair: "Anker-Reparatur",
  briefing_substitution: "Briefing-Angleichung",
};

export function runKindLabel(kind: string | null): string {
  return (kind && RUN_KIND_LABELS[kind]) || "Lauf";
}

/** "17:04" for today's activity, "16.08., 17:04" otherwise — the display
 * tier's de-DE/Europe/Berlin convention, for "läuft seit …" prose. */
export function formatActivitySince(iso: string): string {
  const at = new Date(iso);
  const timeZone = "Europe/Berlin";
  const time = at.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
  const sameDay =
    at.toLocaleDateString("de-DE", { timeZone }) ===
    new Date().toLocaleDateString("de-DE", { timeZone });
  if (sameDay) {
    return `${time} Uhr`;
  }
  const day = at.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
  });
  return `${day}, ${time} Uhr`;
}

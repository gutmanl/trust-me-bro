import type { RoutingReason } from "@/lib/register";

/** German labels of the structured routing reasons (TMB-36 queue). */
export const ROUTING_LABELS: Record<RoutingReason, string> = {
  no_evidence: "ohne Beleg erfasst",
  existence_check_failed: "Zitatprüfung nicht bestanden",
  divergence: "Backend-Urteile widersprüchlich",
  negative_precheck: "negative Vorprüfung",
  spot_check: "Stichprobe",
  escalated: "eskaliert",
  negative_relevance: "Relevanz (Folgeprojekt) negativ/unsicher",
};

import type { RoutingReason } from "@/lib/register";

/** German labels of the structured routing reasons (TMB-36 queue). */
export const ROUTING_LABELS: Record<RoutingReason, string> = {
  no_evidence: "ohne Beleg extrahiert",
  existence_check_failed: "Existenzprüfung nicht bestanden",
  divergence: "Divergenz der Backend-Urteile",
  negative_precheck: "negative Vorprüfung",
  spot_check: "Stichprobe",
  escalated: "eskaliert",
  negative_relevance: "Einschlägigkeit (warmer Lauf) negativ/unsicher",
};

export const ROUTING_ORDER: RoutingReason[] = [
  "existence_check_failed",
  "negative_precheck",
  "divergence",
  "no_evidence",
  "negative_relevance",
  "spot_check",
  "escalated",
];

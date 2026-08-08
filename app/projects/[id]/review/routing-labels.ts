import type { RoutingReason } from "@/lib/register";

/** German labels of the structured routing reasons (TMB-36 queue). */
export const ROUTING_LABELS: Record<RoutingReason, string> = {
  ohne_beleg: "ohne Beleg extrahiert",
  existenz_nicht_bestanden: "Existenzprüfung nicht bestanden",
  divergenz: "Divergenz der Backend-Urteile",
  negative_vorpruefung: "negative Vorprüfung",
  stichprobe: "Stichprobe",
  eskaliert: "eskaliert",
};

export const ROUTING_ORDER: RoutingReason[] = [
  "existenz_nicht_bestanden",
  "negative_vorpruefung",
  "divergenz",
  "ohne_beleg",
  "stichprobe",
  "eskaliert",
];

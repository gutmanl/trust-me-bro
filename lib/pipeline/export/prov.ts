import type { TraceEnvelope } from "../../adapters";
import type {
  Claim,
  ClaimsRegister,
  Evidence,
  HistoryEntry,
} from "../../register";
import { requireProjectStore } from "../projects";
import { readTraceEnvelopes } from "./traces";

/**
 * derived/prov.jsonld (TMB-41): the register as a W3C-PROV graph per the
 * ratified mapping table of the file format appendix — sources and claims as
 * prov:Entity, verification steps and adapter calls as prov:Activity,
 * backends/stages/reviewers as prov:Agent, evidence assignments as typed
 * claim–source edges, history entries as wasGeneratedBy/wasAttributedTo.
 * Pure derivation from claims.json plus the trace log; the documented
 * simplifications (notably: no separate reasoning nodes) are stated in the
 * document itself (tmb:documentedSimplifications), as the epic requires.
 */

const CONTEXT = {
  prov: "http://www.w3.org/ns/prov#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  tmb: "urn:trustmebro:",
  id: "@id",
  type: "@type",
  startedAtTime: { "@id": "prov:startedAtTime", "@type": "xsd:dateTime" },
  endedAtTime: { "@id": "prov:endedAtTime", "@type": "xsd:dateTime" },
  wasGeneratedBy: { "@id": "prov:wasGeneratedBy", "@type": "@id" },
  wasAttributedTo: { "@id": "prov:wasAttributedTo", "@type": "@id" },
  wasAssociatedWith: { "@id": "prov:wasAssociatedWith", "@type": "@id" },
  wasDerivedFrom: { "@id": "prov:wasDerivedFrom", "@type": "@id" },
  used: { "@id": "prov:used", "@type": "@id" },
} as const;

const SIMPLIFICATIONS = [
  "Keine separaten Reasoning-Knoten: Schlussfolgerung und Kantenaussage " +
    "fallen in einem judgments[]-Eintrag zusammen, die Begruendung ist ein " +
    "Literalattribut (tmb:reasoning) der urteilenden Aktivitaet.",
  "Statusuebergaenge sind punktuelle Aktivitaeten (startedAtTime = " +
    "endedAtTime); die Bearbeitungsdauer menschlicher Entscheidungen steht " +
    "als tmb:duration_s an der Aktivitaet.",
  "Die typisierte Claim-Quelle-Kante verlaeuft ueber den Evidenz-Knoten " +
    "(wasDerivedFrom zur Quelle, tmb:evidenceOf zum Claim, tmb:relationType " +
    "als Kantenaussage).",
] as const;

type Node = Record<string, unknown>;

const sourceIri = (sourceId: string): string => `tmb:source/${sourceId}`;
const claimIri = (claimId: string): string => `tmb:claim/${claimId}`;
const evidenceIri = (claimId: string, evidenceId: string): string =>
  `tmb:evidence/${claimId}/${evidenceId}`;
const transitionIri = (claimId: string, seq: number): string =>
  `tmb:activity/transition/${claimId}/${seq}`;
/** `human:lg` → `tmb:agent/human/lg`, `system:x` → `tmb:agent/system/x`. */
const actorIri = (actor: string): string =>
  `tmb:agent/${actor.replace(":", "/")}`;
const backendIri = (backend: string): string => `tmb:agent/backend/${backend}`;

export function buildProvDocument(
  register: ClaimsRegister,
  envelopes: readonly TraceEnvelope[],
): Record<string, unknown> {
  const graph: Node[] = [];
  const agents = new Map<string, Node>();

  const actorAgent = (actor: string): string => {
    const iri = actorIri(actor);
    agents.set(iri, {
      id: iri,
      type: actor.startsWith("human:") ? "prov:Person" : "prov:SoftwareAgent",
      "tmb:actor": actor,
    });
    return iri;
  };
  const backendAgent = (backend: string): string => {
    const iri = backendIri(backend);
    agents.set(iri, {
      id: iri,
      type: "prov:SoftwareAgent",
      "tmb:cli": backend,
    });
    return iri;
  };

  for (const source of register.sources) {
    graph.push({
      id: sourceIri(source.id),
      type: "prov:Entity",
      "tmb:role": "source",
      "tmb:sourceType": source.custom.source_type,
      ...(typeof source.title === "string"
        ? { "tmb:title": source.title }
        : {}),
    });
  }

  for (const claim of register.claims) {
    graph.push(claimNode(claim));
    for (const evidence of claim.evidence) {
      graph.push(...evidenceNodes(claim, evidence, envelopes, backendAgent));
    }
    for (const entry of claim.history) {
      graph.push(transitionNode(claim, entry, actorAgent));
    }
  }

  for (const event of register.project_events) {
    graph.push({
      id: `tmb:activity/project-event/${event.seq}`,
      type: "prov:Activity",
      startedAtTime: event.at,
      endedAtTime: event.at,
      wasAssociatedWith: actorAgent(event.actor),
      "tmb:event": event.event,
      "tmb:seq": event.seq,
      "tmb:reason": event.reason,
    });
  }

  const sortedAgents = [...agents.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );

  return {
    "@context": CONTEXT,
    id: `tmb:project/${register.project.id}`,
    type: "prov:Bundle",
    "tmb:researchQuestion": register.project.research_question,
    "tmb:documentedSimplifications": [...SIMPLIFICATIONS],
    "@graph": [...graph, ...sortedAgents],
  };
}

function claimNode(claim: Claim): Node {
  const creating = claim.history.find((entry) => entry.from_status === null);
  return {
    id: claimIri(claim.id),
    type: "prov:Entity",
    "tmb:role": "claim",
    "tmb:text": claim.text,
    "tmb:claimType": claim.claim_type,
    "tmb:status": claim.status,
    ...(claim.support_degree
      ? { "tmb:supportDegree": claim.support_degree }
      : {}),
    ...(creating
      ? {
          wasGeneratedBy: transitionIri(claim.id, creating.seq),
          wasAttributedTo: actorIri(creating.actor),
        }
      : {}),
  };
}

function evidenceNodes(
  claim: Claim,
  evidence: Evidence,
  envelopes: readonly TraceEnvelope[],
  backendAgent: (backend: string) => string,
): Node[] {
  const iri = evidenceIri(claim.id, evidence.id);
  const nodes: Node[] = [
    {
      id: iri,
      type: "prov:Entity",
      "tmb:role": "evidence",
      wasDerivedFrom: sourceIri(evidence.source_id),
      "tmb:evidenceOf": claimIri(claim.id),
      "tmb:excerpt": evidence.verbatim_excerpt,
      "tmb:locator": evidence.locator,
      ...(evidence.relation_type
        ? { "tmb:relationType": evidence.relation_type }
        : {}),
    },
  ];
  if (evidence.existence_check) {
    nodes.push({
      id: `tmb:activity/existence-check/${claim.id}/${evidence.id}`,
      type: "prov:Activity",
      startedAtTime: evidence.existence_check.at,
      endedAtTime: evidence.existence_check.at,
      used: iri,
      "tmb:result": evidence.existence_check.status,
    });
  }
  evidence.judgments.forEach((judgment, index) => {
    // Structural correlation to the trace log: the judgment's `at` is
    // written from the same clock read as the successful envelope's
    // finished_at (TMB-20) — when the trace is present, the activity gets
    // the real call duration; without it (lean export), it is instantaneous.
    const trace = envelopes.find(
      (envelope) =>
        envelope.finished_at === judgment.at &&
        envelope.backend === judgment.backend &&
        envelope.model === judgment.model &&
        envelope.error === undefined,
    );
    nodes.push({
      id: `tmb:activity/judgment/${claim.id}/${evidence.id}/${index + 1}`,
      type: "prov:Activity",
      startedAtTime: trace?.started_at ?? judgment.at,
      endedAtTime: judgment.at,
      used: iri,
      wasAssociatedWith: backendAgent(judgment.backend),
      "tmb:model": judgment.model,
      "tmb:relationType": judgment.relation_type,
      "tmb:confidence": judgment.confidence,
      "tmb:reasoning": judgment.reasoning,
      ...(trace ? { "tmb:traceId": trace.trace_id } : {}),
    });
  });
  return nodes;
}

function transitionNode(
  claim: Claim,
  entry: HistoryEntry,
  actorAgent: (actor: string) => string,
): Node {
  return {
    id: transitionIri(claim.id, entry.seq),
    type: "prov:Activity",
    startedAtTime: entry.at,
    endedAtTime: entry.at,
    used: claimIri(claim.id),
    wasAssociatedWith: actorAgent(entry.actor),
    "tmb:seq": entry.seq,
    "tmb:fromStatus": entry.from_status,
    "tmb:toStatus": entry.to_status,
    "tmb:reason": entry.reason,
    ...(entry.routing ? { "tmb:routing": entry.routing } : {}),
    ...(entry.decision
      ? {
          "tmb:decisionCategories": entry.decision.categories,
          "tmb:duration_s": entry.decision.duration_s,
        }
      : {}),
    ...(entry.revision
      ? {
          "tmb:revision": {
            "tmb:previousText": entry.revision.previous_text,
            "tmb:newText": entry.revision.new_text,
          },
        }
      : {}),
  };
}

/** Standalone download of the PROV projection (also part of the bundle). */
export async function getProvDocument(
  projectId: string,
): Promise<Record<string, unknown>> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  return buildProvDocument(register, readTraceEnvelopes(store.projectDir));
}

import type { ClaimsRegister } from "../../register";

/**
 * Per-source view the workbench needs once extraction is incremental: for
 * each captured source, how much of the briefing currently rests on it, and
 * which snapshot revision that evidence was taken against. Pure derivation
 * over the register — nothing here is persisted, so it can never disagree
 * with the claims it counts.
 */
export interface SourceLifecycle {
  sourceId: string;
  /** Non-discarded claims citing the source at least once. */
  citingClaims: number;
  /** Snapshot revision the source currently stands at. */
  revision: number;
  /** When the current snapshot was retrieved. */
  capturedAt: string;
}

export function deriveSourceLifecycles(
  register: ClaimsRegister,
): SourceLifecycle[] {
  const citing = new Map<string, number>();
  for (const claim of register.claims) {
    // A discarded claim no longer rests on anything — counting it would
    // suggest coverage the briefing does not have.
    if (claim.status === "discarded") {
      continue;
    }
    for (const sourceId of new Set(
      claim.evidence.map((evidence) => evidence.source_id),
    )) {
      citing.set(sourceId, (citing.get(sourceId) ?? 0) + 1);
    }
  }

  const lifecycles: SourceLifecycle[] = [];
  for (const source of register.sources) {
    const snapshot = source.custom.snapshot;
    // Without a frozen snapshot there is no lifecycle to speak of: nothing
    // was captured, so nothing can be cited or revised.
    if (!snapshot) {
      continue;
    }
    lifecycles.push({
      sourceId: source.id,
      citingClaims: citing.get(source.id) ?? 0,
      revision: snapshot.revision,
      capturedAt: snapshot.retrieved_at,
    });
  }
  return lifecycles;
}

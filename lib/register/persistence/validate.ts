import type { ClaimsRegister } from "../schema/register";

/**
 * Referential consistency beyond the field schema: unique ids and resolvable
 * source references. Runs before every write as part of the commit
 * validation (schema → referential integrity → chain).
 */
export function findIntegrityProblems(register: ClaimsRegister): string[] {
  const problems: string[] = [];

  const sourceIds = new Set<string>();
  for (const source of register.sources) {
    if (sourceIds.has(source.id)) {
      problems.push(`duplicate source id ${source.id}`);
    }
    sourceIds.add(source.id);
  }

  const claimIds = new Set<string>();
  for (const claim of register.claims) {
    if (claimIds.has(claim.id)) {
      problems.push(`duplicate claim id ${claim.id}`);
    }
    claimIds.add(claim.id);

    const evidenceIds = new Set<string>();
    for (const evidence of claim.evidence) {
      if (evidenceIds.has(evidence.id)) {
        problems.push(
          `duplicate evidence id ${evidence.id} on claim ${claim.id}`,
        );
      }
      evidenceIds.add(evidence.id);
      if (!sourceIds.has(evidence.source_id)) {
        problems.push(
          `evidence ${evidence.id} on claim ${claim.id} references unknown source ${evidence.source_id}`,
        );
      }
    }
  }

  // Workbench epic: a claim_anchor_revised event's anchor_change must
  // reference an existing claim (documented extension, additive).
  for (const event of register.project_events) {
    if (
      event.anchor_change !== undefined &&
      !claimIds.has(event.anchor_change.claim_id)
    ) {
      problems.push(
        `project event ${event.seq} anchor_change references unknown claim ${event.anchor_change.claim_id}`,
      );
    }
  }

  return problems;
}

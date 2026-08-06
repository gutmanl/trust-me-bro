import type { ClaimsRegister } from "../schema/register";
import { allChainEntries, computeEntryHash } from "./appender";
import { genesisPrevHash } from "./genesis";

export type ChainVerificationError =
  | { type: "empty_chain" }
  | { type: "missing_seq_start"; firstSeq: number }
  | { type: "duplicate_seq"; seq: number }
  | { type: "gap"; expectedSeq: number; foundSeq: number }
  | { type: "prev_hash_mismatch"; seq: number }
  | { type: "hash_mismatch"; seq: number }
  | {
      type: "status_mismatch";
      claimId: string;
      status: string;
      lastHistoryStatus: string;
    };

export interface ChainVerificationResult {
  ok: boolean;
  entryCount: number;
  errors: ChainVerificationError[];
}

/**
 * Verifies the project-wide hash chain: collects all history entries and
 * project events, orders them by seq, and checks gaplessness and chain
 * closure back to the genesis hash of the project identity, plus the
 * consistency of every claim's `status` field with its chained history.
 * Pure and I/O-free so the standalone CLI `tmb verify` can reuse it
 * unchanged.
 *
 * Detects after-the-fact modification or interior removal of entries —
 * including deleting an entire claim with its history — and status fields
 * diverging from the recorded transitions. NOT detected: truncation of the
 * chain's tail (removing the entries with the highest seq values leaves an
 * internally consistent chain). Guarding against that requires an external
 * commitment to the chain head — the export bundle's manifest checksums
 * (export epic) and the git history provide it; within a working directory
 * the chain alone cannot.
 */
export function verifyChain(register: ClaimsRegister): ChainVerificationResult {
  const entries = [...allChainEntries(register)].sort((a, b) => a.seq - b.seq);
  const errors: ChainVerificationError[] = [];

  if (entries.length === 0) {
    // An initialized project has at least the project_created event.
    return { ok: false, entryCount: 0, errors: [{ type: "empty_chain" }] };
  }

  if (entries[0].seq !== 1) {
    errors.push({ type: "missing_seq_start", firstSeq: entries[0].seq });
  }

  let expectedPrevHash = genesisPrevHash(register.project);
  let previousSeq: number | undefined;
  for (const entry of entries) {
    if (previousSeq !== undefined) {
      if (entry.seq === previousSeq) {
        errors.push({ type: "duplicate_seq", seq: entry.seq });
        continue;
      }
      if (entry.seq !== previousSeq + 1) {
        errors.push({
          type: "gap",
          expectedSeq: previousSeq + 1,
          foundSeq: entry.seq,
        });
      }
    }
    if (entry.prev_hash !== expectedPrevHash) {
      errors.push({ type: "prev_hash_mismatch", seq: entry.seq });
    }
    const { hash, ...entryWithoutHash } = entry;
    if (computeEntryHash(entryWithoutHash) !== hash) {
      errors.push({ type: "hash_mismatch", seq: entry.seq });
    }
    expectedPrevHash = hash;
    previousSeq = entry.seq;
  }

  // A claim's status is derived state: it must equal the to_status of its
  // latest (highest-seq) history entry, otherwise the plain field was edited
  // past the chain.
  for (const claim of register.claims) {
    const latest = [...claim.history].sort((a, b) => a.seq - b.seq).at(-1);
    if (latest && latest.to_status !== claim.status) {
      errors.push({
        type: "status_mismatch",
        claimId: claim.id,
        status: claim.status,
        lastHistoryStatus: latest.to_status,
      });
    }
  }

  return { ok: errors.length === 0, entryCount: entries.length, errors };
}

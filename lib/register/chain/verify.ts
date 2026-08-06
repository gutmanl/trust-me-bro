import type { ClaimsRegister } from "../schema/register";
import { allChainEntries, computeEntryHash } from "./appender";
import { genesisPrevHash } from "./genesis";

export type ChainVerificationError =
  | { type: "empty_chain" }
  | { type: "missing_seq_start"; firstSeq: number }
  | { type: "duplicate_seq"; seq: number }
  | { type: "gap"; expectedSeq: number; foundSeq: number }
  | { type: "prev_hash_mismatch"; seq: number }
  | { type: "hash_mismatch"; seq: number };

export interface ChainVerificationResult {
  ok: boolean;
  entryCount: number;
  errors: ChainVerificationError[];
}

/**
 * Verifies the project-wide hash chain: collects all history entries and
 * project events, orders them by seq, and checks gaplessness and chain
 * closure back to the genesis hash of the project identity. Pure and
 * I/O-free so the standalone CLI `tmb verify` can reuse it unchanged.
 *
 * Any after-the-fact modification or removal of an entry — including
 * deleting an entire claim with its history — breaks the chain detectably.
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

  return { ok: errors.length === 0, entryCount: entries.length, errors };
}

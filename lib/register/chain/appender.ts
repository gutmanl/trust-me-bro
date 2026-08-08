import type { ClaimsRegister } from "../schema/register";
import { canonicalize } from "./canonical-json";
import { genesisPrevHash } from "./genesis";
import { sha256Hex } from "./hash";

/** Chain fields minted for every history entry and project event. */
export interface ChainLink {
  seq: number;
  prev_hash: string;
  hash: string;
}

/**
 * Computes the hash of a chain entry per the file format appendix: SHA-256
 * over the RFC 8785 canonical serialization of the entry without its `hash`
 * field (i.e. including seq and prev_hash), concatenated with `prev_hash`.
 * prev_hash thus enters twice — inside the canonicalized object and as raw
 * suffix — exactly as specified; do not "simplify" this.
 */
export function computeEntryHash(
  entryWithoutHash: Record<string, unknown> & { prev_hash: string },
): string {
  return sha256Hex(canonicalize(entryWithoutHash) + entryWithoutHash.prev_hash);
}

/**
 * Single-transaction minter for seq/prev_hash/hash. Constructed from the
 * just-read register inside a held project lock (persistence layer), so the
 * in-memory counter is the single writer's counter: gapless seq assignment
 * holds by construction, not by convention. Never exported from the register
 * module's public surface.
 */
export class ChainAppender {
  private nextSeq: number;
  private prevHash: string;

  constructor(register: ClaimsRegister) {
    let maxSeq = 0;
    let lastHash: string | undefined;
    for (const entry of allChainEntries(register)) {
      if (entry.seq > maxSeq) {
        maxSeq = entry.seq;
        lastHash = entry.hash;
      }
    }
    this.nextSeq = maxSeq + 1;
    this.prevHash = lastHash ?? genesisPrevHash(register.project);
  }

  /** Mints the next chain link for a draft entry and advances the chain. */
  append<T extends Record<string, unknown>>(draft: T): T & ChainLink {
    const seq = this.nextSeq;
    const prev_hash = this.prevHash;
    const hash = computeEntryHash({ ...draft, seq, prev_hash });
    this.nextSeq = seq + 1;
    this.prevHash = hash;
    return { ...draft, seq, prev_hash, hash };
  }
}

/**
 * The chain's current tip (highest-seq entry), or undefined for a register
 * without any entries. The export bundle's manifest states this explicitly
 * (chain_head): a legible external commitment to the state at export time —
 * the countermeasure to the tail truncation that chain verification alone
 * cannot detect (see verify.ts).
 */
export function latestChainLink(
  register: ClaimsRegister,
): ChainLink | undefined {
  let latest: ChainLink | undefined;
  for (const entry of allChainEntries(register)) {
    if (!latest || entry.seq > latest.seq) {
      latest = entry;
    }
  }
  return latest
    ? { seq: latest.seq, prev_hash: latest.prev_hash, hash: latest.hash }
    : undefined;
}

/** All chain-carrying entries of a register: every claim's history plus the
 * project events. Iteration order is irrelevant — the chain orders by seq. */
export function* allChainEntries(
  register: ClaimsRegister,
): Generator<Record<string, unknown> & ChainLink> {
  for (const claim of register.claims) {
    yield* claim.history;
  }
  yield* register.project_events;
}

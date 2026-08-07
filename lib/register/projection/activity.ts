import { allChainEntries } from "../chain/appender";
import type { ClaimsRegister } from "../schema/register";

/**
 * Timestamp of the register's most recent change: the `at` of the chain entry
 * with the highest `seq` across all claim histories and project events. The
 * chain orders by seq, not by array position or timestamp comparison, so this
 * is the same "latest" notion the verification uses. Falls back to created_at
 * for a register without entries (unreachable in practice: creation writes
 * the genesis event).
 */
export function lastActivityAt(register: ClaimsRegister): string {
  let maxSeq = 0;
  let at = register.project.created_at;
  for (const entry of allChainEntries(register)) {
    if (entry.seq > maxSeq) {
      maxSeq = entry.seq;
      at = entry.at as string;
    }
  }
  return at;
}

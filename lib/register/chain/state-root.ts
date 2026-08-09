import type { ClaimsRegister } from "../schema/register";
import { canonicalize } from "./canonical-json";
import { sha256Hex } from "./hash";

/**
 * SHA-256 over the RFC 8785 canonical serialization of the register's
 * materialized CONTENT state: schema_version, project, config, sources and
 * every claim without its history[]. The chain entries themselves
 * (history[] and project_events[]) are excluded — they are protected by the
 * entry hashes — so the state root closes exactly the gap the entry chain
 * leaves open: silent edits to claim text, evidence, verification results,
 * source metadata and configuration.
 *
 * Every chain entry minted since this extension carries the state root of
 * the register as committed by its transaction (`state_root`); verification
 * recomputes the root over the current content and compares it against the
 * newest entry's commitment. Excluding the entries avoids circularity: the
 * entry that commits the root is never part of the hashed content.
 */
export function computeStateRoot(register: ClaimsRegister): string {
  const content = {
    schema_version: register.schema_version,
    project: register.project,
    config: register.config,
    sources: register.sources,
    claims: register.claims.map(({ history: _history, ...claim }) => claim),
  };
  return sha256Hex(canonicalize(content));
}

import { z } from "zod";

import { Evidence, Judgment } from "./evidence";
import { ClaimsRegister } from "./register";

/**
 * Generation of the normative JSON Schema (format requirement F8) from the
 * zod model — single source, so schema drift between format and code is
 * structurally impossible (Grobentwurf).
 */

const TARGET = "draft-2020-12";

export function buildRegisterJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClaimsRegister, {
    target: TARGET,
    reused: "ref",
  }) as Record<string, unknown>;
}

/** Sub-schemas the adapter layer uses to validate CLI output pre-merge. */
export function buildEvidenceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Evidence, { target: TARGET, reused: "ref" }) as Record<
    string,
    unknown
  >;
}

export function buildJudgmentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Judgment, { target: TARGET, reused: "ref" }) as Record<
    string,
    unknown
  >;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, sortKeysDeep(child)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Deterministic serialization for the generated schema artifacts: keys sorted
 * recursively, two-space indent, trailing newline — byte-identical output for
 * identical input regardless of object construction order.
 */
export function serializeJsonSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(sortKeysDeep(schema), null, 2)}\n`;
}

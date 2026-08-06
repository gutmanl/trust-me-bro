/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * Implemented directly instead of via a dependency: JCS defines string and
 * number serialization in terms of ECMAScript's JSON.stringify, so the whole
 * scheme reduces to recursive serialization with object keys sorted by UTF-16
 * code units. Verified against the RFC's test vectors in the test suite.
 */

/** JSON-representable value. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          "non-finite numbers are not representable in canonical JSON",
        );
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    // Match JSON.stringify: non-serializable array members become null.
    return `[${value.map((member) => canonicalize(member ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    // Default string comparison sorts by UTF-16 code units, as JCS requires.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalize(member)}`);
  return `{${entries.join(",")}}`;
}

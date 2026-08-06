import { describe, expect, it } from "vitest";

import { canonicalize } from "./canonical-json";

describe("canonicalize (RFC 8785)", () => {
  it("serializes the RFC number test vectors like ECMAScript", () => {
    // Expected values per RFC 8785 (JCS number serialization is defined as
    // ECMAScript Number::toString).
    const input = JSON.parse(
      "[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]",
    ) as number[];
    expect(canonicalize(input)).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27]",
    );
  });

  it("serializes strings exactly like JSON.stringify (JCS definition)", () => {
    const tricky = "ä€$\nA'B\"\\/";
    expect(canonicalize(tricky)).toBe(JSON.stringify(tricky));
  });

  it("sorts object keys by UTF-16 code units", () => {
    expect(canonicalize({ b: 1, a: 2, "€": 3, A: 4 })).toBe(
      '{"A":4,"a":2,"b":1,"€":3}',
    );
  });

  it("sorts keys recursively and keeps array order", () => {
    expect(canonicalize({ z: [{ b: 1, a: 2 }], a: null })).toBe(
      '{"a":null,"z":[{"a":2,"b":1}]}',
    );
  });

  it("drops undefined object members like JSON.stringify", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalize(Infinity)).toThrow(/non-finite/);
  });

  it("round-trips through JSON.parse unchanged", () => {
    const value = {
      text: "Prüfung: 55 %",
      nested: { list: [1, 2.5, "drei"] },
      flag: true,
    };
    expect(JSON.parse(canonicalize(value))).toEqual(value);
  });
});

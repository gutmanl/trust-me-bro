import { describe, expect, it } from "vitest";

import type { RelationType, SupportDegree } from "../../register";
import { aggregateSupportDegree } from "./aggregate-support";

describe("aggregateSupportDegree", () => {
  const cases: Array<[RelationType[], SupportDegree]> = [
    [["supports"], "supported"],
    [["supports", "supports"], "supported"],
    [["supports", "not_relevant"], "supported"],
    [["partially_supports"], "partially_supported"],
    [["supports", "partially_supports"], "partially_supported"],
    [["contradicts"], "unsupported"],
    [["contradicts", "not_relevant"], "unsupported"],
    [["contradicts", "supports"], "uncertain"],
    [["contradicts", "partially_supports"], "uncertain"],
    [["not_relevant"], "unsupported"],
    [[], "unsupported"],
  ];

  it.each(cases)("%j -> %s", (relations, expected) => {
    expect(aggregateSupportDegree(relations)).toBe(expected);
  });
});

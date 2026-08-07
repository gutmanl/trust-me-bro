import { describe, expect, it } from "vitest";

import type { RelationType, SupportDegree } from "../../register";
import { aggregateSupportDegree } from "./aggregate-support";

describe("aggregateSupportDegree", () => {
  const cases: Array<[RelationType[], SupportDegree]> = [
    [["stuetzt"], "supported"],
    [["stuetzt", "stuetzt"], "supported"],
    [["stuetzt", "nicht_einschlaegig"], "supported"],
    [["stuetzt_teilweise"], "partially_supported"],
    [["stuetzt", "stuetzt_teilweise"], "partially_supported"],
    [["widerspricht"], "unsupported"],
    [["widerspricht", "nicht_einschlaegig"], "unsupported"],
    [["widerspricht", "stuetzt"], "uncertain"],
    [["widerspricht", "stuetzt_teilweise"], "uncertain"],
    [["nicht_einschlaegig"], "unsupported"],
    [[], "unsupported"],
  ];

  it.each(cases)("%j -> %s", (relations, expected) => {
    expect(aggregateSupportDegree(relations)).toBe(expected);
  });
});

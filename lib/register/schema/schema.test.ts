import { describe, expect, it } from "vitest";

import { Evidence, Judgment } from "./evidence";
import { ClaimsRegister } from "./register";
import { Source } from "./source";
// The example project from the file-format appendix, transcribed verbatim
// except that the appendix's abbreviated checksums ("9f2b7c1e…") are padded
// with zeros to full 64-char SHA-256 values and "…" model placeholders got
// concrete strings — both owed to the printed example's abbreviation.
import exampleProject from "./__fixtures__/example-project.json";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("ClaimsRegister", () => {
  it("accepts the example project from the file-format appendix", () => {
    expect(() => ClaimsRegister.parse(exampleProject)).not.toThrow();
  });

  it("rejects an unknown claim status with a helpful message", () => {
    const invalid = clone(exampleProject);
    (invalid.claims[0] as { status: string }).status = "geprueft";
    const result = ClaimsRegister.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("status");
  });

  it("rejects an unknown relation type", () => {
    const invalid = clone(exampleProject);
    (invalid.claims[0].evidence[0] as { relation_type: string }).relation_type =
      "belegt";
    expect(ClaimsRegister.safeParse(invalid).success).toBe(false);
  });

  it("rejects evidence without a verbatim excerpt (missing Fundstelle)", () => {
    const invalid = clone(exampleProject);
    (
      invalid.claims[0].evidence[0] as { verbatim_excerpt?: string }
    ).verbatim_excerpt = undefined;
    const result = ClaimsRegister.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("verbatim_excerpt");
  });

  it("rejects a source without CSL id/type", () => {
    const invalid = clone(exampleProject);
    delete (invalid.sources[0] as { type?: string }).type;
    expect(ClaimsRegister.safeParse(invalid).success).toBe(false);
  });

  it("rejects a snapshot whose blob path does not match its checksum", () => {
    const invalid = clone(exampleProject);
    const snapshot = invalid.sources[0].custom.snapshot as {
      blob_path: string;
    };
    snapshot.blob_path = `blobs/aa/${"a".repeat(64)}.pdf`;
    const result = ClaimsRegister.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("blob_path");
  });

  it("rejects unknown fields on workshop-defined objects", () => {
    const invalid = clone(exampleProject);
    (invalid.claims[0] as Record<string, unknown>).note = "extra";
    expect(ClaimsRegister.safeParse(invalid).success).toBe(false);
  });

  it("rejects a truncated checksum", () => {
    const invalid = clone(exampleProject);
    (invalid.project.briefing_import as { sha256: string }).sha256 = "1d40be";
    expect(ClaimsRegister.safeParse(invalid).success).toBe(false);
  });

  it("rejects a claim without history", () => {
    const invalid = clone(exampleProject);
    (invalid.claims[0] as { history: unknown[] }).history = [];
    expect(ClaimsRegister.safeParse(invalid).success).toBe(false);
  });

  it("accepts freshly extracted claims without verification results", () => {
    const fresh = clone(exampleProject);
    const claim = fresh.claims[0] as Record<string, unknown>;
    claim.status = "erfasst";
    delete claim.support_degree;
    const evidence = fresh.claims[0].evidence[0] as Record<string, unknown>;
    delete evidence.existence_check;
    delete evidence.relation_type;
    (evidence.judgments as unknown[]).length = 0;
    expect(ClaimsRegister.safeParse(fresh).success).toBe(true);
  });
});

describe("CSL passthrough", () => {
  it("keeps arbitrary CSL fields on sources", () => {
    const source = clone(exampleProject.sources[0]) as Record<string, unknown>;
    source.volume = "51";
    source["publisher-place"] = "New York";
    const parsed = Source.parse(source);
    expect(parsed.volume).toBe("51");
    expect(parsed["publisher-place"]).toBe("New York");
  });
});

describe("standalone sub-schemas", () => {
  it("parses evidence outside a register context", () => {
    expect(
      Evidence.safeParse(exampleProject.claims[0].evidence[0]).success,
    ).toBe(true);
  });

  it("parses a judgment and enforces the confidence range", () => {
    const judgment = clone(exampleProject.claims[0].evidence[0].judgments[0]);
    expect(Judgment.safeParse(judgment).success).toBe(true);
    expect(Judgment.safeParse({ ...judgment, confidence: 1.2 }).success).toBe(
      false,
    );
  });
});

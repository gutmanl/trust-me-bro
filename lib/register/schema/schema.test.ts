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

  it("accepts second_opinion with, and rejects it without, a secondary backend", () => {
    const valid = clone(exampleProject) as {
      config: {
        second_opinion?: object;
        backends: { secondary?: object };
      };
    };
    valid.config.second_opinion = {
      confidence_threshold: 0.8,
      on_relation_not_supports: true,
    };
    expect(ClaimsRegister.safeParse(valid).success).toBe(true);

    delete valid.config.backends.secondary;
    const result = ClaimsRegister.safeParse(valid);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("second_opinion");
  });

  it("rejects a snapshot carrying text blob and extraction error at once", () => {
    const invalid = clone(exampleProject);
    const snapshot = invalid.sources[0].custom.snapshot as {
      text_extraction_error?: string;
    };
    // The fixture snapshot has a text_blob_path; the error must exclude it.
    snapshot.text_extraction_error = "Gescanntes PDF ohne Textebene.";
    const result = ClaimsRegister.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "text_extraction_error",
    );
  });

  it("accepts a snapshot with a recorded extraction error and no text blob", () => {
    const valid = clone(exampleProject);
    const snapshot = valid.sources[0].custom.snapshot as {
      text_blob_path?: string;
      text_extraction_error?: string;
    };
    delete snapshot.text_blob_path;
    snapshot.text_extraction_error = "Gescanntes PDF ohne Textebene.";
    expect(ClaimsRegister.safeParse(valid).success).toBe(true);
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
    claim.status = "captured";
    delete claim.support_degree;
    const evidence = fresh.claims[0].evidence[0] as Record<string, unknown>;
    delete evidence.existence_check;
    delete evidence.relation_type;
    (evidence.judgments as unknown[]).length = 0;
    expect(ClaimsRegister.safeParse(fresh).success).toBe(true);
  });

  it("accepts a project without reference_scan (optional, absent by default)", () => {
    const withoutScan = clone(exampleProject) as Record<string, unknown>;
    expect(
      (withoutScan.project as Record<string, unknown>).reference_scan,
    ).toBeUndefined();
    expect(ClaimsRegister.safeParse(withoutScan).success).toBe(true);
  });

  it("round-trips project.reference_scan", () => {
    const withScan = clone(exampleProject) as {
      project: Record<string, unknown>;
    };
    withScan.project.reference_scan = {
      scanned_at: "2026-08-06T10:00:00Z",
      sha256: "c".repeat(64),
      blob_path: `blobs/cc/${"c".repeat(64)}.json`,
      method: "regex+llm",
      candidate_count: 5,
    };
    const result = ClaimsRegister.safeParse(withScan);
    expect(result.success).toBe(true);
    expect(
      (result.data as { project: { reference_scan?: { method?: string } } })
        .project.reference_scan?.method,
    ).toBe("regex+llm");
  });

  it("rejects an unknown reference_scan method", () => {
    const invalid = clone(exampleProject) as {
      project: Record<string, unknown>;
    };
    invalid.project.reference_scan = {
      scanned_at: "2026-08-06T10:00:00Z",
      sha256: "c".repeat(64),
      blob_path: `blobs/cc/${"c".repeat(64)}.json`,
      method: "llm-only",
      candidate_count: 5,
    };
    expect(ClaimsRegister.safeParse(invalid).success).toBe(false);
  });

  it("accepts a source without custom.auto_capture (optional, absent by default)", () => {
    const source = clone(exampleProject.sources[0]) as {
      custom: Record<string, unknown>;
    };
    expect(source.custom.auto_capture).toBeUndefined();
    expect(Source.safeParse(source).success).toBe(true);
  });

  it("round-trips custom.auto_capture", () => {
    const source = clone(exampleProject.sources[0]) as {
      custom: Record<string, unknown>;
    };
    source.custom.auto_capture = {
      raw_text: "Meyer et al. (2025), doi:10.1109/TSE.2025.3489012",
      method: "doi",
      score: 0.91,
    };
    const result = Source.safeParse(source);
    expect(result.success).toBe(true);
    expect(
      (result.data as { custom: { auto_capture?: { method?: string } } }).custom
        .auto_capture?.method,
    ).toBe("doi");
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

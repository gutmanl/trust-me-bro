import { describe, expect, it } from "vitest";

import { Evidence, Judgment } from "./evidence";
import { ProjectEvent } from "./history";
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

  it("rejects evidence without a verbatim excerpt (missing evidence)", () => {
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

describe("workbench epic: briefing revisions and quote-based anchors", () => {
  it("accepts a briefing_import with a revision counter and rotated previous_briefings", () => {
    const withRevision = clone(exampleProject) as {
      project: Record<string, unknown>;
    };
    const original = withRevision.project.briefing_import;
    withRevision.project.previous_briefings = [original];
    withRevision.project.briefing_import = {
      imported_at: "2026-08-10T08:00:00Z",
      sha256: "d".repeat(64),
      blob_path: `blobs/dd/${"d".repeat(64)}.md`,
      tool: "deep-research-x",
      revision: 2,
    };
    const result = ClaimsRegister.safeParse(withRevision);
    expect(result.success).toBe(true);
  });

  it("defaults to no revision/previous_briefings (absence means revision 1)", () => {
    const withoutRevision = clone(exampleProject) as {
      project: Record<string, unknown>;
    };
    expect(
      (withoutRevision.project.briefing_import as Record<string, unknown>)
        .revision,
    ).toBeUndefined();
    expect(withoutRevision.project.previous_briefings).toBeUndefined();
    expect(ClaimsRegister.safeParse(withoutRevision).success).toBe(true);
  });

  it("accepts a claim with anchor_quote", () => {
    const withAnchorQuote = clone(exampleProject) as {
      claims: Record<string, unknown>[];
    };
    withAnchorQuote.claims[0].anchor_quote =
      "median review time dropped from 42 to 19 minutes";
    expect(ClaimsRegister.safeParse(withAnchorQuote).success).toBe(true);
  });

  it("accepts briefing_revised and claim_anchor_revised as project event types", () => {
    const withEvents = clone(exampleProject) as {
      project_events: Record<string, unknown>[];
    };
    withEvents.project_events.push({
      seq: 2,
      at: "2026-08-10T08:00:00Z",
      actor: "human:lg",
      event: "briefing_revised",
      reason: "Briefing-Revision importiert.",
      prev_hash: "c41d8a".padEnd(64, "0"),
      hash: "aa11bb".padEnd(64, "0"),
    });
    withEvents.project_events.push({
      seq: 3,
      at: "2026-08-10T08:05:00Z",
      actor: "human:lg",
      event: "claim_anchor_revised",
      reason: "Textstelle manuell korrigiert.",
      prev_hash: "aa11bb".padEnd(64, "0"),
      hash: "cc22dd".padEnd(64, "0"),
    });
    expect(ClaimsRegister.safeParse(withEvents).success).toBe(true);
  });

  it("round-trips a ProjectEvent carrying anchor_change", () => {
    const event = {
      seq: 3,
      at: "2026-08-10T08:05:00Z",
      actor: "human:lg",
      event: "claim_anchor_revised",
      reason: "Textstelle manuell korrigiert.",
      anchor_change: {
        claim_id: "clm_0001",
        previous_anchor: "p12",
        new_anchor: "p14",
        previous_quote: "median review time dropped from 42 to 19 minutes",
        new_quote: "review time fell from 42 to 19 minutes",
      },
      prev_hash: "aa11bb".padEnd(64, "0"),
      hash: "cc22dd".padEnd(64, "0"),
    };
    const result = ProjectEvent.safeParse(event);
    expect(result.success).toBe(true);
    expect(result.data?.anchor_change?.claim_id).toBe("clm_0001");
  });

  it("rejects anchor_change with unknown fields", () => {
    const event = {
      seq: 3,
      at: "2026-08-10T08:05:00Z",
      actor: "human:lg",
      event: "claim_anchor_revised",
      reason: "Textstelle manuell korrigiert.",
      anchor_change: {
        claim_id: "clm_0001",
        previous_anchor: "p12",
        new_anchor: "p14",
        note: "extra",
      },
      prev_hash: "aa11bb".padEnd(64, "0"),
      hash: "cc22dd".padEnd(64, "0"),
    };
    expect(ProjectEvent.safeParse(event).success).toBe(false);
  });

  it("round-trips a source_capture_failed event carrying capture_failure", () => {
    const event = {
      seq: 4,
      at: "2026-08-13T09:00:00Z",
      actor: "system:capture",
      event: "source_capture_failed",
      reason: "Dokument nicht abrufbar (HTTP 404).",
      capture_failure: {
        work_item_id: "wi_3f2a",
        origin: "manual",
        input: {
          kind: "upload",
          source_type: "preprint",
          manual: { title: "Ein Bericht", year: "2026" },
          upload: {
            blob_path: `blobs/ab/${"ab".repeat(32)}.pdf`,
            filename: "bericht.pdf",
          },
        },
      },
      prev_hash: "aa11bb".padEnd(64, "0"),
      hash: "cc22dd".padEnd(64, "0"),
    };
    const result = ProjectEvent.safeParse(event);
    expect(result.success).toBe(true);
    expect(result.data?.capture_failure?.work_item_id).toBe("wi_3f2a");
  });

  it("rejects capture_failure with an unknown origin", () => {
    const event = {
      seq: 4,
      at: "2026-08-13T09:00:00Z",
      actor: "system:capture",
      event: "source_capture_failed",
      reason: "Dokument nicht abrufbar.",
      capture_failure: {
        work_item_id: "wi_3f2a",
        origin: "batch",
        input: { kind: "doi", source_type: "preprint" },
      },
      prev_hash: "aa11bb".padEnd(64, "0"),
      hash: "cc22dd".padEnd(64, "0"),
    };
    expect(ProjectEvent.safeParse(event).success).toBe(false);
  });

  it("accepts a per-source extraction bracket event carrying source_id", () => {
    const event = {
      seq: 5,
      at: "2026-08-13T09:10:00Z",
      actor: "system:extraction",
      event: "batch_run_completed",
      reason: 'Extraktion abgeschlossen – Quelle "src_meyer2026".',
      source_id: "src_meyer2026",
      prev_hash: "aa11bb".padEnd(64, "0"),
      hash: "cc22dd".padEnd(64, "0"),
    };
    expect(ProjectEvent.safeParse(event).success).toBe(true);
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

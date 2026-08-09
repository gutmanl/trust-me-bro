import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TraceEnvelope } from "../../adapters";
import type { ClaimsRegister } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import cslSchema from "./__fixtures__/csl-data.schema.json";
import { buildProvDocument } from "./prov";
import { buildReferencesCsl } from "./references";
import { buildTracesAggregate, readTraceEnvelopes } from "./traces";

function fixtureRegister(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

/** A successful attribution trace correlated with the fixture's judgment:
 * same finished_at/backend/model, written from the same clock read. */
function correlatedEnvelope(): TraceEnvelope {
  return {
    trace_id: "3f2b41a8-7c15-4e0d-9a2b-5d8f13c07a61",
    method: "attribution",
    params: { claim: { id: "clm_0001" }, evidence: { id: "ev_0001" } },
    backend: "claude",
    model: "claude-sonnet-5",
    prompt_version: "v1.0.0",
    prompt_sha256: "a".repeat(64),
    attempt: 1,
    started_at: "2026-07-28T09:19:48Z",
    finished_at: "2026-07-28T09:20:11Z",
    result: { relation_type: "supports" },
  };
}

describe("buildReferencesCsl (TMB-41, F4)", () => {
  it("strips exactly the custom object and keeps every CSL field", () => {
    const register = fixtureRegister();
    const references = buildReferencesCsl(register);
    expect(references).toHaveLength(1);
    expect(references[0]).not.toHaveProperty("custom");
    expect(references[0]).toMatchObject({
      id: "src_meyer2025",
      type: "article-journal",
      DOI: "10.1109/TSE.2025.3489012",
      "container-title": "IEEE Transactions on Software Engineering",
    });
  });

  it("validates against the official CSL-JSON data schema", () => {
    // draft-07 schema, hence plain Ajv (not Ajv2020) with lenient formats.
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile(cslSchema);
    const valid = validate(buildReferencesCsl(fixtureRegister()));
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });
});

describe("buildProvDocument (TMB-41)", () => {
  it("maps sources, claims, evidence, activities and agents per the table", () => {
    const document = buildProvDocument(fixtureRegister(), [
      correlatedEnvelope(),
    ]);
    const graph = document["@graph"] as Record<string, unknown>[];
    const byId = new Map(graph.map((node) => [node.id, node]));

    // Entities: source, claim, evidence — with the typed edge through the
    // evidence node (wasDerivedFrom → source, evidenceOf → claim).
    expect(byId.get("tmb:source/src_meyer2025")).toMatchObject({
      type: "prov:Entity",
      "tmb:sourceType": "peer_reviewed_publication",
    });
    expect(byId.get("tmb:claim/clm_0001")).toMatchObject({
      type: "prov:Entity",
      "tmb:status": "confirmed",
      wasGeneratedBy: "tmb:activity/transition/clm_0001/2",
      wasAttributedTo: "tmb:agent/system/extraction",
    });
    expect(byId.get("tmb:evidence/clm_0001/ev_0001")).toMatchObject({
      wasDerivedFrom: "tmb:source/src_meyer2025",
      "tmb:evidenceOf": "tmb:claim/clm_0001",
      "tmb:relationType": "supports",
    });

    // The judgment activity picks up the correlated trace's start time and
    // the backend agent; the human decision keeps its duration.
    expect(byId.get("tmb:activity/judgment/clm_0001/ev_0001/1")).toMatchObject({
      startedAtTime: "2026-07-28T09:19:48Z",
      endedAtTime: "2026-07-28T09:20:11Z",
      wasAssociatedWith: "tmb:agent/backend/claude",
      "tmb:traceId": "3f2b41a8-7c15-4e0d-9a2b-5d8f13c07a61",
      "tmb:reasoning":
        "Zahlenwert und Richtung stimmen mit dem Auszug ueberein.",
    });
    expect(byId.get("tmb:activity/transition/clm_0001/9")).toMatchObject({
      wasAssociatedWith: "tmb:agent/human/lg",
      "tmb:duration_s": 96,
    });
    expect(byId.get("tmb:agent/human/lg")).toMatchObject({
      type: "prov:Person",
    });
    expect(byId.get("tmb:agent/backend/claude")).toMatchObject({
      type: "prov:SoftwareAgent",
    });
  });

  it("falls back to instantaneous judgment activities without a trace", () => {
    const document = buildProvDocument(fixtureRegister(), []);
    const graph = document["@graph"] as Record<string, unknown>[];
    const judgment = graph.find(
      (node) => node.id === "tmb:activity/judgment/clm_0001/ev_0001/1",
    );
    expect(judgment).toMatchObject({
      startedAtTime: "2026-07-28T09:20:11Z",
      endedAtTime: "2026-07-28T09:20:11Z",
    });
    expect(judgment).not.toHaveProperty("tmb:traceId");
  });

  it("states the documented simplifications in the export itself", () => {
    const document = buildProvDocument(fixtureRegister(), []);
    const notes = document["tmb:documentedSimplifications"] as string[];
    expect(notes.join(" ")).toContain("No separate reasoning nodes");
  });

  it("matches the committed golden file", async () => {
    const document = buildProvDocument(fixtureRegister(), [
      correlatedEnvelope(),
    ]);
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/prov-golden.jsonld",
    );
  });
});

describe("trace aggregate (TMB-41)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-derived-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("reads trace files in name order and aggregates chronologically", () => {
    const first = correlatedEnvelope();
    const second: TraceEnvelope = {
      ...correlatedEnvelope(),
      trace_id: "1a2b3c4d-0000-4e0d-9a2b-5d8f13c07a62",
      backend: "codex",
      model: "gpt-6",
      attempt: 1,
      started_at: "2026-07-28T09:18:00Z",
      finished_at: "2026-07-28T09:18:30Z",
      result: undefined,
      error: {
        kind: "timeout",
        name: "AdapterTimeoutError",
        message: "timed out",
      },
    };
    const tracesDir = path.join(projectDir, "traces");
    fs.mkdirSync(tracesDir, { recursive: true });
    for (const envelope of [first, second]) {
      const compact = envelope.started_at.replace(/[-:.]/g, "");
      fs.writeFileSync(
        path.join(tracesDir, `${compact}--${envelope.trace_id}.json`),
        `${JSON.stringify(envelope, null, 2)}\n`,
      );
    }

    const envelopes = readTraceEnvelopes(projectDir);
    expect(envelopes).toHaveLength(2);

    const aggregate = buildTracesAggregate(fixtureRegister(), envelopes);
    expect(aggregate.project_id).toBe("proj_llm-code-review-2026");
    expect(aggregate.trace_count).toBe(2);
    // Chronological: the failed codex attempt started first.
    expect(aggregate.traces.map((trace) => trace.backend)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("returns an empty aggregate for a project without traces", () => {
    expect(readTraceEnvelopes(projectDir)).toEqual([]);
    const aggregate = buildTracesAggregate(fixtureRegister(), []);
    expect(aggregate.trace_count).toBe(0);
    expect(aggregate.traces).toEqual([]);
  });

  it("rejects malformed trace files instead of silently skipping them", () => {
    const tracesDir = path.join(projectDir, "traces");
    fs.mkdirSync(tracesDir, { recursive: true });
    fs.writeFileSync(
      path.join(tracesDir, "20260728T000000Z--kaputt.json"),
      `{"not":"an envelope"}\n`,
    );
    expect(() => readTraceEnvelopes(projectDir)).toThrow();
  });
});

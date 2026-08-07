import { describe, expect, it } from "vitest";

import {
  AdapterProcessError,
  AdapterRateLimitError,
  createMockBackend,
  Orchestrator,
} from "../../../adapters";
import type { AttributionOutput, RubricOutput } from "../../../adapters";
import type { Claim, Source } from "../../../register";
import { loadRubricRuleSet } from "../rubric-rules";
import { runAttributionAndRubric } from "./attribution-rubric";
import type { Stage23Dependencies } from "./attribution-rubric";

const RULE_SET = loadRubricRuleSet("se-evidenz-rubrik-v1");

function makeSource(
  id: string,
  sourceType: Source["custom"]["source_type"],
): Source {
  return {
    id,
    type: "article-journal",
    custom: {
      source_type: sourceType,
      snapshot: {
        retrieved_at: "2026-08-01T08:00:00Z",
        sha256: "a".repeat(64),
        blob_path: `blobs/aa/${"a".repeat(64)}.pdf`,
        revision: 1,
      },
    },
  } as Source;
}

function makeClaim(sourceIds: string[], claimType: Claim["claim_type"]): Claim {
  return {
    id: "clm_0001",
    text: "Testclaim.",
    claim_type: claimType,
    status: "existenzgeprueft",
    briefing_anchor: "p1",
    provenance: {
      tool: "t",
      model: "m",
      extracted_at: "2026-08-01T08:00:00Z",
      search_path: "s",
    },
    evidence: sourceIds.map((sourceId, index) => ({
      id: `ev_${String(index + 1).padStart(4, "0")}`,
      source_id: sourceId,
      locator: { page: 1 },
      verbatim_excerpt: "Auszug",
      judgments: [],
    })),
    history: [
      {
        seq: 2,
        at: "2026-08-01T08:00:00Z",
        actor: "system:extraction",
        from_status: null,
        to_status: "erfasst",
        reason: "Test.",
        prev_hash: "0".repeat(64),
        hash: "1".repeat(64),
      },
    ],
  };
}

interface Backends {
  primary?: {
    attribution?: AttributionOutput;
    rubric?: RubricOutput;
    script?: ReadonlyArray<Error | "ok">;
  };
  secondary?: { attribution?: AttributionOutput };
  secondaryConfigured?: boolean;
}

function makeDeps(backends: Backends = {}): {
  deps: Stage23Dependencies;
  primaryCalls: () => string[];
  secondaryCalls: () => string[];
} {
  const primary = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: {
      ...(backends.primary?.attribution
        ? { attribution: backends.primary.attribution }
        : {}),
      ...(backends.primary?.rubric ? { rubric: backends.primary.rubric } : {}),
    },
    script: backends.primary?.script,
  });
  const secondary = createMockBackend({
    id: "codex",
    model: "gpt-x",
    overrides: backends.secondary?.attribution
      ? { attribution: backends.secondary.attribution }
      : {},
  });
  const orchestrator = new Orchestrator({
    backends: [primary, secondary],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
  return {
    deps: {
      orchestrator,
      primaryBackendId: "claude",
      secondaryBackendId:
        (backends.secondaryConfigured ?? true) ? "codex" : undefined,
      projectDir: "C:/tmp/proj_x",
      timeoutMs: 90_000,
      secondOpinion: {
        confidence_threshold: 0.8,
        on_relation_not_stuetzt: true,
      },
      rubricVersion: "se-evidenz-rubrik-v1",
      ruleSet: RULE_SET,
    },
    primaryCalls: () => primary.calls.map((job) => job.kind),
    secondaryCalls: () => secondary.calls.map((job) => job.kind),
  };
}

const sourcesById = new Map<string, Source>([
  ["src_a", makeSource("src_a", "begutachtete_publikation")],
  ["src_b", makeSource("src_b", "grauliteratur")],
  ["src_vendor", makeSource("src_vendor", "herstellerdokumentation")],
]);

describe("runAttributionAndRubric", () => {
  it("judges, aggregates and runs the rubric on a confident stuetzt", async () => {
    const { deps, primaryCalls, secondaryCalls } = makeDeps();
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitativer_einzelbefund"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      supportDegree: "supported",
      calibration: { result: "lizenziert", mechanical: "erfuellt" },
    });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.perEvidence[0]).toMatchObject({
      resolvedRelation: "stuetzt",
    });
    expect(outcome.perEvidence[0].newJudgments[0]).toMatchObject({
      backend: "claude",
      model: "claude-sonnet-5",
    });
    // No second opinion for a confident stuetzt; rubric on the primary only.
    expect(primaryCalls()).toEqual(["attribution", "rubric"]);
    expect(secondaryCalls()).toEqual([]);
  });

  it("asks the secondary on low confidence; agreement confirms the first judgment", async () => {
    const { deps, secondaryCalls } = makeDeps({
      primary: {
        attribution: {
          relation_type: "stuetzt",
          confidence: 0.5,
          reasoning: "knapp",
        },
      },
      secondary: {
        attribution: {
          relation_type: "stuetzt",
          confidence: 0.9,
          reasoning: "klar",
        },
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitativer_einzelbefund"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({ status: "ok", supportDegree: "supported" });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.perEvidence[0].newJudgments).toHaveLength(2);
    expect(secondaryCalls()).toEqual(["attribution"]);
  });

  it("leaves the relation unresolved on divergence and skips the rubric", async () => {
    const { deps, primaryCalls } = makeDeps({
      primary: {
        attribution: {
          relation_type: "stuetzt_teilweise",
          confidence: 0.9,
          reasoning: "teils",
        },
      },
      secondary: {
        attribution: {
          relation_type: "stuetzt",
          confidence: 0.9,
          reasoning: "voll",
        },
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitativer_einzelbefund"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      supportDegree: null,
      calibration: null,
    });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.perEvidence[0].resolvedRelation).toBeNull();
    expect(outcome.perEvidence[0].newJudgments).toHaveLength(2);
    expect(primaryCalls()).toEqual(["attribution"]); // no rubric call
  });

  it("runs without second opinions when no secondary backend is configured", async () => {
    const { deps, secondaryCalls } = makeDeps({
      primary: {
        attribution: {
          relation_type: "widerspricht",
          confidence: 0.3,
          reasoning: "widerlegt",
        },
      },
      secondaryConfigured: false,
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitativer_einzelbefund"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      supportDegree: "unsupported",
    });
    expect(secondaryCalls()).toEqual([]);
  });

  it("caps the rubric verdict when the mechanical minimum is unmet", async () => {
    // Empfehlung backed only by vendor documentation: the LLM may say
    // lizenziert, the mechanical rule says no — capped to abschwaechen.
    const { deps } = makeDeps({
      primary: {
        rubric: {
          calibration_result: "lizenziert",
          reasoning: "Mock sagt ja.",
        },
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_vendor"], "empfehlung"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      calibration: { result: "abschwaechen", mechanical: "nicht_erfuellt" },
    });
  });

  it("pauses immediately on a rate limit without partial results", async () => {
    const { deps } = makeDeps({
      primary: {
        script: [new AdapterRateLimitError("claude", "attribution", "429")],
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a", "src_b"], "vergleichende_aussage"),
      sourcesById,
      deps,
    );
    expect(outcome).toEqual({ status: "paused", reason: expect.any(String) });
  });

  it("reports exhausted retries with the failing evidence", async () => {
    const crash = new AdapterProcessError("claude", "attribution", 1, "boom");
    const { deps } = makeDeps({ primary: { script: [crash, crash] } });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitativer_einzelbefund"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "exhausted",
      message: expect.stringContaining("ev_0001"),
    });
  });
});

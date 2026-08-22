import { describe, expect, it } from "vitest";

import {
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterValidationError,
  createMockBackend,
  Orchestrator,
  renderPromptForJob,
} from "../../../adapters";
import type { AttributionOutput, RubricOutput } from "../../../adapters";
import { exampleInputs } from "../../../adapters/__fixtures__/jobs";
import { validateJobOutput } from "../../../adapters/core/validate";
import type { Claim, Source } from "../../../register";
import { resolvePersistedReasoning } from "../reasoning-join";
import { loadRubricRuleSet } from "../rubric-rules";
import { runAttributionAndRubric } from "./attribution-rubric";
import type { Stage23Dependencies } from "./attribution-rubric";

const RULE_SET = loadRubricRuleSet("se-evidence-rubric-v1");

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
    status: "existence_checked",
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
        to_status: "captured",
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
      attribution: backends.primary?.attribution,
      rubric: backends.primary?.rubric,
    },
    script: backends.primary?.script,
  });
  const secondary = createMockBackend({
    id: "codex",
    model: "gpt-x",
    overrides: {
      attribution: backends.secondary?.attribution,
    },
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
        on_relation_not_supports: true,
      },
      rubricVersion: "se-evidence-rubric-v1",
      ruleSet: RULE_SET,
    },
    primaryCalls: () => primary.calls.map((job) => job.kind),
    secondaryCalls: () => secondary.calls.map((job) => job.kind),
  };
}

const sourcesById = new Map<string, Source>([
  ["src_a", makeSource("src_a", "peer_reviewed_publication")],
  ["src_b", makeSource("src_b", "grey_literature")],
  ["src_vendor", makeSource("src_vendor", "vendor_documentation")],
]);

describe("runAttributionAndRubric", () => {
  it("judges, aggregates and runs the rubric on a confident supports", async () => {
    const { deps, primaryCalls, secondaryCalls } = makeDeps();
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitative_finding"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      supportDegree: "supported",
      calibration: { result: "licensed", mechanical: "met" },
    });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.perEvidence[0]).toMatchObject({
      resolvedRelation: "supports",
    });
    expect(outcome.perEvidence[0].newJudgments[0]).toMatchObject({
      backend: "claude",
      model: "claude-sonnet-5",
    });
    // No second opinion for a confident supports; rubric on the primary only.
    expect(primaryCalls()).toEqual(["attribution", "rubric"]);
    expect(secondaryCalls()).toEqual([]);
  });

  it("asks the secondary on low confidence; agreement confirms the first judgment", async () => {
    const { deps, secondaryCalls } = makeDeps({
      primary: {
        attribution: {
          relation_type: "supports",
          confidence: 0.5,
          reasoning: "knapp",
        },
      },
      secondary: {
        attribution: {
          relation_type: "supports",
          confidence: 0.9,
          reasoning: "klar",
        },
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitative_finding"),
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
          relation_type: "partially_supports",
          confidence: 0.9,
          reasoning: "teils",
        },
      },
      secondary: {
        attribution: {
          relation_type: "supports",
          confidence: 0.9,
          reasoning: "voll",
        },
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitative_finding"),
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
          relation_type: "contradicts",
          confidence: 0.3,
          reasoning: "widerlegt",
        },
      },
      secondaryConfigured: false,
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitative_finding"),
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
    // Recommendation backed only by vendor documentation: the LLM may say
    // licensed, the mechanical rule says no — capped to weakened.
    const { deps } = makeDeps({
      primary: {
        rubric: {
          calibration_result: "licensed",
          reasoning: "Mock sagt ja.",
        },
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_vendor"], "recommendation"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      calibration: { result: "weakened", mechanical: "not_met" },
    });
  });

  it("pauses immediately on a rate limit without partial results", async () => {
    const { deps } = makeDeps({
      primary: {
        script: [new AdapterRateLimitError("claude", "attribution", "429")],
      },
    });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a", "src_b"], "comparative_statement"),
      sourcesById,
      deps,
    );
    expect(outcome).toEqual({ status: "paused", reason: expect.any(String) });
  });

  it("reports exhausted retries with the failing evidence", async () => {
    const crash = new AdapterProcessError("claude", "attribution", 1, "boom");
    const { deps } = makeDeps({ primary: { script: [crash, crash] } });
    const outcome = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitative_finding"),
      sourcesById,
      deps,
    );
    expect(outcome).toMatchObject({
      status: "exhausted",
      message: expect.stringContaining("ev_0001"),
    });
  });
});

/**
 * The tracer's end-to-end proof: ONE rubric generation crossing every layer
 * this phase touches, for BOTH live prompt vintages.
 *
 * The DISPLAY-tier half of the crossing — that the persisted string
 * classifies as plain / caveat / technical — is asserted in
 * `app/projects/reasoning-paragraphs.test.ts`, not here. The architecture
 * test's app-source scan would tolerate a deep import from a `lib` test
 * file, but the ESLint `no-restricted-imports` rule is stricter and binding:
 * `lib/**` may not import `app/**` at all, test files included. So this file
 * proves the crossing up to the persisted BYTES, and the app-tier test
 * carries it the last step — legally, because `app` → `lib` is the allowed
 * direction.
 */
describe("two-layer rubric prose — end to end, both prompt vintages", () => {
  const twoLayerResponse = {
    calibration_result: "weakened",
    reasoning_plain:
      "Die Formulierung geht über die Belege hinaus. Es liegt nur eine " +
      "Studie vor, die Aussage klingt aber allgemein.",
    caveat: "die Studie betrachtet nur ein einzelnes Team.",
    reasoning_technical:
      "Die Regel für Zahlenbefunde verlangt eine begutachtete Studie mit " +
      "passendem Kontext; der Kontext weicht ab, daher ist die " +
      "unqualifizierte Formulierung nicht gedeckt.",
  };

  const singleReasoningResponse = {
    calibration_result: "licensed",
    reasoning:
      "Eine begutachtete Studie mit passendem Kontext liegt vor.\n\n" +
      "Jedoch: die Stichprobe ist klein.",
  };

  it("v1.2.0: template renders, response validates, joins and classifies", () => {
    const ruleSet = loadRubricRuleSet("se-evidence-rubric-v1.2");
    expect(ruleSet.prompt_template_version).toBe("1.2.0");

    const rendered = renderPromptForJob(
      "rubric",
      exampleInputs.rubric,
      ruleSet.prompt_template_version,
    );
    expect(rendered.version).toBe("1.2.0");
    expect(rendered.text.length).toBeGreaterThan(0);

    const validated = validateJobOutput(
      "mock",
      "rubric",
      ruleSet.prompt_template_version,
      twoLayerResponse,
    );
    const persisted = resolvePersistedReasoning(validated);
    expect(
      persisted.split("\n\n").map((p) => p.split(" ").slice(0, 2)),
    ).toEqual([
      ["Einfach", "gesagt:"],
      ["Jedoch:", "die"],
      ["Technisch:", "Die"],
    ]);

    const withoutCaveat = validateJobOutput("mock", "rubric", "1.2.0", {
      ...twoLayerResponse,
      caveat: null,
    });
    const twoParagraphs =
      resolvePersistedReasoning(withoutCaveat).split("\n\n");
    expect(twoParagraphs).toHaveLength(2);
    expect(twoParagraphs[0].startsWith("Einfach gesagt: ")).toBe(true);
    expect(twoParagraphs[1].startsWith("Technisch: ")).toBe(true);
  });

  it("v1.1.0: the shape every existing project answers in still validates and still persists byte-for-byte", () => {
    const ruleSet = loadRubricRuleSet("se-evidence-rubric-v1.1");
    expect(ruleSet.prompt_template_version).toBe("1.1.0");
    expect(
      renderPromptForJob(
        "rubric",
        exampleInputs.rubric,
        ruleSet.prompt_template_version,
      ).version,
    ).toBe("1.1.0");

    const validated = validateJobOutput(
      "mock",
      "rubric",
      ruleSet.prompt_template_version,
      singleReasoningResponse,
    );
    expect(resolvePersistedReasoning(validated)).toBe(
      singleReasoningResponse.reasoning,
    );
  });

  // ROADMAP Success Criterion 4: the shapes are PARTITIONED by version, so a
  // model cannot escape the two-layer contract by answering in the old shape.
  it("rejects each shape under the other's prompt version", () => {
    expect(() =>
      validateJobOutput("mock", "rubric", "1.2.0", singleReasoningResponse),
    ).toThrow(AdapterValidationError);
    expect(() =>
      validateJobOutput("mock", "rubric", "1.1.0", twoLayerResponse),
    ).toThrow(AdapterValidationError);
  });
});

/**
 * The SECOND join site (03-02): the attribution half of the same crossing.
 *
 * One asymmetry against the rubric block above, and it is deliberate rather
 * than an omission. The rubric call site already selects its template version
 * from the rule set, so a v1.2.0 rubric generation can be driven through the
 * pipeline today. The ATTRIBUTION call site still renders
 * `CURRENT_PROMPT_VERSION.attribution` (v1.1.0) with two arguments — the
 * per-project pin is 03-03's task, and moving it here would change which
 * template every existing project renders. So the two-layer half is proven as
 * the boundary-to-join COMPOSITION, and the pipeline half is proven where it
 * can be: that a legacy generation still persists the model's own string.
 */
describe("two-layer attribution prose — the second join site", () => {
  const twoLayerResponse = {
    relation_type: "partially_supports",
    confidence: 0.6,
    reasoning_plain:
      "Der Auszug trägt die Aussage nur zum Teil. Er belegt die Richtung, " +
      "aber nicht die Allgemeinheit der Formulierung.",
    caveat: "der Auszug betrachtet nur ein einzelnes Team.",
    reasoning_technical:
      "Der Auszug nennt einen Rückgang der medianen Reviewzeit von 42 auf " +
      "19 Minuten für ein Team; die Aussage verallgemeinert darüber hinaus.",
  };

  it("v1.2.0: the response validates, joins and carries the three role markers", () => {
    const validated = validateJobOutput(
      "mock",
      "attribution",
      "1.2.0",
      twoLayerResponse,
    );
    const persisted = resolvePersistedReasoning(validated);
    expect(
      persisted.split("\n\n").map((p) => p.split(" ").slice(0, 2)),
    ).toEqual([
      ["Einfach", "gesagt:"],
      ["Jedoch:", "der"],
      ["Technisch:", "Der"],
    ]);
  });

  it("v1.2.0: a null caveat omits the paragraph entirely", () => {
    const withoutCaveat = validateJobOutput("mock", "attribution", "1.2.0", {
      ...twoLayerResponse,
      caveat: null,
    });
    const paragraphs = resolvePersistedReasoning(withoutCaveat).split("\n\n");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].startsWith("Einfach gesagt: ")).toBe(true);
    expect(paragraphs[1].startsWith("Technisch: ")).toBe(true);
  });

  // ROADMAP Success Criterion 4, attribution half: the shapes are
  // PARTITIONED by version, so a model cannot escape the two-layer contract
  // by answering in the vintage every existing project still uses.
  it("rejects each shape under the other's prompt version", () => {
    expect(() =>
      validateJobOutput("mock", "attribution", "1.2.0", {
        relation_type: "supports",
        confidence: 0.9,
        reasoning: "Passt.",
      }),
    ).toThrow(AdapterValidationError);
    expect(() =>
      validateJobOutput("mock", "attribution", "1.1.0", twoLayerResponse),
    ).toThrow(AdapterValidationError);
  });

  it("v1.1.0: runAttribution still persists the model's OWN string, byte-for-byte", async () => {
    // The behaviour-preservation claim, asserted through the REAL pipeline
    // path rather than through the join function alone: every existing
    // project renders attribution v1.1.0, and this is what they keep getting.
    const modelString =
      "Der Auszug nennt exakt die berichtete Reduktion.\n\n" +
      "Jedoch: die Stichprobe ist klein.";
    const { deps } = makeDeps({
      primary: {
        attribution: {
          relation_type: "supports",
          confidence: 0.9,
          reasoning: modelString,
        },
      },
      secondaryConfigured: false,
    });
    const result = await runAttributionAndRubric(
      makeClaim(["src_a"], "quantitative_finding"),
      new Map([["src_a", makeSource("src_a", "peer_reviewed_publication")]]),
      deps,
    );
    if (result.status !== "ok") throw new Error(`unexpected ${result.status}`);
    const judgment = result.perEvidence[0].newJudgments[0];
    expect(judgment.reasoning).toBe(modelString);
    // Provenance is still stamped from code, never self-reported.
    expect(judgment.backend).toBe("claude");
    expect(judgment.model).toBe("claude-sonnet-5");
    expect(judgment.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

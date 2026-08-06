import { describe, expect, it } from "vitest";

import { renderPromptForJob } from "../../prompts";
import {
  AttributionOutput,
  ExtractionOutput,
  RepairOutput,
  RubricOutput,
} from "../../schema";
import type { JobKind, JobRequest } from "../../core/jobs";
import { AdapterTimeoutError } from "../../core/errors";
import { createMockBackend } from "./mock-backend";

const claim = {
  id: "clm_0001",
  text: "LLM-gestuetzte Code-Reviews reduzieren die mediane Reviewzeit um etwa 55 %.",
  claim_type: "quantitativer_einzelbefund",
  briefing_anchor: "p12",
} as const;

const evidence = {
  id: "ev_0001",
  source_id: "src_meyer2025",
  locator: { page: 6 },
  verbatim_excerpt: "…median review time dropped from 42 to 19 minutes (-55%)…",
} as const;

function jobFor<K extends JobKind>(kind: K): JobRequest<K> {
  const inputs = {
    extraction: {
      research_question: "Reduzieren LLM-Werkzeuge die Reviewzeit?",
      briefing_text: "Briefing …",
      sources: [{ id: "src_meyer2025", citation: "Meyer (2025)" }],
    },
    attribution: { claim, evidence },
    rubric: {
      claim,
      evidence: [evidence],
      rubric_version: "se-evidenz-rubrik-v1",
    },
    repair: {
      claim,
      evidence: [evidence],
      complaint: { category: "leitsatz_nicht_herleitbar", reason: "Zu stark." },
    },
  } as const;
  const input = inputs[kind] as JobRequest<K>["input"];
  return {
    kind,
    projectDir: "/tmp/proj",
    input,
    prompt: renderPromptForJob(kind, input),
    timeoutMs: 1_000,
  };
}

const outputSchemas = {
  extraction: ExtractionOutput,
  attribution: AttributionOutput,
  rubric: RubricOutput,
  repair: RepairOutput,
} as const;

describe("createMockBackend", () => {
  it.each(Object.keys(outputSchemas) as JobKind[])(
    "answers a %s job with a schema-valid default output",
    async (kind) => {
      const backend = createMockBackend();
      const result = await backend.invoke(jobFor(kind));
      expect(outputSchemas[kind].safeParse(result.output).success).toBe(true);
      expect(result.model).toBe("mock-1");
    },
  );

  it("honors per-kind output overrides", async () => {
    const override = {
      relation_type: "widerspricht",
      confidence: 0.4,
      reasoning: "Der Auszug widerspricht der Richtung des Claims.",
    } as const;
    const backend = createMockBackend({ overrides: { attribution: override } });
    const result = await backend.invoke(jobFor("attribution"));
    expect(result.output).toEqual(override);
  });

  it("throws scripted errors in order, then answers normally", async () => {
    const failure = new AdapterTimeoutError("mock", "attribution", 5);
    const backend = createMockBackend({ script: [failure, "ok"] });
    await expect(backend.invoke(jobFor("attribution"))).rejects.toBe(failure);
    await expect(backend.invoke(jobFor("attribution"))).resolves.toMatchObject({
      model: "mock-1",
    });
  });

  it("records every received job for assertions", async () => {
    const backend = createMockBackend();
    await backend.invoke(jobFor("rubric"));
    await backend.invoke(jobFor("repair"));
    expect(backend.calls.map((job) => job.kind)).toEqual(["rubric", "repair"]);
  });

  it("uses a configurable id and model", async () => {
    const backend = createMockBackend({ id: "mock-b", model: "mock-2" });
    expect(backend.id).toBe("mock-b");
    const result = await backend.invoke(jobFor("attribution"));
    expect(result.model).toBe("mock-2");
  });
});

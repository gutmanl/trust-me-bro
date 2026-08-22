import { describe, expect, it } from "vitest";

import { jobFor } from "../../__fixtures__/jobs";
import { attributionOutputSchemaFor } from "../../schema/attribution";
import { rubricOutputSchemaFor } from "../../schema/rubric";
import {
  AttributionOutput,
  ExtractionOutput,
  ReferenceParseOutput,
  RelevanceOutput,
  RepairOutput,
  ResearchOutput,
  RubricOutput,
} from "../../schema";
import type { JobKind } from "../../core/jobs";
import { AdapterTimeoutError } from "../../core/errors";
import { createMockBackend } from "./mock-backend";

const outputSchemas = {
  research: ResearchOutput,
  extraction: ExtractionOutput,
  attribution: AttributionOutput,
  rubric: RubricOutput,
  repair: RepairOutput,
  relevance: RelevanceOutput,
  reference_parse: ReferenceParseOutput,
} as const;

describe("createMockBackend", () => {
  it.each(Object.keys(outputSchemas) as JobKind[])(
    "answers a %s job with a schema-valid default output",
    async (kind) => {
      const backend = createMockBackend();
      const job = jobFor(kind);
      const result = await backend.invoke(job);
      // Both prose contracts are selected by the job's prompt version, so
      // the schema each default is judged against must be too. Judging the
      // attribution default against the go-forward value alone would assert
      // that the mock answers a shape its own v1.1.0 job never asked for.
      const schema =
        kind === "rubric"
          ? rubricOutputSchemaFor(job.prompt.version)
          : kind === "attribution"
            ? attributionOutputSchemaFor(job.prompt.version)
            : outputSchemas[kind];
      expect(schema.safeParse(result.output).success).toBe(true);
      expect(result.model).toBe("mock-1");
    },
  );

  it("answers a legacy-version rubric job with the two-key default", async () => {
    const backend = createMockBackend();
    const result = await backend.invoke(jobFor("rubric", undefined, "1.1.0"));
    expect(result.output).toHaveProperty("reasoning");
    expect(result.output).not.toHaveProperty("reasoning_plain");
  });

  it("answers a v1.2.0 rubric job with the two-layer default", async () => {
    const backend = createMockBackend();
    const job = jobFor("rubric", undefined, "1.2.0");
    const result = await backend.invoke(job);
    expect(result.output).not.toHaveProperty("reasoning");
    expect(
      rubricOutputSchemaFor(job.prompt.version).safeParse(result.output)
        .success,
    ).toBe(true);
  });

  it("lets a per-kind override beat both version defaults", async () => {
    const override = {
      calibration_result: "weakened",
      reasoning: "Überschrieben.",
    } as const;
    const backend = createMockBackend({ overrides: { rubric: override } });
    for (const version of ["1.1.0", "1.2.0"]) {
      const result = await backend.invoke(jobFor("rubric", undefined, version));
      expect(result.output).toEqual(override);
    }
  });

  it("honors per-kind output overrides", async () => {
    const override = {
      relation_type: "contradicts",
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

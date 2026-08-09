import { describe, expect, it } from "vitest";

import { jobFor } from "../../__fixtures__/jobs";
import {
  AttributionOutput,
  ExtractionOutput,
  RelevanceOutput,
  RepairOutput,
  RubricOutput,
} from "../../schema";
import type { JobKind } from "../../core/jobs";
import { AdapterTimeoutError } from "../../core/errors";
import { createMockBackend } from "./mock-backend";

const outputSchemas = {
  extraction: ExtractionOutput,
  attribution: AttributionOutput,
  rubric: RubricOutput,
  repair: RepairOutput,
  relevance: RelevanceOutput,
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

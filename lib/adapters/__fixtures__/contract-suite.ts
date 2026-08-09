import { describe, expect, it } from "vitest";

import type { Backend } from "../core/contracts";
import {
  AdapterOutputError,
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
} from "../core/errors";
import { attributionJob } from "./jobs";

/**
 * The shared backend contract (TMB-51): every Backend implementation — CLI
 * or API — must map its transport outcomes onto the SAME taxonomy the retry
 * policy and the escalation path consume. Each backend's test file supplies
 * a harness translating the abstract scenarios into its own transport
 * doubles and invokes the suite once; backend-specific wire concerns (argv
 * shape, envelope quirks) stay in that file's own tests.
 */

export const CONTRACT_PAYLOAD = {
  relation_type: "supports",
  confidence: 0.9,
  reasoning: "Beleg deckt die Aussage.",
} as const;

export type ContractScenario =
  | { kind: "success" }
  | { kind: "timeout" }
  | { kind: "transport_failure"; detail: string }
  | { kind: "rate_limited"; detail: string }
  | { kind: "malformed_output"; raw: string }
  | { kind: "schema_violation" };

export interface BackendContractHarness {
  readonly label: string;
  /** Builds a backend whose transport double produces the scenario. */
  build(scenario: ContractScenario): Backend;
}

export function runBackendContractSuite(harness: BackendContractHarness): void {
  describe(`${harness.label} backend contract`, () => {
    it("returns the schema-valid payload with a reported model", async () => {
      const backend = harness.build({ kind: "success" });
      const result = await backend.invoke(attributionJob());
      expect(result.output).toEqual(CONTRACT_PAYLOAD);
      expect(typeof result.model).toBe("string");
      expect(result.model.length).toBeGreaterThan(0);
    });

    it("maps a timeout to AdapterTimeoutError", async () => {
      const backend = harness.build({ kind: "timeout" });
      await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
        AdapterTimeoutError,
      );
    });

    it("maps a transport failure to AdapterProcessError", async () => {
      const backend = harness.build({
        kind: "transport_failure",
        detail: "backend unavailable",
      });
      await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
        AdapterProcessError,
      );
    });

    it("maps a rate-limit signal to AdapterRateLimitError", async () => {
      const backend = harness.build({
        kind: "rate_limited",
        detail: "429 Too Many Requests",
      });
      await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
        AdapterRateLimitError,
      );
    });

    it("maps unparsable output to AdapterOutputError", async () => {
      const backend = harness.build({
        kind: "malformed_output",
        raw: "I found no evidence.",
      });
      await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
        AdapterOutputError,
      );
    });

    it("maps schema-invalid output to AdapterValidationError", async () => {
      const backend = harness.build({ kind: "schema_violation" });
      await expect(backend.invoke(attributionJob())).rejects.toBeInstanceOf(
        AdapterValidationError,
      );
    });
  });
}

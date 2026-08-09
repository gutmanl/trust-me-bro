import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "cli/**/*.test.ts", "tests/**/*.test.ts"],
    env: {
      // Hermetic identity (TMB-47): tests must never read a developer's
      // real ~/.trustmebro/config.json, and the handle mirrors the
      // pre-TMB-47 built-in fallback so the suite stays deterministic.
      // Tests exercising the unconfigured state stub both to undefined.
      TMB_CONFIG_PATH: "./.vitest-no-config/config.json",
      TMB_ACTOR_HANDLE: "user",
    },
    coverage: {
      provider: "v8",
      include: ["lib/**", "cli/**"],
      exclude: [
        "**/*.test.ts",
        "tests/**",
        "**/__fixtures__/**",
        // Type-only modules: erased at compile time (import type), so v8
        // can never observe them executing. Excluding them corrects the
        // denominator; it does not lower the ratchet on executable code.
        "lib/adapters/core/jobs.ts",
        "lib/adapters/core/contracts.ts",
        "lib/adapters/health/types.ts",
        "lib/adapters/orchestrator/types.ts",
        "lib/identity/types.ts",
        "lib/pipeline/sources/fetch-port.ts",
        "lib/pipeline/runs/types.ts",
      ],
      // Guard rail: new domain-core code must arrive tested. Raise, never
      // lower, these thresholds.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});

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
    coverage: {
      provider: "v8",
      include: ["lib/**", "cli/**"],
      exclude: [
        "**/*.test.ts",
        "tests/**",
        // Type-only modules: erased at compile time (import type), so v8
        // can never observe them executing. Excluding them corrects the
        // denominator; it does not lower the ratchet on executable code.
        "lib/adapters/core/jobs.ts",
        "lib/adapters/core/contracts.ts",
        "lib/adapters/orchestrator/types.ts",
        "lib/identity/types.ts",
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

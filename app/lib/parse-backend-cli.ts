import type { BackendCli } from "@/lib/pipeline";

/**
 * Shared form parsing of backend selects (TMB-51): one allow-list for both
 * the creation and the settings action. "anthropic-api" is accepted here
 * but re-gated server-side — the pipeline rejects it while the feature flag
 * is off, and refuses it as primary backend altogether (spike scope).
 */
const BACKEND_CLIS: readonly BackendCli[] = [
  "claude",
  "codex",
  "anthropic-api",
  "mock",
];

export function parseBackendCli(
  value: FormDataEntryValue | null,
): BackendCli | undefined {
  const text = String(value ?? "").trim();
  return (BACKEND_CLIS as readonly string[]).includes(text)
    ? (text as BackendCli)
    : undefined;
}

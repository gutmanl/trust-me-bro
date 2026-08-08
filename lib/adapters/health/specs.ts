/**
 * Per-CLI probe knowledge (TMB-49). Deliberately CLI-vocabulary-FUL — unlike
 * the Backend port, this module's whole job is diagnosing concrete CLIs, so
 * command names, version flags and login commands belong here (a future API
 * backend gets a differently-shaped readiness check: "API key present",
 * not "on PATH").
 */

export interface CliProbeSpec {
  readonly cli: "claude" | "codex";
  /** Command probed on PATH; also the binary the backend adapter spawns. */
  readonly command: string;
  readonly versionArgs: readonly string[];
  /**
   * Minimum known-good version (observed working with the adapter's
   * invocation shape). Comparison is lenient: an unparsable version string
   * degrades to "unknown, don't block" — version output formats are not a
   * stable contract of either CLI.
   */
  readonly minVersion: readonly [number, number, number];
  readonly installHint: string;
  readonly loginHint: string;
}

export const CLI_PROBE_SPECS: Record<"claude" | "codex", CliProbeSpec> = {
  claude: {
    cli: "claude",
    command: "claude",
    versionArgs: ["--version"],
    // The adapter's invocation shape is observed working with 2.x
    // (claude-backend.ts: envelope/modelUsage handling "observed with
    // 2.1.223"); 1.x envelopes predate --setting-sources.
    minVersion: [2, 0, 0],
    installHint:
      "claude nicht gefunden – Claude Code installieren: " +
      "npm install -g @anthropic-ai/claude-code (siehe docs.anthropic.com).",
    loginHint:
      "Nicht angemeldet oder CLI antwortet nicht – im Terminal `claude` " +
      "starten und mit /login anmelden.",
  },
  codex: {
    cli: "codex",
    command: "codex",
    versionArgs: ["--version"],
    // codex exec --json with item.completed events needs a current 0.x CLI.
    minVersion: [0, 20, 0],
    installHint:
      "codex nicht gefunden – Codex CLI installieren: " +
      "npm install -g @openai/codex (siehe developers.openai.com/codex).",
    loginHint:
      "Nicht angemeldet oder CLI antwortet nicht – im Terminal " +
      "`codex login` ausführen.",
  },
};

export function probeSpecFor(cli: string): CliProbeSpec | undefined {
  return cli === "claude" || cli === "codex" ? CLI_PROBE_SPECS[cli] : undefined;
}

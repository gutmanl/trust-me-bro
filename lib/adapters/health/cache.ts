import { processGlobal, resetProcessGlobal } from "../../process-global";
import type { ProbeResult } from "./types";

/**
 * Process-global cache for stage-3 (login) probe results only — a real call
 * costs quota, so it runs on demand and its result is remembered with its
 * timestamp until re-checked. Stages 1+2 are free and always probed fresh.
 * In-memory by design, mirroring the job runner's philosophy: durable truth
 * lives in the register, operational snapshots may die with the process.
 */

const CACHE_KEY = "adapters/login-probe-cache";

/** Anchored on `globalThis` (lib/process-global.ts): the probe is triggered
 * from one module graph and read by the page render in another, and a
 * per-graph Map meant the paid-for result was invisible to the reader. */
function loginProbes(): Map<string, ProbeResult> {
  return processGlobal(CACHE_KEY, () => new Map<string, ProbeResult>());
}

export function getCachedLoginProbe(cli: string): ProbeResult | undefined {
  return loginProbes().get(cli);
}

export function setCachedLoginProbe(cli: string, result: ProbeResult): void {
  loginProbes().set(cli, result);
}

export function __resetLoginProbeCacheForTests(): void {
  resetProcessGlobal(CACHE_KEY);
}

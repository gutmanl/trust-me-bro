import type { ProbeResult } from "./types";

/**
 * Process-global cache for stage-3 (login) probe results only — a real call
 * costs quota, so it runs on demand and its result is remembered with its
 * timestamp until re-checked. Stages 1+2 are free and always probed fresh.
 * In-memory by design, mirroring the job runner's philosophy: durable truth
 * lives in the register, operational snapshots may die with the process.
 */

let loginProbes = new Map<string, ProbeResult>();

export function getCachedLoginProbe(cli: string): ProbeResult | undefined {
  return loginProbes.get(cli);
}

export function setCachedLoginProbe(cli: string, result: ProbeResult): void {
  loginProbes.set(cli, result);
}

export function __resetLoginProbeCacheForTests(): void {
  loginProbes = new Map();
}

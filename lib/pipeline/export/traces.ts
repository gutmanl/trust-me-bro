import fs from "node:fs";
import path from "node:path";

import { TraceEnvelope } from "../../adapters";
import type { ClaimsRegister } from "../../register";
import { requireProjectStore } from "../projects";

/**
 * derived/traces.json (TMB-41): the adapter trace log — one immutable
 * JSON-RPC-like envelope per LLM call, including failed attempts — as one
 * tool-readable aggregate. Derived purely from the traces/ directory and the
 * register (no second storage format); deterministic for a given project
 * state, so the same state yields byte-identical output.
 */

export interface TracesAggregate {
  project_id: string;
  trace_count: number;
  traces: TraceEnvelope[];
}

/** Raw trace files of a project in name (= chronological) order — the
 * bundle carries them verbatim under traces/. */
export function readTraceFiles(
  projectDir: string,
): { name: string; content: Buffer }[] {
  const tracesDir = path.join(projectDir, "traces");
  if (!fs.existsSync(tracesDir)) {
    return [];
  }
  return fs
    .readdirSync(tracesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      content: fs.readFileSync(path.join(tracesDir, name)),
    }));
}

/** Reads and validates every trace file of a project, in file order. */
export function readTraceEnvelopes(projectDir: string): TraceEnvelope[] {
  return readTraceFiles(projectDir).map(({ content }) =>
    TraceEnvelope.parse(JSON.parse(content.toString("utf8"))),
  );
}

/** Pure aggregate over already-read envelopes, ordered chronologically
 * (started_at, then trace_id as deterministic tie-breaker). */
export function buildTracesAggregate(
  register: ClaimsRegister,
  envelopes: readonly TraceEnvelope[],
): TracesAggregate {
  const traces = [...envelopes].sort(
    (a, b) =>
      a.started_at.localeCompare(b.started_at) ||
      a.trace_id.localeCompare(b.trace_id),
  );
  return {
    project_id: register.project.id,
    trace_count: traces.length,
    traces,
  };
}

/** Standalone download of the trace aggregate (also part of the bundle). */
export async function getTracesAggregate(
  projectId: string,
): Promise<TracesAggregate> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  return buildTracesAggregate(register, readTraceEnvelopes(store.projectDir));
}

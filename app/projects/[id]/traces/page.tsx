import { SubpageHeader } from "@/app/components/ui";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { getTracesAggregate, summarizeTraces } from "@/lib/pipeline";
import { formatModel, formatTimestamp } from "../../status-labels";

export const dynamic = "force-dynamic";

/**
 * In-app trace viewer (finding 6): the adapter trace log — one envelope per
 * LLM attempt, including failed ones — readable in the interface instead of
 * only as a downloaded traces.json. Also surfaces the run accounting
 * (wall-clock duration and the best-effort token totals the backends
 * reported), the observability an examiner asks about.
 */

const METHOD_LABELS: Record<string, string> = {
  research: "Recherche",
  extraction: "Extraktion",
  attribution: "Attribution",
  rubric: "Rubrik-Kalibrierung",
  repair: "Reparatur",
  relevance: "Einschlägigkeit",
  reference_parse: "Referenz-Parsing",
};

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  }
  return `${Math.round(ms)} ms`;
}

function attemptDurationMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

export default async function TracesPage(
  props: PageProps<"/projects/[id]/traces">,
) {
  const { id } = await props.params;
  const aggregate = await loadProjectOrNotFound(() => getTracesAggregate(id));
  const summary = summarizeTraces(aggregate.traces);

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Trace-Log (LLM-Aufrufe)" />
        <p className="mt-1 text-sm text-slate-600">
          Ein Eintrag je Backend-Aufruf – auch fehlgeschlagene und wiederholte.
          Dauer und Tokenzahlen sind das, was das jeweilige Backend gemeldet
          hat; nicht jedes Backend meldet Tokens.
        </p>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">Laufbilanz</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Aufrufe</dt>
            <dd className="text-lg font-semibold">{summary.attempts}</dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">davon fehlgeschlagen</dt>
            <dd className="text-lg font-semibold">{summary.failedAttempts}</dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Gesamtdauer</dt>
            <dd className="text-lg font-semibold">
              {formatDuration(summary.totalDurationMs)}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Tokens (ein/aus)</dt>
            <dd className="text-lg font-semibold">
              {summary.usageReported
                ? `${summary.inputTokens ?? "–"} / ${summary.outputTokens ?? "–"}`
                : "nicht gemeldet"}
            </dd>
          </div>
        </dl>
      </section>

      {aggregate.traces.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Noch keine Aufrufe – sie entstehen mit Extraktion, Prüfung und
          Reparatur.
        </p>
      ) : (
        <section className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Zeitpunkt</th>
                <th className="px-4 py-3 font-medium">Schritt</th>
                <th className="px-4 py-3 font-medium">Backend / Modell</th>
                <th className="px-4 py-3 font-medium">Dauer</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Ergebnis</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {aggregate.traces.map((trace) => (
                <tr key={trace.trace_id}>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatTimestamp(trace.started_at)}
                  </td>
                  <td className="px-4 py-3">
                    {METHOD_LABELS[trace.method] ?? trace.method}
                    {trace.attempt > 1 ? (
                      <span className="ml-1 text-xs text-slate-400">
                        (Versuch {trace.attempt})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="font-mono">{trace.backend}</span>
                    <span className="text-slate-400">
                      {" "}
                      · {trace.model === null ? "–" : formatModel(trace.model)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {formatDuration(
                      attemptDurationMs(trace.started_at, trace.finished_at),
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {trace.usage
                      ? `${trace.usage.input_tokens ?? "–"} / ${trace.usage.output_tokens ?? "–"}`
                      : "–"}
                  </td>
                  <td className="px-4 py-3">
                    {trace.error ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">
                        {trace.error.kind}
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                        ok
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { SubpageHeader } from "@/app/components/ui";
import { getProjectMetrics } from "@/lib/pipeline";
import { STATUS_LABELS, SUPPORT_LABELS } from "../../status-labels";

export const metadata: Metadata = { title: "Auswertung" };

export const dynamic = "force-dynamic";

const SUPPORT_ORDER = [
  "supported",
  "partially_supported",
  "unsupported",
  "uncertain",
] as const;

function formatSeconds(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes} min ${rest} s`;
  }
  return `${Math.round(seconds)} s`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(".", ",")} %`;
}

export default async function MetricsPage(
  props: PageProps<"/projects/[id]/metrics">,
) {
  const { id } = await props.params;
  const metrics = await loadProjectOrNotFound(() => getProjectMetrics(id));

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader
          projectId={id}
          title="Auswertung (Kennzahlen)"
          current="metrics"
        />
        <p className="mt-1 text-sm text-slate-600">
          Alle Kennzahlen werden bei jedem Aufruf aus dem Verlauf berechnet und
          bewusst nicht gespeichert – der fortschreibende Verlauf bleibt die
          einzige Quelle. Zusätzliche Stichprüfungen sind separat ausgewiesen.
        </p>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Vollständigkeit der Belege
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Anteil der Aussagen mit mindestens einem gegen das eingefrorene
          Dokument zitatgeprüften Beleg – nicht die vollständige Herkunft jeder
          Aussage.
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Aussagen gesamt</dt>
            <dd className="text-lg font-semibold">
              {metrics.evidence_completeness.total_claims}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">mit nachgewiesenem Beleg</dt>
            <dd className="text-lg font-semibold">
              {metrics.evidence_completeness.with_proven_evidence}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Anteil</dt>
            <dd className="text-lg font-semibold">
              {formatPercent(metrics.evidence_completeness.ratio)}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Richtigkeit der Belege (nach manueller Überprüfung)
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Verteilung der Unterstützungsgrade über die{" "}
          {metrics.evidence_correctness.total_terminal} menschlich
          abgeschlossenen Aussagen (bestätigt/verworfen).
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-5">
          {SUPPORT_ORDER.map((degree) => (
            <div
              key={degree}
              className="rounded-md bg-slate-50 px-3 py-2 text-center"
            >
              <dt className="text-xs text-slate-500">
                {SUPPORT_LABELS[degree]}
              </dt>
              <dd className="text-lg font-semibold">
                {metrics.evidence_correctness.by_support_degree[degree]}
              </dd>
            </div>
          ))}
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">ohne Bewertung</dt>
            <dd className="text-lg font-semibold">
              {metrics.evidence_correctness.by_support_degree.unassessed}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">Prüfaufwand</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Manuelle Überprüfungen</dt>
            <dd className="text-lg font-semibold">
              {metrics.review_effort.total_decisions}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Gesamtdauer</dt>
            <dd className="text-lg font-semibold">
              {formatSeconds(metrics.review_effort.total_duration_s)}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">
              Ø je manueller Überprüfung
            </dt>
            <dd className="text-lg font-semibold">
              {formatSeconds(metrics.review_effort.mean_duration_s)}
            </dd>
          </div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
            <dt className="text-xs text-slate-500">Reparaturzyklen</dt>
            <dd className="text-lg font-semibold">
              {metrics.review_effort.total_repair_cycles}
            </dd>
          </div>
        </dl>
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Zusätzliche Stichprüfung (separat gezählt):{" "}
          {metrics.spot_check.total_decisions} manuelle Überprüfung(en),{" "}
          {formatSeconds(metrics.spot_check.total_duration_s)}
          {metrics.spot_check.claim_ids.length > 0 ? (
            <>
              {" "}
              – Aussagen{" "}
              <span className="font-mono">
                {metrics.spot_check.claim_ids.join(", ")}
              </span>
            </>
          ) : null}
        </p>
      </section>

      {metrics.warm_run ? (
        <section className="rounded-md border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-700">
            Wiederverwendung (Folgeprojekt)
          </h2>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
              <dt className="text-xs text-slate-500">übernommen</dt>
              <dd className="text-lg font-semibold">
                {metrics.warm_run.adopted_total}
              </dd>
            </div>
            <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
              <dt className="text-xs text-slate-500">
                weiterhin abgeschlossen
              </dt>
              <dd className="text-lg font-semibold">
                {metrics.warm_run.still_settled}
              </dd>
            </div>
            <div className="rounded-md bg-slate-50 px-3 py-2 text-center">
              <dt className="text-xs text-slate-500">Relevanz negativ</dt>
              <dd className="text-lg font-semibold">
                {metrics.warm_run.routed_negative_relevance}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            Ursprungsprojekt(e):{" "}
            <span className="font-mono">
              {metrics.warm_run.origin_project_ids.join(", ")}
            </span>
          </p>
        </section>
      ) : null}

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">Export</h2>
        <p className="mt-1 text-xs text-slate-500">
          Der Export enthält die Rohwerte je Aussage, nicht nur Aggregate.
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-4 text-sm">
          <li>
            <a
              href={`/api/projects/${id}/metrics?format=csv`}
              className="font-mono text-xs text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
            >
              metrics.csv
            </a>
          </li>
          <li>
            <a
              href={`/api/projects/${id}/metrics?format=json`}
              className="font-mono text-xs text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
            >
              metrics.json
            </a>
          </li>
        </ul>
      </section>

      {metrics.rows.length > 0 ? (
        <section className="rounded-md border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
            Rohwerte je Aussage ({metrics.rows.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="px-4 py-2 font-medium">Aussage</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Beleg</th>
                  <th className="px-4 py-2 font-medium">Grad</th>
                  <th className="px-4 py-2 font-medium">
                    Manuelle Überprüfungen
                  </th>
                  <th className="px-4 py-2 font-medium">Dauer</th>
                  <th className="px-4 py-2 font-medium">Zyklen</th>
                  <th className="px-4 py-2 font-medium">Stichprobe</th>
                  <th className="px-4 py-2 font-medium">übernommen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {metrics.rows.map((row) => (
                  <tr key={row.claim_id}>
                    <td className="px-4 py-2 font-mono">{row.claim_id}</td>
                    <td className="px-4 py-2">{STATUS_LABELS[row.status]}</td>
                    <td className="px-4 py-2">
                      {row.has_proven_evidence ? "✓" : "–"}
                    </td>
                    <td className="px-4 py-2">
                      {row.support_degree
                        ? SUPPORT_LABELS[row.support_degree]
                        : "–"}
                    </td>
                    <td className="px-4 py-2">{row.adjudication_count}</td>
                    <td className="px-4 py-2">
                      {formatSeconds(row.adjudication_duration_s)}
                    </td>
                    <td className="px-4 py-2">{row.repair_cycles}</td>
                    <td className="px-4 py-2">
                      {row.is_sample_control ? "✓" : "–"}
                    </td>
                    <td className="px-4 py-2">{row.is_adopted ? "✓" : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

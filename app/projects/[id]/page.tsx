import Link from "next/link";
import { notFound } from "next/navigation";

import { getProjectSummary, UnknownProjectError } from "@/lib/pipeline";
import type { ProjectSummary } from "@/lib/pipeline";
import { formatTimestamp, STATUS_LABELS, STATUS_ORDER } from "../status-labels";

export const dynamic = "force-dynamic";

async function loadSummary(id: string): Promise<ProjectSummary> {
  try {
    return await getProjectSummary(id);
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      notFound();
    }
    throw error;
  }
}

export default async function ProjectPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  const summary = await loadSummary(id);

  return (
    <div className="space-y-6">
      <div>
        <p className="font-mono text-xs text-slate-500">{summary.id}</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {summary.research_question}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Angelegt: {formatTimestamp(summary.created_at)} · Letzte Änderung:{" "}
          {formatTimestamp(summary.last_change_at)}
        </p>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">Claim-Status</h2>
        {summary.total_claims === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Noch keine Claims – sie entstehen mit der Extraktion aus dem
            Briefing.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-5">
            {STATUS_ORDER.map((status) => (
              <div
                key={status}
                className="rounded-md bg-slate-50 px-3 py-2 text-center"
              >
                <dt className="text-xs text-slate-500">
                  {STATUS_LABELS[status]}
                </dt>
                <dd className="text-lg font-semibold">
                  {summary.claim_counts[status]}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Arbeitsschritte
        </h2>
        <ol className="mt-3 space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <span
              className={
                summary.briefing_imported ? "text-green-600" : "text-slate-400"
              }
            >
              {summary.briefing_imported ? "✓" : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/briefing`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Briefing importieren
            </Link>
          </li>
          <li className="flex items-center gap-2">
            <span
              className={
                summary.source_count > 0 ? "text-green-600" : "text-slate-400"
              }
            >
              {summary.source_count > 0 ? "✓" : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/sources`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Quellen erfassen und einfrieren
            </Link>
          </li>
          <li className="flex items-center gap-2">
            <span
              className={
                summary.total_claims > 0 ? "text-green-600" : "text-slate-400"
              }
            >
              {summary.total_claims > 0 ? "✓" : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/extraction`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Claims extrahieren
            </Link>
          </li>
        </ol>
      </section>
    </div>
  );
}

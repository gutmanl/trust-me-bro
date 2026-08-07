import Link from "next/link";

import { listProjects } from "@/lib/pipeline";
import { formatTimestamp, STATUS_LABELS, STATUS_ORDER } from "./status-labels";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await listProjects();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projekte</h1>
        <Link
          href="/projects/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Projekt anlegen
        </Link>
      </div>

      {projects.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
          Noch keine Projekte. Lege ein Projekt mit einer Recherchefrage an, um
          ein Briefing zu prüfen.
        </p>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}`}
                className="block rounded-md border border-slate-200 bg-white p-4 hover:border-slate-400"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">
                    {project.research_question}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    Letzte Änderung: {formatTimestamp(project.last_change_at)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className="font-mono">{project.id}</span>
                  <span>· {project.source_count} Quelle(n)</span>
                  <span>· {project.total_claims} Claim(s)</span>
                  {STATUS_ORDER.filter(
                    (status) => project.claim_counts[status] > 0,
                  ).map((status) => (
                    <span
                      key={status}
                      className="rounded-full bg-slate-100 px-2 py-0.5"
                    >
                      {STATUS_LABELS[status]}: {project.claim_counts[status]}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import Link from "next/link";

import {
  getInstallationBackendsHealth,
  listProjects,
  usableRealBackends,
} from "@/lib/pipeline";
import { DemoProjectBadge } from "../components/ui";
import { CreateDemoProjectButton } from "../setup/SetupForm";
import { ArchiveProjectControl } from "./ArchiveProjectControl";
import { formatTimestamp, STATUS_LABELS, STATUS_ORDER } from "./status-labels";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await listProjects();
  // Only needed for the empty state: the point is to answer "why can I not
  // do anything here" before the user creates a project to find out.
  const usableBackends =
    projects.length === 0
      ? usableRealBackends(await getInstallationBackendsHealth()).map(
          (backend) => backend.cli,
        )
      : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projekte</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/projects/import"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-500"
          >
            Bundle importieren
          </Link>
          <Link
            href="/projects/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Projekt anlegen
          </Link>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="space-y-4 rounded-md border border-dashed border-slate-300 bg-white p-8">
          <p className="text-center text-slate-500">
            Noch keine Projekte. Lege ein Projekt mit einer Recherchefrage an,
            um ein Briefing zu prüfen.
          </p>
          {usableBackends.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Zurzeit ist keine Agenten-CLI einsatzbereit. Das Beispielprojekt
              und das Demo-Backend funktionieren trotzdem – für eine echte
              Prüfung hilft die{" "}
              <Link href="/settings" className="underline">
                Einrichtungsdiagnose
              </Link>{" "}
              weiter.
            </p>
          ) : (
            <p className="text-center text-sm text-slate-500">
              Einsatzbereite Backends:{" "}
              <span className="font-mono">{usableBackends.join(", ")}</span>
            </p>
          )}
          <div className="flex justify-center">
            <CreateDemoProjectButton />
          </div>
          <p className="text-center text-xs text-slate-500">
            Das Beispielprojekt ist ein gefülltes Demo-Register mit
            synthetischen Quellen – zum Kennenlernen des Ablaufs, keine echte
            Verifikation.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.id} className="flex items-start gap-3">
              <Link
                href={`/projects/${project.id}`}
                className="block flex-1 rounded-md border border-slate-200 bg-white p-4 hover:border-slate-400"
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
                  {project.origin_id ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">
                      importiert aus {project.origin_id}
                    </span>
                  ) : null}
                  {project.is_demo ? <DemoProjectBadge /> : null}
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
              <div className="pt-1">
                <ArchiveProjectControl projectId={project.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import Link from "next/link";

import { BackendHealthNotice, SubpageHeader } from "@/app/components/ui";
import { ResearchGuidance } from "@/app/components/ResearchGuidance";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import {
  getBackendsHealth,
  getResearchState,
  readProject,
} from "@/lib/pipeline";

import { ResearchPanel } from "./ResearchPanel";

export const dynamic = "force-dynamic";

/**
 * Initial research (TMB-55): the briefing is written by the configured
 * backend from the project's research question, and then goes through the
 * ordinary freeze path. Importing a briefing written elsewhere stays a
 * first-class alternative and is linked from here — this page adds an
 * option, it does not replace one.
 */
export default async function ResearchPage(
  props: PageProps<"/projects/[id]/research">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const state = getResearchState(id, register);
  const health = await getBackendsHealth(id);
  const briefing = register.project.briefing_import;

  return (
    <div className="space-y-6">
      <SubpageHeader projectId={id} title="Erstrecherche" />

      {briefing ? (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          <p className="font-medium">Briefing bereits eingefroren</p>
          <p className="mt-1">
            Herkunft: <span className="font-mono">{briefing.tool}</span>. Die
            Erstrecherche erzeugt die Originalfassung und läuft daher nur einmal
            je Projekt.
          </p>
          <p className="mt-2">
            <Link href={`/projects/${id}/briefing`} className="underline">
              Zum eingefrorenen Briefing
            </Link>
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Das konfigurierte Backend recherchiert zur Forschungsfrage dieses
            Projekts und schreibt daraus ein Briefing. Das Ergebnis wird
            anschließend genauso eingefroren und geprüft wie ein von außen
            importiertes – die Herkunft wird dabei festgehalten.
          </p>
          <BackendHealthNotice projectId={id} health={health} mode="block" />
          <ResearchPanel projectId={id} state={state} />
          <p className="text-sm text-slate-500">
            Lieber selbst recherchieren?{" "}
            <Link href={`/projects/${id}/briefing`} className="underline">
              Vorhandenes Briefing importieren
            </Link>
            .
          </p>
          <ResearchGuidance />
        </>
      )}
    </div>
  );
}

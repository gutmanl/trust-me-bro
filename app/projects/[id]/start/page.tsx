import Link from "next/link";

import { primaryButtonClass, SubpageHeader } from "@/app/components/ui";
import { ResearchHub } from "@/app/components/ResearchHub";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { getProjectSummary, readProject } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/**
 * Wizard step 2, "Recherche starten" (Task 12): right after a project is
 * created there is a research question and nothing else — this page is
 * where that question meets the tool guide and the prompt converter before
 * the user goes off to actually research it. It stays a side view, not a
 * gate: all three exits lead to normal, always-reachable places, so closing
 * the tab here leaves a perfectly usable project behind.
 */
export default async function StartPage(
  props: PageProps<"/projects/[id]/start">,
) {
  const { id } = await props.params;
  await loadProjectOrNotFound(() => readProject(id));
  const summary = await getProjectSummary(id);

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Recherche starten" />
        <p className="mt-1 text-sm text-slate-600">
          {summary.research_question}
        </p>
      </div>

      <ResearchHub question={summary.research_question} />

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
        <Link href={`/projects/${id}`} className={primaryButtonClass}>
          Briefing liegt vor → zum Arbeitsbereich
        </Link>
        <Link
          href={`/projects/${id}/research`}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          In der Anwendung recherchieren
        </Link>
        <Link
          href={`/projects/${id}`}
          className="text-sm text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
        >
          Später
        </Link>
      </div>
    </div>
  );
}

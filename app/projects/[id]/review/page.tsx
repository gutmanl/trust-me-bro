import Link from "next/link";

import { SubpageHeader } from "@/app/components/ui";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import {
  getBriefingViewModel,
  getVerificationState,
  readProject,
} from "@/lib/pipeline";
import { ReviewWorkspace } from "./ReviewWorkspace";

export const dynamic = "force-dynamic";

/**
 * The integrated review workspace (TMB-5): briefing with inline evidence
 * anchors in the center, evidence detail panel on the right, adjudication
 * queue alongside. Durable data renders server-side; the workspace client
 * component adds selection state and the live refresh during pipeline runs.
 */
export default async function ReviewPage(
  props: PageProps<"/projects/[id]/review">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const briefing = await getBriefingViewModel(id);
  const verificationState = getVerificationState(register);

  return (
    <div className="space-y-6">
      <SubpageHeader projectId={id} title="Adjudikation & Reparatur" />

      {briefing ? (
        <ReviewWorkspace
          projectId={id}
          register={register}
          briefing={briefing}
          verificationActive={verificationState.status === "laeuft"}
        />
      ) : (
        <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          Für dieses Projekt ist noch kein Briefing eingefroren.{" "}
          <Link
            href={`/projects/${id}/briefing`}
            className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
          >
            Zuerst das Briefing importieren.
          </Link>
        </div>
      )}
    </div>
  );
}

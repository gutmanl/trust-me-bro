import Link from "next/link";

import { SubpageHeader } from "@/app/components/ui";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import {
  buildTimeline,
  getChainVerification,
  readProject,
} from "@/lib/pipeline";
import { formatTimestamp, STATUS_LABELS } from "../../status-labels";
import { COMPLAINT_CATEGORY_LABELS } from "../review/complaint-labels";
import { ROUTING_LABELS } from "../review/routing-labels";

export const dynamic = "force-dynamic";

/**
 * The append-only history (TMB-38): the mixed chain from the pipeline's
 * timeline projection, fully server-rendered; the claim filter is a plain
 * query parameter. Discarded claims stay visible with their reason (A6:
 * negative decisions remain reusable).
 */

const EVENT_LABELS: Record<string, string> = {
  project_created: "Projekt angelegt",
  briefing_imported: "Briefing eingefroren",
  source_set_frozen: "Quellenbestand eingefroren",
  source_set_revised: "Quellenbestand revidiert",
  batch_run_started: "Extraktionslauf gestartet",
  batch_run_completed: "Extraktionslauf beendet",
  verification_run_started: "Prüflauf gestartet",
  verification_run_completed: "Prüflauf beendet",
};

export default async function HistoryPage(
  props: PageProps<"/projects/[id]/history">,
) {
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const claimFilter =
    typeof searchParams.claim === "string" ? searchParams.claim : undefined;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const verification = await getChainVerification(id);
  const timeline = buildTimeline(register, claimFilter);

  return (
    <div className="space-y-6">
      <SubpageHeader projectId={id} title="Verlauf" />

      <div
        className={`rounded-md border p-4 text-sm ${
          verification.ok
            ? "border-green-200 bg-green-50 text-green-800"
            : "border-red-200 bg-red-50 text-red-800"
        }`}
      >
        <p className="font-medium">
          {verification.ok
            ? "Kettenintegrität geprüft – die Historie ist lückenlos verkettet."
            : "Kettenintegrität GEBROCHEN"}
        </p>
        {!verification.ok
          ? verification.errors.map((error, index) => (
              <p key={index} className="mt-1 font-mono text-xs">
                {JSON.stringify(error)}
              </p>
            ))
          : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">Ansicht:</span>
        <Link
          href={`/projects/${id}/history`}
          className={`rounded-full px-2 py-0.5 ${
            claimFilter
              ? "bg-slate-100 text-slate-600 hover:bg-slate-200"
              : "bg-slate-900 text-white"
          }`}
        >
          Gesamtes Projekt
        </Link>
        {register.claims.map((claim) => (
          <Link
            key={claim.id}
            href={`/projects/${id}/history?claim=${claim.id}`}
            className={`rounded-full px-2 py-0.5 font-mono ${
              claimFilter === claim.id
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {claim.id}
          </Link>
        ))}
      </div>

      <ol className="space-y-2">
        {timeline.map((item) => (
          <li
            key={item.entry.seq}
            className="rounded-md border border-slate-200 bg-white p-4 text-sm"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="font-mono">#{item.entry.seq}</span>
              <span>{formatTimestamp(item.entry.at)}</span>
              <span className="font-mono">{item.entry.actor}</span>
              {item.kind === "claim" ? (
                <Link
                  href={`/projects/${id}/history?claim=${item.claimId}`}
                  className="font-mono text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
                >
                  {item.claimId}
                </Link>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5">
                  Projekt
                </span>
              )}
            </div>

            <p className="mt-1 font-medium text-slate-800">
              {item.kind === "claim"
                ? `${
                    item.entry.from_status
                      ? STATUS_LABELS[item.entry.from_status]
                      : "erzeugt"
                  } → ${STATUS_LABELS[item.entry.to_status]}`
                : (EVENT_LABELS[item.entry.event] ?? item.entry.event)}
              {item.kind === "claim" && item.entry.routing ? (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-800">
                  {ROUTING_LABELS[item.entry.routing]}
                </span>
              ) : null}
            </p>

            <p className="mt-1 text-xs text-slate-600">{item.entry.reason}</p>

            {item.kind === "claim" && item.entry.decision ? (
              <p className="mt-1 text-xs text-slate-600">
                <span className="font-medium text-slate-500">
                  Entscheidung:{" "}
                </span>
                {item.entry.decision.categories.length === 0
                  ? "bestätigt"
                  : item.entry.decision.categories
                      .map((category) => COMPLAINT_CATEGORY_LABELS[category])
                      .join(", ")}
                {" · "}
                {item.entry.decision.duration_s} s
              </p>
            ) : null}

            {item.kind === "claim" && item.entry.revision ? (
              <div className="mt-2 rounded-md border border-slate-100 bg-slate-50 p-2 text-xs">
                <p className="text-slate-500">
                  Vorfassung: „{item.entry.revision.previous_text}“
                </p>
                <p className="mt-1 text-slate-700">
                  Neufassung: „{item.entry.revision.new_text}“
                </p>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

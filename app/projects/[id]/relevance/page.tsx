import type { Metadata } from "next";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { BackendHealthNotice, SubpageHeader } from "@/app/components/ui";
import {
  getBackendsHealth,
  getRelevanceState,
  readProject,
} from "@/lib/pipeline";
import {
  formatTimestamp,
  STATUS_LABELS,
  statusBadgeClassName,
} from "../../status-labels";
import { RelevancePanel } from "./RelevancePanel";

export const metadata: Metadata = { title: "Relevanzprüfung" };

export const dynamic = "force-dynamic";

const STATE_BADGES: Record<string, { label: string; className: string }> = {
  not_applicable: {
    label: "Nicht anwendbar – dieses Projekt hat keine übernommenen Aussagen",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  not_started: {
    label: "Noch nicht gestartet",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  running: {
    label: "Läuft …",
    className: "border-blue-200 bg-blue-50 text-blue-800",
  },
  interrupted: {
    label: "Unterbrochen – fortsetzen",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  halted: {
    label: "Angehalten – Aussagen verbleiben ungeprüft",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  completed: {
    label: "Abgeschlossen",
    className: "border-green-200 bg-green-50 text-green-800",
  },
};

export default async function RelevancePage(
  props: PageProps<"/projects/[id]/relevance">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const state = getRelevanceState(id, register);
  const health = await getBackendsHealth(id);
  const badge = STATE_BADGES[state.status];
  const adopted = register.claims.filter(
    (claim) => claim.provenance.origin_project_id !== undefined,
  );

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Relevanzprüfung" />
        <p className="mt-1 text-sm text-slate-600">
          Übernommene Aussagen sind auf demselben Quellenbestand bereits geprüft
          und manuell überprüft – neu bewertet wird nur ihre Relevanz für die
          neue Recherchefrage. Negative oder unsichere Urteile gehen zur
          manuellen Überprüfung; die Entscheidung bleibt beim Menschen.
        </p>
      </div>

      <div className={`rounded-md border p-4 text-sm ${badge.className}`}>
        <p className="font-medium">{badge.label}</p>
        {state.status !== "not_applicable" ? (
          <p className="mt-1">
            {state.pendingClaims} von {state.adoptedClaims} übernommenen
            Aussage(n) ausstehend.
          </p>
        ) : null}
        {state.reason ? <p className="mt-1">{state.reason}</p> : null}
        {state.completedAt ? (
          <p className="mt-1 text-xs">
            Abgeschlossen: {formatTimestamp(state.completedAt)}
          </p>
        ) : null}
      </div>

      {state.status !== "not_applicable" ? (
        <>
          <BackendHealthNotice projectId={id} health={health} mode="block" />
          <RelevancePanel projectId={id} state={state} />
        </>
      ) : null}

      {adopted.length > 0 ? (
        <section className="rounded-md border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
            Übernommene Aussagen ({adopted.length})
          </h2>
          <ul className="divide-y divide-slate-100">
            {adopted.map((claim) => (
              <li key={claim.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm">{claim.text}</p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusBadgeClassName(claim.status)}`}
                  >
                    {STATUS_LABELS[claim.status]}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span className="font-mono">{claim.id}</span>
                  <span>
                    Übernommen aus{" "}
                    <span className="font-mono">
                      {claim.provenance.origin_project_id}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

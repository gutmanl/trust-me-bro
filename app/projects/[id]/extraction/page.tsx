import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { BackendHealthNotice, SubpageHeader } from "@/app/components/ui";
import {
  getBackendsHealth,
  getExtractionState,
  readProject,
} from "@/lib/pipeline";
import { formatTimestamp, STATUS_LABELS } from "../../status-labels";
import { ExtractionPanel } from "./ExtractionPanel";

export const dynamic = "force-dynamic";

const CLAIM_TYPE_LABELS: Record<string, string> = {
  quantitativer_einzelbefund: "Quantitativer Einzelbefund",
  vergleichende_aussage: "Vergleichende Aussage",
  wirksamkeitsaussage: "Wirksamkeitsaussage",
  empfehlung: "Empfehlung",
};

const STATE_BADGES: Record<string, { label: string; className: string }> = {
  nicht_gestartet: {
    label: "Noch nicht gestartet",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  laeuft: {
    label: "Läuft …",
    className: "border-blue-200 bg-blue-50 text-blue-800",
  },
  unterbrochen: {
    label: "Unterbrochen – erneut starten",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  fehlgeschlagen: {
    label: "Fehlgeschlagen",
    className: "border-red-200 bg-red-50 text-red-800",
  },
  abgeschlossen: {
    label: "Abgeschlossen",
    className: "border-green-200 bg-green-50 text-green-800",
  },
};

export default async function ExtractionPage(
  props: PageProps<"/projects/[id]/extraction">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const state = getExtractionState(id, register);
  const health = await getBackendsHealth(id);
  const badge = STATE_BADGES[state.status];

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Claim-Extraktion" />
        <p className="mt-1 text-sm text-slate-600">
          Der Adapter zerlegt das eingefrorene Briefing in atomare Claims mit
          Fundstellen. Unbelegte oder gebündelte Aussagen gehen sichtbar zur
          Adjudikation – sie werden nicht verworfen.
        </p>
      </div>

      <div className={`rounded-md border p-4 text-sm ${badge.className}`}>
        <p className="font-medium">{badge.label}</p>
        {state.reason ? <p className="mt-1">{state.reason}</p> : null}
        {state.completedAt ? (
          <p className="mt-1 text-xs">
            Abgeschlossen: {formatTimestamp(state.completedAt)}
          </p>
        ) : null}
      </div>

      <BackendHealthNotice projectId={id} health={health} mode="block" />

      <ExtractionPanel projectId={id} state={state} />

      {register.claims.length > 0 ? (
        <section className="rounded-md border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
            Extrahierte Claims ({register.claims.length})
          </h2>
          <ul className="divide-y divide-slate-100">
            {register.claims.map((claim) => (
              <li key={claim.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm">{claim.text}</p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      claim.status === "zur_adjudikation"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {STATUS_LABELS[claim.status]}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span className="font-mono">{claim.id}</span>
                  <span>{CLAIM_TYPE_LABELS[claim.claim_type]}</span>
                  <span>Anker: {claim.briefing_anchor}</span>
                  <span>
                    {claim.evidence.length > 0
                      ? `${claim.evidence.length} Fundstelle(n)`
                      : "ohne Fundstelle"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {claim.history[0]?.reason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

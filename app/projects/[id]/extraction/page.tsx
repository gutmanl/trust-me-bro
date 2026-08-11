import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { BackendHealthNotice, SubpageHeader } from "@/app/components/ui";
import {
  deriveExtractionActivity,
  getActiveRun,
  getBackendsHealth,
  readProject,
} from "@/lib/pipeline";
import { STATUS_LABELS } from "../../status-labels";
import { ExtractionPanel } from "./ExtractionPanel";

export const dynamic = "force-dynamic";

const CLAIM_TYPE_LABELS: Record<string, string> = {
  quantitative_finding: "Quantitativer Einzelbefund",
  comparative_statement: "Vergleichende Aussage",
  effectiveness_statement: "Wirksamkeitsaussage",
  recommendation: "Empfehlung",
};

const RUNNING_BADGE = {
  label: "Läuft …",
  className: "border-blue-200 bg-blue-50 text-blue-800",
};

const OUTCOME_BADGES = {
  failed: {
    label: "Letzter Durchlauf fehlgeschlagen",
    className: "border-red-200 bg-red-50 text-red-800",
  },
  completed: {
    label: "Letzter Durchlauf abgeschlossen",
    className: "border-green-200 bg-green-50 text-green-800",
  },
  none: {
    label: "Noch kein Durchlauf",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
};

export default async function ExtractionPage(
  props: PageProps<"/projects/[id]/extraction">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const activity = deriveExtractionActivity(
    register,
    getActiveRun(id)?.kind === "extraction",
  );
  const health = await getBackendsHealth(id);
  const badge = activity.running
    ? RUNNING_BADGE
    : OUTCOME_BADGES[activity.lastOutcome ?? "none"];

  // Proactive precondition (finding 4): mirror the run use-case's checks so
  // the start button is disabled with a reason rather than only failing on
  // submit.
  const blockedReason = !register.project.briefing_import
    ? "Vor der Extraktion muss das Briefing importiert sein."
    : null;

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader
          projectId={id}
          title="Claim-Extraktion"
          nextStep={{
            href: `/projects/${id}/verification`,
            label: "Weiter zur Prüfung",
          }}
        />
        <p className="mt-1 text-sm text-slate-600">
          Die Extraktion läuft je Quelle: zu jeder erfassten Quelle wird ein
          eigener Durchlauf gestartet. Hier findet der Sweep die Aussagen, die
          keine erfasste Quelle zitieren – sie gehen sichtbar zur Adjudikation
          und werden nicht verworfen.
        </p>
      </div>

      <div className={`rounded-md border p-4 text-sm ${badge.className}`}>
        <p className="font-medium">{badge.label}</p>
        {activity.lastMessage ? (
          <p className="mt-1">{activity.lastMessage}</p>
        ) : null}
      </div>

      <BackendHealthNotice projectId={id} health={health} mode="block" />

      <ExtractionPanel
        projectId={id}
        activity={activity}
        blockedReason={blockedReason}
      />

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
                      claim.status === "pending_adjudication"
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

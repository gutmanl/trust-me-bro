import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { SubpageHeader } from "@/app/components/ui";
import { getVerificationState, readProject } from "@/lib/pipeline";
import {
  CALIBRATION_LABELS,
  formatTimestamp,
  STATUS_LABELS,
  statusBadgeClassName,
  SUPPORT_LABELS,
} from "../../status-labels";
import { VerificationPanel } from "./VerificationPanel";

export const dynamic = "force-dynamic";

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
    label: "Unterbrochen – fortsetzen prüft nur die offenen Claims",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  angehalten: {
    label: "Angehalten – es verbleiben offene Claims",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  abgeschlossen: {
    label: "Abgeschlossen",
    className: "border-green-200 bg-green-50 text-green-800",
  },
};

export default async function VerificationPage(
  props: PageProps<"/projects/[id]/verification">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const state = getVerificationState(register);
  const badge = STATE_BADGES[state.status];

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Prüf-Pipeline" />
        <p className="mt-1 text-sm text-slate-600">
          Jeder Claim durchläuft die Kaskade: deterministische Existenzprüfung,
          Attributionsurteil (mit Zweiturteil der anderen Modellfamilie bei
          strittigen Fällen) und Kalibrierung gegen die SE-Evidenz-Rubrik.
          Strittiges wird zur Adjudikation geroutet, nicht automatisch
          entschieden.
        </p>
      </div>

      <div className={`rounded-md border p-4 text-sm ${badge.className}`}>
        <p className="font-medium">{badge.label}</p>
        {state.reason ? <p className="mt-1">{state.reason}</p> : null}
        {state.completedAt ? (
          <p className="mt-1 text-xs">
            Beendet: {formatTimestamp(state.completedAt)}
          </p>
        ) : null}
        {state.totalClaims > 0 ? (
          <p className="mt-1 text-xs">
            {state.totalClaims - state.openClaims} von {state.totalClaims}{" "}
            Claim(s) durch die Vorprüfung; {state.openClaims} offen.
          </p>
        ) : null}
      </div>

      <VerificationPanel projectId={id} state={state} />

      {register.claims.length > 0 ? (
        <section className="rounded-md border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
            Prüfstand der Claims ({register.claims.length})
          </h2>
          <ul className="divide-y divide-slate-100">
            {register.claims.map((claim) => (
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
                  {claim.evidence.some((e) => e.existence_check) ? (
                    <span>
                      Existenz:{" "}
                      {claim.evidence.every(
                        (e) => e.existence_check?.status === "bestanden",
                      )
                        ? "bestanden"
                        : "nicht bestanden"}
                    </span>
                  ) : null}
                  {claim.support_degree ? (
                    <span>
                      Unterstützung: {SUPPORT_LABELS[claim.support_degree]}
                    </span>
                  ) : null}
                  {claim.calibration_result ? (
                    <span>
                      Rubrik: {CALIBRATION_LABELS[claim.calibration_result]}
                    </span>
                  ) : null}
                  {claim.evidence.some((e) => e.judgments.length > 0) ? (
                    <span>
                      {claim.evidence.reduce(
                        (count, e) => count + e.judgments.length,
                        0,
                      )}{" "}
                      Urteil(e)
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {claim.history.at(-1)?.reason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

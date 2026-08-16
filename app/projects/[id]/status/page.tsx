import { SubpageHeader } from "@/app/components/ui";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { getBackendsHealth } from "@/lib/pipeline";
import type { BackendHealth, ProbeResult } from "@/lib/pipeline";

import { LoginProbeButton } from "./LoginProbeButton";

export const dynamic = "force-dynamic";

const STAGE_TITLES: Record<ProbeResult["stage"], string> = {
  on_path: "Stufe 1 – CLI im Suchpfad",
  version_ok: "Stufe 2 – Version kompatibel",
  login_ok: "Stufe 3 – Anmeldung funktionsfähig",
};

const STATUS_BADGES: Record<
  ProbeResult["status"],
  { label: string; className: string }
> = {
  ok: { label: "OK", className: "border-green-200 bg-green-50 text-green-800" },
  failed: {
    label: "Fehlgeschlagen",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  unknown: {
    label: "Unbekannt",
    className: "border-slate-200 bg-slate-50 text-slate-600",
  },
};

function BackendCard({
  projectId,
  role,
  which,
  health,
}: {
  projectId: string;
  role: string;
  which: "primary" | "secondary";
  health: BackendHealth;
}) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold text-slate-700">
          {role}: <span className="font-mono">{health.cli}</span>
        </h2>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${
            health.usable
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {health.usable ? "einsatzbereit" : "nicht einsatzbereit"}
        </span>
      </div>
      <ul className="mt-3 space-y-3">
        {health.stages.map((stage) => {
          const badge = STATUS_BADGES[stage.status];
          return (
            <li key={stage.stage} className="text-sm">
              <div className="flex items-center justify-between gap-4">
                <p className="font-medium text-slate-700">
                  {stage.title ?? STAGE_TITLES[stage.stage]}
                </p>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${badge.className}`}
                >
                  {badge.label}
                </span>
              </div>
              <p className="mt-0.5 text-slate-600">{stage.detail}</p>
              {stage.hint ? (
                <p className="mt-0.5 text-amber-700">
                  Nächster Schritt: {stage.hint}
                </p>
              ) : null}
              {stage.checkedAt ? (
                <p className="mt-0.5 text-xs text-slate-400">
                  Geprüft: {new Date(stage.checkedAt).toLocaleString("de-DE")}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-4">
        <LoginProbeButton projectId={projectId} which={which} />
      </div>
    </section>
  );
}

/**
 * Statusseite (TMB-49): per backend the three probe stages with finding and
 * concrete next step. Stages 1+2 are free and freshly probed on every load;
 * stage 3 spends quota and runs only via its button, cached with timestamp.
 */
export default async function StatusPage(
  props: PageProps<"/projects/[id]/status">,
) {
  const { id } = await props.params;
  const health = await loadProjectOrNotFound(() => getBackendsHealth(id));

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Systemstatus der Backends" />
        <p className="mt-1 text-sm text-slate-600">
          Preflight-Diagnose der Agenten-CLIs dieses Projekts. Ohne
          einsatzbereites Backend bleiben Import, Quellenerfassung, die
          deterministische Zitatprüfung, manuelle Überprüfung, Verlauf und
          Export nutzbar; nur die LLM-Prüfschritte sind gesperrt.
        </p>
      </div>
      <BackendCard
        projectId={id}
        role="Primäres Backend"
        which="primary"
        health={health.primary}
      />
      {health.secondary ? (
        <BackendCard
          projectId={id}
          role="Sekundäres Backend"
          which="secondary"
          health={health.secondary}
        />
      ) : (
        <p className="text-sm text-slate-500">
          Kein sekundäres Backend konfiguriert – die Divergenzregel ist für
          dieses Projekt deaktiviert (in den Einstellungen änderbar).
        </p>
      )}
    </div>
  );
}

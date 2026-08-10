import type { BackendHealth, ProbeResult } from "@/lib/pipeline";

import { InstallationProbeButton } from "./InstallationProbeButton";

/**
 * Installation-level rendering of the three-stage backend diagnosis
 * (TMB-54, D7). Shared by the setup wizard and the installation settings
 * page. The per-project variant on the status page stays where it is: it
 * knows about primary/secondary roles, which do not exist yet at
 * installation level.
 */

const FALLBACK_STAGE_TITLES: Record<ProbeResult["stage"], string> = {
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

export function BackendHealthCards({
  health,
  showProbeButtons = true,
}: {
  health: readonly BackendHealth[];
  /** The stage-3 probe spends a small quota share, so it stays a button —
   * and the demo backend has nothing to probe. */
  showProbeButtons?: boolean;
}) {
  return (
    <ul className="space-y-3">
      {health.map((backend) => (
        <li
          key={backend.cli}
          className="rounded-md border border-slate-200 bg-white p-4"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="text-sm font-semibold text-slate-700">
              <span className="font-mono">{backend.cli}</span>
            </h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${
                backend.usable
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {backend.usable ? "einsatzbereit" : "nicht einsatzbereit"}
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {backend.stages.map((stage) => {
              const badge = STATUS_BADGES[stage.status];
              return (
                <li key={stage.stage} className="text-sm">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    <span className="text-slate-700">
                      {stage.title ?? FALLBACK_STAGE_TITLES[stage.stage]}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">{stage.detail}</p>
                  {stage.hint ? (
                    <p className="mt-1 text-xs text-amber-800">{stage.hint}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {showProbeButtons && backend.stages[2].status === "unknown" ? (
            <div className="mt-3">
              <InstallationProbeButton cli={backend.cli} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

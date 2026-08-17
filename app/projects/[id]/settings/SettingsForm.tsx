"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
  SuccessBanner,
} from "@/app/components/ui";
import type { ProjectConfig } from "@/lib/register";
import type { SettingsFormState } from "./actions";
import { updateProjectConfigAction } from "./actions";

const initialState: SettingsFormState = { error: null };

export function SettingsForm({
  projectId,
  config,
  apiBackendEnabled = false,
}: {
  projectId: string;
  config: ProjectConfig;
  /** TMB-51: shows the API spike backend option while its flag is on. */
  apiBackendEnabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    updateProjectConfigAction.bind(null, projectId),
    initialState,
  );
  const [secondary, setSecondary] = useState(
    config.backends.secondary?.cli ?? "",
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor="primary_cli"
            className="mb-1 block text-sm font-medium"
          >
            Primäres Backend (Agent-CLI)
          </label>
          <select
            id="primary_cli"
            name="primary_cli"
            defaultValue={config.backends.primary.cli}
            className={inputClass}
          >
            <option value="claude">claude (Modellfamilie anthropic)</option>
            <option value="codex">codex (Modellfamilie openai)</option>
            <option value="mock">
              mock – Demo-Backend (keine echte Prüfung)
            </option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Das Demo-Backend liefert vorgefertigte Ergebnisse ohne installierte
            CLI. Als primäres Backend gewählt, gilt das Projekt als Demo-Projekt
            und wird überall so gekennzeichnet.
          </p>
        </div>
        <div>
          <label
            htmlFor="secondary_cli"
            className="mb-1 block text-sm font-medium"
          >
            Sekundäres Backend (Divergenzregel)
          </label>
          <select
            id="secondary_cli"
            name="secondary_cli"
            value={secondary}
            onChange={(event) => setSecondary(event.target.value)}
            className={inputClass}
          >
            <option value="">– keins (Divergenzregel deaktiviert) –</option>
            <option value="claude">claude (Modellfamilie anthropic)</option>
            <option value="codex">codex (Modellfamilie openai)</option>
            {apiBackendEnabled ? (
              <option value="anthropic-api">
                anthropic-api (Spike, Modellfamilie anthropic)
              </option>
            ) : null}
            <option value="mock">mock (Demo, Modellfamilie mock)</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Muss eine andere Modellfamilie als das primäre Backend sein.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label
            htmlFor="adjudication_sample_rate"
            className="mb-1 block text-sm font-medium"
          >
            Stichprobenrate
          </label>
          <input
            id="adjudication_sample_rate"
            name="adjudication_sample_rate"
            type="number"
            step="0.01"
            min="0"
            max="1"
            required
            defaultValue={config.adjudication_sample_rate}
            className={inputClass}
          />
        </div>
        <div>
          <label
            htmlFor="max_repair_cycles"
            className="mb-1 block text-sm font-medium"
          >
            Max. Reparaturzyklen
          </label>
          <input
            id="max_repair_cycles"
            name="max_repair_cycles"
            type="number"
            step="1"
            min="1"
            required
            defaultValue={config.max_repair_cycles ?? 2}
            className={inputClass}
          />
        </div>
        <div>
          <label
            htmlFor="rubric_version"
            className="mb-1 block text-sm font-medium"
          >
            Version des Bewertungsschemas
          </label>
          <input
            id="rubric_version"
            name="rubric_version"
            required
            defaultValue={config.rubric_version}
            className={`${inputClass} font-mono`}
          />
        </div>
      </div>

      {secondary !== "" ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="confidence_threshold"
              className="mb-1 block text-sm font-medium"
            >
              Sicherheits-Schwellenwert für ein zweites Urteil
            </label>
            <input
              id="confidence_threshold"
              name="confidence_threshold"
              type="number"
              step="0.01"
              min="0"
              max="1"
              defaultValue={config.second_opinion?.confidence_threshold ?? 0.8}
              className={inputClass}
            />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <input
              id="on_relation_not_supports"
              name="on_relation_not_supports"
              type="checkbox"
              defaultChecked={
                config.second_opinion?.on_relation_not_supports ?? true
              }
            />
            <label htmlFor="on_relation_not_supports" className="text-sm">
              Zweiturteil auch bei Erst-Relation ungleich „stützt“
            </label>
          </div>
        </div>
      ) : null}

      <ErrorBanner message={state.error} />
      {state.changedFields !== undefined ? (
        state.changedFields.length === 0 ? (
          <SuccessBanner>
            Keine Änderung – die Konfiguration entspricht bereits den
            eingegebenen Werten.
          </SuccessBanner>
        ) : (
          <SuccessBanner>
            Konfiguration geändert ({state.changedFields.join("; ")}) – als
            Projektereignis im Verlauf protokolliert.
          </SuccessBanner>
        )
      ) : null}

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Wird gespeichert …" : "Konfiguration speichern"}
      </button>
    </form>
  );
}

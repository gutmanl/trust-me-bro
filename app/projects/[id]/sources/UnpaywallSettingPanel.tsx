"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type { UnpaywallSetting } from "@/lib/pipeline";
import type { UnpaywallFormState } from "./reference-scan-actions";
import { setUnpaywallEmailAction } from "./reference-scan-actions";

const initialState: UnpaywallFormState = { error: null };

/**
 * Inline Unpaywall e-mail form of the reference-import panel (reference
 * auto-import, Amendment 2). Installation-level setting, not per-project —
 * saving/clearing never triggers a scan, it just re-renders with the
 * address active. Env-provided values are read-only here; the write
 * use-case also refuses them outright (setUnpaywallEmail), this is only the
 * UI-side reflection of that rule.
 */
export function UnpaywallSettingPanel({
  projectId,
  setting,
}: {
  projectId: string;
  setting: UnpaywallSetting;
}) {
  const [state, formAction, pending] = useActionState(
    setUnpaywallEmailAction.bind(null, projectId),
    initialState,
  );
  const [editing, setEditing] = useState(setting.source === "unset");
  const [lastState, setLastState] = useState(state);

  // Render-phase state adjustment (not an effect): a successful save/clear
  // collapses the form back to the status line (or, for a clear, the fresh
  // "unset" branch below takes over regardless of this flag).
  if (state !== lastState) {
    setLastState(state);
    if (state.error === null) {
      setEditing(false);
    }
  }

  if (setting.source === "env") {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Unpaywall-Adresse: <span className="font-mono">{setting.email}</span>{" "}
        (über Umgebungsvariable{" "}
        <code className="font-mono">TMB_UNPAYWALL_EMAIL</code> gesetzt – nicht
        über die Oberfläche änderbar).
      </div>
    );
  }

  if (setting.source === "config" && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <span>
          Unpaywall-Adresse: <span className="font-mono">{setting.email}</span>
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-medium text-slate-500 underline decoration-slate-300 hover:text-slate-700"
        >
          Ändern
        </button>
        <form action={formAction}>
          <input type="hidden" name="unpaywall_email" value="" />
          <button
            type="submit"
            disabled={pending}
            className="text-xs font-medium text-slate-500 underline decoration-slate-300 hover:text-slate-700"
          >
            Entfernen
          </button>
        </form>
        <ErrorBanner message={state.error} />
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <p className="text-sm font-medium text-slate-700">
        Frei zugängliche PDFs über Unpaywall suchen (optional)
      </p>
      <p className="text-xs text-slate-600">
        Die Adresse wird bei jeder Abfrage als Pflichtangabe an Unpaywall
        übermittelt. Sie wird ausschließlich lokal in{" "}
        <code className="font-mono">~/.trustmebro/config.json</code> gespeichert
        und ist nie Teil eines Projekts oder Exports. Ohne Angabe funktioniert
        der Scan unverändert – der Unpaywall-Schritt wird dann einfach
        übersprungen.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          name="unpaywall_email"
          defaultValue={
            setting.source === "config" ? (setting.email ?? "") : ""
          }
          placeholder="name@beispiel.org"
          className={`${inputClass} max-w-xs`}
        />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Wird gespeichert …" : "Adresse speichern"}
        </button>
        {setting.source === "config" ? (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs font-medium text-slate-500 underline decoration-slate-300 hover:text-slate-700"
          >
            Abbrechen
          </button>
        ) : null}
      </div>
      <ErrorBanner message={state.error} />
    </form>
  );
}

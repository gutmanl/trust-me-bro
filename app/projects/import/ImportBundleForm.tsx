"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  fileInputClass,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type { ImportBundleFormState } from "./actions";
import { importBundleAction } from "./actions";

const initialState: ImportBundleFormState = { error: null };

/** Suggests the workspace name from the export filename pattern
 * `trustmebro-export_<projekt>_<zeitstempel>.tmb`; the server-side
 * verification stays authoritative regardless of what is entered. */
function suggestName(filename: string): string | undefined {
  const match = /^trustmebro-export_(.+)_\d{8}T\d+Z\.tmb$/.exec(filename);
  return match?.[1];
}

export function ImportBundleForm() {
  const [state, formAction, pending] = useActionState(
    importBundleAction,
    initialState,
  );
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label htmlFor="file" className="mb-1 block text-sm font-medium">
          Export-Bundle (.tmb)
        </label>
        <input
          id="file"
          name="file"
          type="file"
          required
          accept=".tmb,application/zip"
          className={fileInputClass}
          onChange={(event) => {
            const filename = event.target.files?.[0]?.name;
            if (!nameTouched && filename) {
              setName(suggestName(filename) ?? "");
            }
          }}
        />
        <p className="mt-1 text-xs text-slate-500">
          Vor dem Anlegen werden Manifest-Prüfsummen und Hash-Kette verifiziert;
          ein fehlerhaftes Bundle wird ohne Schreibzugriff abgewiesen.
        </p>
      </div>

      <div>
        <label
          htmlFor="directory_name"
          className="mb-1 block text-sm font-medium"
        >
          Verzeichnisname im Workspace
        </label>
        <input
          id="directory_name"
          name="directory_name"
          required
          value={name}
          onChange={(event) => {
            setNameTouched(true);
            setName(event.target.value);
          }}
          className={inputClass}
          placeholder="z. B. proj_beispiel-2026"
        />
        <p className="mt-1 text-xs text-slate-500">
          Frei wählbar (Kollisionen werden abgewiesen). Die kettengebundene
          Projekt-Id im Register bleibt unverändert – bei abweichendem Namen
          wird sie als Ursprungs-Id angezeigt.
        </p>
      </div>

      {state.error ? <ErrorBanner message={state.error} /> : null}

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Importiere …" : "Bundle importieren"}
      </button>
    </form>
  );
}

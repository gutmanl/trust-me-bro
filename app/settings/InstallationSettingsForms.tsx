"use client";

import { useActionState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
  SuccessBanner,
} from "@/app/components/ui";
import type { UnpaywallSetting } from "@/lib/pipeline";

import {
  updateActorHandleAction,
  updateUnpaywallAction,
  type InstallationSettingsFormState,
} from "./actions";

const initialState: InstallationSettingsFormState = { error: null };

/**
 * The actor handle, changeable after the first run (TMB-54, D6). The copy
 * states plainly that only future entries are affected — for an append-only,
 * hash-chained audit trail that is the correct behaviour, not a limitation
 * to be glossed over.
 */
export function ActorHandleForm({
  setting,
}: {
  setting: { handle: string | null; source: "env" | "config" | "unset" };
}) {
  const [state, formAction, pending] = useActionState(
    updateActorHandleAction,
    initialState,
  );

  if (setting.source === "env") {
    return (
      <p className="text-sm text-slate-500">
        Über die Umgebungsvariable{" "}
        <code className="font-mono">TMB_ACTOR_HANDLE</code> gesetzt:{" "}
        <span className="font-mono">{setting.handle}</span> – nicht über die
        Oberfläche änderbar.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label
          htmlFor="actor_handle"
          className="block text-sm font-medium text-slate-700"
        >
          Akteurskürzel
        </label>
        <p className="mt-1 text-sm text-slate-500">
          Erscheint als <code className="font-mono">human:&lt;handle&gt;</code>{" "}
          in allen künftigen Verlaufseinträgen.{" "}
          <strong>Bereits geschriebene Einträge bleiben unverändert</strong> –
          sie tragen weiterhin das damals gültige Kürzel. Das ist bei einem
          fortschreibenden Protokoll so gewollt und technisch auch nicht anders
          möglich: das Kürzel ist Teil des gehashten Eintrags.
        </p>
        <input
          id="actor_handle"
          name="actor_handle"
          type="text"
          required
          defaultValue={setting.handle ?? ""}
          className={`mt-2 ${inputClass}`}
        />
      </div>
      <ErrorBanner message={state.error} />
      {state.saved !== undefined ? (
        <SuccessBanner>
          Kürzel geändert – künftige Einträge erscheinen als{" "}
          <code className="font-mono">human:{state.saved}</code>.
        </SuccessBanner>
      ) : null}
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Speichere …" : "Kürzel ändern"}
      </button>
    </form>
  );
}

/** The installation's Unpaywall address, with the established
 * read-only-when-provided-by-environment pattern. */
export function UnpaywallForm({ setting }: { setting: UnpaywallSetting }) {
  const [state, formAction, pending] = useActionState(
    updateUnpaywallAction,
    initialState,
  );

  if (setting.source === "env") {
    return (
      <p className="text-sm text-slate-500">
        Über die Umgebungsvariable{" "}
        <code className="font-mono">TMB_UNPAYWALL_EMAIL</code> gesetzt:{" "}
        <span className="font-mono">{setting.email}</span> – nicht über die
        Oberfläche änderbar.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label
          htmlFor="unpaywall_email"
          className="block text-sm font-medium text-slate-700"
        >
          Unpaywall-Adresse
        </label>
        <p className="mt-1 text-sm text-slate-500">
          Wird bei jeder Unpaywall-Abfrage des Referenz-Scans mitgeschickt und
          nur lokal gespeichert. Leer lassen entfernt sie; der Scan überspringt
          diesen Schritt dann.
        </p>
        <input
          id="unpaywall_email"
          name="unpaywall_email"
          type="email"
          defaultValue={setting.email ?? ""}
          placeholder="name@beispiel.org"
          className={`mt-2 ${inputClass}`}
        />
      </div>
      <ErrorBanner message={state.error} />
      {state.saved !== undefined ? (
        <SuccessBanner>
          Unpaywall-Adresse gespeichert: {state.saved}
        </SuccessBanner>
      ) : null}
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Speichere …" : "Adresse speichern"}
      </button>
    </form>
  );
}

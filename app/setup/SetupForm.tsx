"use client";

import { useActionState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";
import type { UnpaywallSetting } from "@/lib/pipeline";

import {
  completeSetupAction,
  createDemoProjectAction,
  saveUnpaywallAction,
  saveWorkspaceAction,
  type SetupFormState,
} from "./actions";

const initialState: SetupFormState = { error: null };

/**
 * Step 1 — the actor handle. The only mandatory step: it is what makes the
 * installation "set up" (D4), so it comes first and everything after it is
 * skippable.
 */
export function HandleStep({ currentHandle }: { currentHandle?: string }) {
  const [state, formAction, pending] = useActionState(
    completeSetupAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="actor_handle"
          className="block text-sm font-medium text-slate-700"
        >
          Akteurskürzel
        </label>
        <p className="mt-1 text-sm text-slate-500">
          Kurzes Kürzel (z.&nbsp;B. Initialen), das als{" "}
          <code className="font-mono">human:&lt;handle&gt;</code> in allen
          Verlaufseinträgen erscheint. Erlaubt: Kleinbuchstaben, Ziffern,
          „_&quot; und „-&quot;.
        </p>
        <input
          id="actor_handle"
          name="actor_handle"
          type="text"
          required
          autoFocus
          defaultValue={currentHandle}
          placeholder="z. B. lg"
          className={`mt-2 ${inputClass}`}
        />
      </div>
      <ErrorBanner message={state.error} />
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Speichere …" : "Weiter"}
      </button>
    </form>
  );
}

/**
 * Step 2 — the workspace directory. Settable during the first run only
 * (D5): moving it once projects exist would leave them behind, and
 * migrating them is out of scope.
 */
export function WorkspaceStep({
  setting,
}: {
  setting: { root: string; source: "env" | "config" | "default" };
}) {
  const [state, formAction, pending] = useActionState(
    saveWorkspaceAction,
    initialState,
  );

  if (setting.source === "env") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Über die Umgebungsvariable{" "}
          <code className="font-mono">TMB_WORKSPACE</code> gesetzt:{" "}
          <span className="font-mono">{setting.root}</span> – nicht über die
          Oberfläche änderbar.
        </p>
        <a href="/setup?step=3" className={primaryButtonClass}>
          Weiter
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="workspace_root"
          className="block text-sm font-medium text-slate-700"
        >
          Arbeitsverzeichnis
        </label>
        <p className="mt-1 text-sm text-slate-500">
          Hier legt die Anwendung ihre Projektordner ab – ein Ordner je Projekt,
          mit Register, Quellen und eingefrorenen Dokumenten.{" "}
          <strong>Nur jetzt änderbar:</strong> ein späterer Wechsel würde
          bereits angelegte Projekte zurücklassen; die Anwendung verschiebt sie
          nicht.
        </p>
        <input
          id="workspace_root"
          name="workspace_root"
          type="text"
          required
          defaultValue={setting.root}
          className={`mt-2 ${inputClass} font-mono`}
        />
      </div>
      <ErrorBanner message={state.error} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Speichere …" : "Übernehmen und weiter"}
        </button>
        <a href="/setup?step=3" className="text-sm text-slate-500 underline">
          Vorschlag behalten
        </a>
      </div>
    </form>
  );
}

/** Step 4 — the optional Unpaywall address. */
export function UnpaywallStep({ setting }: { setting: UnpaywallSetting }) {
  const [state, formAction, pending] = useActionState(
    saveUnpaywallAction,
    initialState,
  );

  if (setting.source === "env") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Über die Umgebungsvariable{" "}
          <code className="font-mono">TMB_UNPAYWALL_EMAIL</code> gesetzt:{" "}
          <span className="font-mono">{setting.email}</span> – nicht über die
          Oberfläche änderbar.
        </p>
        <a href="/setup?step=5" className={primaryButtonClass}>
          Weiter
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="unpaywall_email"
          className="block text-sm font-medium text-slate-700"
        >
          Unpaywall-Adresse (optional)
        </label>
        <p className="mt-1 text-sm text-slate-500">
          Unpaywall verlangt bei jeder Abfrage eine Kontaktadresse. Mit ihr
          findet der Referenz-Scan frei zugängliche Fassungen von Quellen; ohne
          sie überspringt er diesen Schritt und arbeitet unverändert weiter. Die
          Adresse wird ausschließlich lokal gespeichert und ist jederzeit
          nachtragbar.
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
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Speichere …" : "Übernehmen und weiter"}
        </button>
        <a href="/setup?step=5" className="text-sm text-slate-500 underline">
          Überspringen
        </a>
      </div>
    </form>
  );
}

/** The "Beispielprojekt anlegen" action, shared by the final wizard step and
 * the empty project list (D3). */
export function CreateDemoProjectButton({
  label = "Beispielprojekt anlegen",
}: {
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(
    createDemoProjectAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-500 disabled:opacity-50"
      >
        {pending ? "Lege an …" : label}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}

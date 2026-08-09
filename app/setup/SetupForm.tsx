"use client";

import { useActionState } from "react";

import {
  ErrorBanner,
  inputClass,
  primaryButtonClass,
} from "@/app/components/ui";

import { completeSetupAction, type SetupFormState } from "./actions";

const initialState: SetupFormState = { error: null };

export function SetupForm() {
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
          placeholder="z. B. lg"
          className={`mt-2 ${inputClass}`}
        />
      </div>
      <ErrorBanner message={state.error} />
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Speichere …" : "Einrichtung abschließen"}
      </button>
    </form>
  );
}

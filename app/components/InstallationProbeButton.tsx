"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";

import {
  runInstallationProbeAction,
  type InstallationProbeFormState,
} from "./health-actions";

const initialState: InstallationProbeFormState = { error: null };

/** The installation-level stage-3 probe (TMB-54): a button, never
 * automatic — it costs a small share of the CLI's quota. */
export function InstallationProbeButton({ cli }: { cli: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (previous: InstallationProbeFormState, formData: FormData) => {
      const next = await runInstallationProbeAction(cli, previous, formData);
      if (next.error === null) {
        router.refresh();
      }
      return next;
    },
    initialState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-500 disabled:opacity-50"
      >
        {pending ? "Prüfe Anmeldung …" : "Anmeldung prüfen (Testaufruf)"}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}

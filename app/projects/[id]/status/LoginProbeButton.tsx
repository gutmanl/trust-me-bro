"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { ErrorBanner, primaryButtonClass } from "@/app/components/ui";

import { runLoginProbeAction, type LoginProbeFormState } from "./actions";

const initialState: LoginProbeFormState = { error: null };

/** The on-demand stage-3 probe (TMB-49): one real, minimal CLI call that
 * spends a small quota share — therefore a button, never automatic. */
export function LoginProbeButton({
  projectId,
  which,
}: {
  projectId: string;
  which: "primary" | "secondary";
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (previous: LoginProbeFormState, formData: FormData) => {
      const next = await runLoginProbeAction(
        projectId,
        which,
        previous,
        formData,
      );
      if (next.error === null) {
        router.refresh();
      }
      return next;
    },
    initialState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Prüfe Anmeldung …" : "Anmeldung prüfen (Testaufruf)"}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}

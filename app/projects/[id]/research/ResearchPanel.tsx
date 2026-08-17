"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useRunFeed } from "@/app/lib/useRunFeed";
import type { ResearchState } from "@/lib/pipeline";
import { StartBlockedNotice, useStartGate } from "../RunStatusProvider";
import type { ResearchFormState } from "./actions";
import { startResearchAction } from "./actions";

const initialState: ResearchFormState = { error: null };

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Recherchelauf gestartet – das Backend recherchiert zur Forschungsfrage.";
    case "item_started":
      return "Recherche läuft (Agent-CLI arbeitet, das kann einige Minuten dauern) …";
    case "item_completed": {
      const outcome = event.outcome as
        | { status: string; result?: { message?: string }; error?: string }
        | undefined;
      if (outcome?.status === "ok") {
        return outcome.result?.message ?? "Schritt abgeschlossen.";
      }
      return `Schritt fehlgeschlagen: ${outcome?.error ?? "unbekannt"}`;
    }
    case "run_completed":
      return "Lauf beendet.";
    default:
      return null;
  }
}

/**
 * Start button + live progress for the initial research (TMB-55), in the
 * established three-layer shape: the server-rendered parent shows the
 * durable, register-derived state; this panel adds only the volatile
 * in-flight feed and refreshes when the run ends.
 */
export function ResearchPanel({
  projectId,
  state,
}: {
  projectId: string;
  state: ResearchState;
}) {
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(
    startResearchAction.bind(null, projectId),
    initialState,
  );
  const [startedForm, setStartedForm] = useState<ResearchFormState | null>(
    null,
  );
  const [stopped, setStopped] = useState(false);

  // Render-phase state adjustment (not an effect): a new successful action
  // result re-arms the panel for the new run — this is what lets the
  // restart button work again after a failed run without a page reload.
  if (formState.started && startedForm !== formState) {
    setStartedForm(formState);
    setStopped(false);
  }

  const watching =
    !stopped && (formState.started === true || state.status === "running");

  const { lines } = useRunFeed({
    kind: "research",
    active: watching,
    describe: describeProgress,
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  const { blockedBy } = useStartGate("research");
  // `pending` deliberately does NOT belong here. It used to, and the panel
  // then rendered nothing at all between the click and the action's reply:
  // the form had unmounted while `watching` was still false, because that
  // only flips once the action resolves. Keeping the button mounted and
  // disabled — the convention every other start control follows — is what
  // makes the wait for an agent-CLI spawn legible instead of a dead click.
  const startable =
    !watching &&
    !blockedBy &&
    (state.status === "not_started" ||
      state.status === "interrupted" ||
      state.status === "failed");

  return (
    <div className="space-y-4">
      {blockedBy && !watching ? <StartBlockedNotice label={blockedBy} /> : null}
      {startable ? (
        <form action={formAction}>
          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClass}
          >
            {pending
              ? "Wird gestartet …"
              : state.status === "not_started"
                ? "Recherche starten"
                : "Recherche erneut starten"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />

      {watching ? (
        <RunProgressFeed title="Fortschritt des Recherchelaufs" lines={lines} />
      ) : null}
    </div>
  );
}

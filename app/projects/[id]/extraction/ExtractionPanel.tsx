"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useJobStream } from "@/app/lib/useJobStream";
import type { ExtractionState } from "@/lib/pipeline";
import type { ExtractionFormState } from "./actions";
import { startExtractionAction } from "./actions";

const initialState: ExtractionFormState = { error: null };

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Extraktionslauf gestartet – das Backend liest das eingefrorene Briefing.";
    case "item_started":
      return "Claim-Extraktion läuft (Agent-CLI arbeitet, das kann einige Minuten dauern) …";
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
 * Start button + live progress via the shared SSE hook. The server-rendered
 * parent shows the durable state (register-derived); this panel only adds
 * the volatile in-flight feed and refreshes the page when the run ends.
 * `watching` deliberately resets on run end so a failed run's restart
 * button reappears without a manual page reload.
 */
export function ExtractionPanel({
  projectId,
  state,
}: {
  projectId: string;
  state: ExtractionState;
}) {
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(
    startExtractionAction.bind(null, projectId),
    initialState,
  );
  const [startedForm, setStartedForm] = useState<ExtractionFormState | null>(
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

  const { lines } = useJobStream({
    streamUrl: `/api/projects/${projectId}/extraction/stream`,
    active: watching,
    describe: describeProgress,
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  const canStart =
    !pending &&
    !watching &&
    (state.status === "not_started" ||
      state.status === "interrupted" ||
      state.status === "failed");

  return (
    <div className="space-y-4">
      {canStart ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {state.status === "not_started"
              ? "Claim-Extraktion starten"
              : "Claim-Extraktion erneut starten"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />

      {watching ? (
        <RunProgressFeed
          title="Fortschritt des Extraktionslaufs"
          lines={lines}
        />
      ) : null}
    </div>
  );
}

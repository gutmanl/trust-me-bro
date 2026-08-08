"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useJobStream } from "@/app/lib/useJobStream";
import type { VerificationState } from "@/lib/pipeline";
import type { VerificationFormState } from "./actions";
import { startVerificationAction } from "./actions";

const initialState: VerificationFormState = { error: null };

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Prüflauf gestartet – jeder Claim durchläuft die fälligen Prüfstufen.";
    case "item_started":
      return event.itemId === "__stichprobe__"
        ? "Stichprobenzug über die automatisch bestätigten Claims …"
        : `Prüfe ${String(event.itemId)} (Existenz → Attribution → Kalibrierung) …`;
    case "item_completed": {
      const outcome = event.outcome as
        | { status: string; result?: { message?: string }; error?: string }
        | undefined;
      if (outcome?.status === "ok") {
        return outcome.result?.message ?? "Claim geprüft.";
      }
      return `Claim-Prüfung fehlgeschlagen: ${outcome?.error ?? "unbekannt"}`;
    }
    case "run_completed":
      return "Prüflauf beendet.";
    default:
      return null;
  }
}

/**
 * Start button + live progress via the shared SSE hook, the verification
 * twin of ExtractionPanel: durable state renders server-side, this panel
 * adds the volatile per-claim feed and refreshes on run end.
 */
export function VerificationPanel({
  projectId,
  state,
}: {
  projectId: string;
  state: VerificationState;
}) {
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(
    startVerificationAction.bind(null, projectId),
    initialState,
  );
  const [startedForm, setStartedForm] = useState<VerificationFormState | null>(
    null,
  );
  const [stopped, setStopped] = useState(false);

  // Render-phase state adjustment (not an effect): a new successful action
  // result re-arms the panel for the new run.
  if (formState.started && startedForm !== formState) {
    setStartedForm(formState);
    setStopped(false);
  }

  const watching =
    !stopped && (formState.started === true || state.status === "laeuft");

  const { lines } = useJobStream({
    streamUrl: `/api/projects/${projectId}/verification/stream`,
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
    (state.openClaims > 0 || state.status === "unterbrochen");

  return (
    <div className="space-y-4">
      {canStart ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {state.status === "nicht_gestartet"
              ? "Prüfung starten"
              : state.openClaims > 0
                ? `Prüfung fortsetzen (${state.openClaims} Claim(s) offen)`
                : "Prüflauf abschließen (Stichprobenzug nachholen)"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />

      {watching ? (
        <RunProgressFeed title="Fortschritt des Prüflaufs" lines={lines} />
      ) : null}
    </div>
  );
}

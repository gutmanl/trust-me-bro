"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ConnectionLostNotice,
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import {
  RunControls,
  type RunControlPhase,
} from "@/app/components/RunControls";
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
      return event.itemId === "__spot_check__"
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
    case "run_pause_requested":
      return "Pause angefordert – der laufende Claim wird noch abgeschlossen …";
    case "run_paused":
      return "Lauf pausiert. Fortsetzen startet beim nächsten offenen Claim.";
    case "run_resumed":
      return "Lauf fortgesetzt.";
    case "run_cancel_requested":
      return "Abbruch angefordert – der laufende Claim wird noch abgeschlossen …";
    case "run_cancelled":
      return "Lauf abgebrochen – alle abgeschlossenen Claims bleiben erhalten.";
    case "run_completed":
      return "Prüflauf beendet.";
    default:
      return null;
  }
}

function phaseForEvent(event: Record<string, unknown>): RunControlPhase | null {
  switch (event.type) {
    case "run_started":
    case "run_resumed":
      return "running";
    case "run_pause_requested":
      return "pausing";
    case "run_paused":
      return "paused";
    case "run_cancel_requested":
      return "cancelling";
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
  blockedReason,
}: {
  projectId: string;
  state: VerificationState;
  /** A German reason the run cannot start yet (no claims extracted),
   * computed server-side so the absence of a button is explained. */
  blockedReason?: string | null;
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
  const [phase, setPhase] = useState<RunControlPhase>("running");
  const [checked, setChecked] = useState(0);

  // Render-phase state adjustment (not an effect): a new successful action
  // result re-arms the panel for the new run.
  if (formState.started && startedForm !== formState) {
    setStartedForm(formState);
    setStopped(false);
    setChecked(0);
  }

  const watching =
    !stopped && (formState.started === true || state.status === "running");

  const { lines, connectionLost } = useJobStream({
    streamUrl: `/api/projects/${projectId}/verification/stream`,
    active: watching,
    describe: describeProgress,
    onEvent: (event) => {
      const nextPhase = phaseForEvent(event);
      if (nextPhase !== null) {
        setPhase(nextPhase);
      }
      if (
        event.type === "item_completed" &&
        event.itemId !== "__spot_check__"
      ) {
        setChecked((count) => count + 1);
      }
    },
    onDone: () => {
      setStopped(true);
      setPhase("running");
      router.refresh();
    },
  });

  const startable =
    !pending &&
    !watching &&
    (state.openClaims > 0 || state.status === "interrupted");

  return (
    <div className="space-y-4">
      {blockedReason ? (
        <div>
          <button type="button" disabled className={primaryButtonClass}>
            Prüfung starten
          </button>
          <p className="mt-1 text-sm text-amber-700">{blockedReason}</p>
        </div>
      ) : startable ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {state.status === "not_started"
              ? "Prüfung starten"
              : state.openClaims > 0
                ? `Prüfung fortsetzen (${state.openClaims} Claim(s) offen)`
                : "Prüflauf abschließen (Stichprobenzug nachholen)"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />
      {connectionLost ? <ConnectionLostNotice /> : null}

      {watching ? (
        <>
          <RunControls
            projectId={projectId}
            kind="verification"
            phase={phase}
          />
          <RunProgressFeed
            title="Fortschritt des Prüflaufs"
            subtitle={
              state.openClaims > 0
                ? `${Math.min(checked, state.openClaims)} von ${state.openClaims} Claim(s) geprüft`
                : undefined
            }
            lines={lines}
          />
        </>
      ) : null}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ConnectionLostNotice,
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useRunFeed } from "@/app/lib/useRunFeed";
import type { VerificationState } from "@/lib/pipeline";
import { StartBlockedNotice, useStartGate } from "../RunStatusProvider";
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

  const { lines, connectionLost } = useRunFeed({
    kind: "verification",
    active: watching,
    describe: describeProgress,
    onEvent: (event) => {
      if (
        event.type === "item_completed" &&
        event.itemId !== "__spot_check__"
      ) {
        // Absolute from the event's 0-based index, never an increment: the
        // shared stream replays a run's events on (re)connect, and
        // incrementing would count every replayed claim a second time. The
        // spot-check pseudo-item trails the claims, so for a real claim the
        // index still counts claims.
        setChecked((count) => Math.max(count, (Number(event.index) || 0) + 1));
      }
    },
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  const { blockedBy } = useStartGate("verification");
  const startable =
    !pending &&
    !watching &&
    !blockedBy &&
    (state.openClaims > 0 || state.status === "interrupted");

  return (
    <div className="space-y-4">
      {blockedBy && !watching && !blockedReason ? (
        <StartBlockedNotice label={blockedBy} />
      ) : null}
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
      {watching && connectionLost ? <ConnectionLostNotice /> : null}

      {watching ? (
        <RunProgressFeed
          title="Fortschritt des Prüflaufs"
          subtitle={
            state.openClaims > 0
              ? `${Math.min(checked, state.openClaims)} von ${state.openClaims} Claim(s) geprüft`
              : undefined
          }
          lines={lines}
        />
      ) : null}
    </div>
  );
}

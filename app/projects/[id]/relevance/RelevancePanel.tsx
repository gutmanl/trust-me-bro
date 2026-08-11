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
import type { RelevanceState } from "@/lib/pipeline";
import type { RelevanceFormState } from "./actions";
import { startRelevanceAction } from "./actions";

const initialState: RelevanceFormState = { error: null };

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Einschlägigkeitsprüfung gestartet – übernommene Claims werden gegen die neue Frage bewertet.";
    case "item_started":
      return `Claim ${String(event.itemId ?? "")} wird bewertet …`;
    case "item_completed": {
      const outcome = event.outcome as
        | { status: string; result?: { message?: string }; error?: string }
        | undefined;
      if (outcome?.status === "ok") {
        return outcome.result?.message ?? "Schritt abgeschlossen.";
      }
      return `Schritt fehlgeschlagen: ${outcome?.error ?? "unbekannt"}`;
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
      return "Lauf beendet.";
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

/** Start button + live progress, structurally the ExtractionPanel. */
export function RelevancePanel({
  projectId,
  state,
}: {
  projectId: string;
  state: RelevanceState;
}) {
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(
    startRelevanceAction.bind(null, projectId),
    initialState,
  );
  const [startedForm, setStartedForm] = useState<RelevanceFormState | null>(
    null,
  );
  const [stopped, setStopped] = useState(false);
  const [phase, setPhase] = useState<RunControlPhase>("running");

  // Render-phase state adjustment (not an effect): a new successful action
  // result re-arms the panel for the new run.
  if (formState.started && startedForm !== formState) {
    setStartedForm(formState);
    setStopped(false);
  }

  const watching =
    !stopped && (formState.started === true || state.status === "running");

  const { lines, connectionLost } = useJobStream({
    streamUrl: `/api/projects/${projectId}/relevance/stream`,
    active: watching,
    describe: describeProgress,
    onEvent: (event) => {
      const nextPhase = phaseForEvent(event);
      if (nextPhase !== null) {
        setPhase(nextPhase);
      }
    },
    onDone: () => {
      setStopped(true);
      setPhase("running");
      router.refresh();
    },
  });

  const canStart =
    !pending &&
    !watching &&
    (state.status === "not_started" ||
      state.status === "interrupted" ||
      state.status === "halted");

  return (
    <div className="space-y-4">
      {canStart ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {state.status === "not_started"
              ? "Einschlägigkeitsprüfung starten"
              : "Einschlägigkeitsprüfung fortsetzen"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />
      {connectionLost ? <ConnectionLostNotice /> : null}

      {watching ? (
        <>
          <RunControls projectId={projectId} kind="relevance" phase={phase} />
          <RunProgressFeed
            title="Fortschritt der Einschlägigkeitsprüfung"
            lines={lines}
          />
        </>
      ) : null}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
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
    case "run_completed":
      return "Lauf beendet.";
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

  // Render-phase state adjustment (not an effect): a new successful action
  // result re-arms the panel for the new run.
  if (formState.started && startedForm !== formState) {
    setStartedForm(formState);
    setStopped(false);
  }

  const watching =
    !stopped && (formState.started === true || state.status === "laeuft");

  const { lines } = useJobStream({
    streamUrl: `/api/projects/${projectId}/relevance/stream`,
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
    (state.status === "nicht_gestartet" ||
      state.status === "unterbrochen" ||
      state.status === "angehalten");

  return (
    <div className="space-y-4">
      {canStart ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {state.status === "nicht_gestartet"
              ? "Einschlägigkeitsprüfung starten"
              : "Einschlägigkeitsprüfung fortsetzen"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />

      {watching ? (
        <RunProgressFeed
          title="Fortschritt der Einschlägigkeitsprüfung"
          lines={lines}
        />
      ) : null}
    </div>
  );
}

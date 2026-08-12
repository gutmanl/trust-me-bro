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
import type { ExtractionActivity } from "@/lib/pipeline";
import { StartBlockedNotice, useStartGate } from "../RunStatusProvider";
import type { ExtractionFormState } from "./actions";
import { startExtractionAction } from "./actions";

const initialState: ExtractionFormState = { error: null };

const START_LABEL = "Nachweislose Aussagen suchen";

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Extraktionslauf gestartet – das Backend liest das Briefing.";
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
  activity,
  blockedReason,
}: {
  projectId: string;
  activity: ExtractionActivity;
  /** A German reason the run cannot start yet (briefing not imported),
   * computed server-side so the button is disabled with an explanation
   * instead of failing only on submit. */
  blockedReason?: string | null;
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

  const watching = !stopped && (formState.started === true || activity.running);

  const { lines, connectionLost } = useRunFeed({
    kind: "extraction",
    active: watching,
    describe: describeProgress,
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  const { blockedBy } = useStartGate("extraction");
  // No once-per-project gate anymore: the sweep may be repeated whenever the
  // briefing or the source set moved on — the pass dedupes in its commit
  // transaction, so a repeat is safe rather than duplicating claims.
  const startable = !pending && !watching && !blockedBy;

  return (
    <div className="space-y-4">
      {blockedBy && !watching && !blockedReason ? (
        <StartBlockedNotice label={blockedBy} />
      ) : null}
      {blockedReason && !watching ? (
        <div>
          <button type="button" disabled className={primaryButtonClass}>
            {START_LABEL}
          </button>
          <p className="mt-1 text-sm text-amber-700">{blockedReason}</p>
        </div>
      ) : startable ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {START_LABEL}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />
      {watching && connectionLost ? <ConnectionLostNotice /> : null}

      {watching ? (
        <RunProgressFeed
          title="Fortschritt des Extraktionslaufs"
          lines={lines}
        />
      ) : null}
    </div>
  );
}

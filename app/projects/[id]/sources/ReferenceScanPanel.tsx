"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  ErrorBanner,
  primaryButtonClass,
  RunProgressFeed,
} from "@/app/components/ui";
import { useJobStream } from "@/app/lib/useJobStream";
import type { ReferenceScanState } from "@/lib/pipeline";
import type { ReferenceScanFormState } from "./reference-scan-actions";
import { startReferenceScanAction } from "./reference-scan-actions";

const initialState: ReferenceScanFormState = { error: null };

function describeProgress(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "run_started":
      return "Referenz-Scan gestartet – das eingefrorene Briefing wird durchsucht.";
    case "item_started":
      return "Wird gescannt …";
    case "item_completed": {
      const outcome = event.outcome as
        | { status: string; result?: { message?: string }; error?: string }
        | undefined;
      if (outcome?.status === "ok") {
        return outcome.result?.message ?? "Scan abgeschlossen.";
      }
      return `Fehlgeschlagen: ${outcome?.error ?? "unbekannt"}`;
    }
    case "run_completed":
      return "Lauf beendet.";
    default:
      return null;
  }
}

/**
 * Start/restart button + live progress via the shared SSE hook, the
 * reference-scan twin of ExtractionPanel. Deliberately no RunControls
 * wiring (not built for this run kind) and no "already scanned" gate — a
 * rescan is expected and always allowed while nothing is currently running.
 */
export function ReferenceScanPanel({
  projectId,
  state,
  llmAvailable,
}: {
  projectId: string;
  state: ReferenceScanState;
  llmAvailable: boolean;
}) {
  const router = useRouter();
  const [formState, formAction, pending] = useActionState(
    startReferenceScanAction.bind(null, projectId),
    initialState,
  );
  const [startedForm, setStartedForm] = useState<ReferenceScanFormState | null>(
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
    !stopped && (formState.started === true || state.status === "running");

  const { lines } = useJobStream({
    streamUrl: `/api/projects/${projectId}/reference-scan/stream`,
    active: watching,
    describe: describeProgress,
    onDone: () => {
      setStopped(true);
      router.refresh();
    },
  });

  return (
    <div className="space-y-4">
      {!llmAvailable ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Fließtext-Erkennung (LLM) derzeit nicht verfügbar – primäres Backend
          nicht angemeldet. Die regelbasierte Erkennung (DOI/arXiv/URL)
          funktioniert unabhängig davon.
        </div>
      ) : null}

      {!watching ? (
        <form action={formAction}>
          <button
            type="submit"
            disabled={pending}
            className={primaryButtonClass}
          >
            {pending
              ? "Wird gescannt …"
              : state.status === "not_started"
                ? "Referenzen scannen"
                : "Erneut scannen"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />

      {watching ? (
        <RunProgressFeed title="Fortschritt des Referenz-Scans" lines={lines} />
      ) : null}
    </div>
  );
}

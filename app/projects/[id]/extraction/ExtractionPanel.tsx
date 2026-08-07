"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { ErrorBanner, primaryButtonClass } from "@/app/components/ui";
import type { ExtractionState } from "@/lib/pipeline";
import type { ExtractionFormState } from "./actions";
import { startExtractionAction } from "./actions";

const initialState: ExtractionFormState = { error: null };

interface ProgressLine {
  key: number;
  text: string;
}

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
 * Start button + live progress via the SSE stream. The server-rendered
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
  const [lines, setLines] = useState<ProgressLine[]>([]);
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
    setLines([]);
  }

  const watching =
    !stopped && (formState.started === true || state.status === "laeuft");

  useEffect(() => {
    if (!watching) {
      return;
    }
    const source = new EventSource(
      `/api/projects/${projectId}/extraction/stream`,
    );
    let counter = 0;
    const stop = (): void => {
      source.close();
      setStopped(true);
      router.refresh();
    };
    source.addEventListener("progress", (event) => {
      const parsed = JSON.parse((event as MessageEvent).data) as Record<
        string,
        unknown
      >;
      const text = describeProgress(parsed);
      if (text) {
        counter += 1;
        const line = { key: counter, text };
        setLines((previous) => [...previous, line]);
      }
      if (parsed.type === "run_completed") {
        stop();
      }
    });
    source.addEventListener("state", () => {
      // No live run (e.g. page reload after completion): the server-rendered
      // state is already current; just stop streaming.
      stop();
    });
    source.onerror = () => {
      source.close();
    };
    return () => {
      source.close();
    };
  }, [watching, projectId, router]);

  const canStart =
    !pending &&
    !watching &&
    (state.status === "nicht_gestartet" ||
      state.status === "unterbrochen" ||
      state.status === "fehlgeschlagen");

  return (
    <div className="space-y-4">
      {canStart ? (
        <form action={formAction}>
          <button type="submit" className={primaryButtonClass}>
            {state.status === "nicht_gestartet"
              ? "Claim-Extraktion starten"
              : "Claim-Extraktion erneut starten"}
          </button>
        </form>
      ) : null}

      <ErrorBanner message={formState.error} />

      {watching ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-700">
            Fortschritt des Extraktionslaufs
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-slate-600">
            {lines.length === 0 ? <li>Verbinde …</li> : null}
            {lines.map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

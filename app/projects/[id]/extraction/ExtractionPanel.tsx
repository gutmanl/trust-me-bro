"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

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
  const streaming = formState.started === true || state.status === "laeuft";

  useEffect(() => {
    if (!streaming) {
      return;
    }
    const source = new EventSource(
      `/api/projects/${projectId}/extraction/stream`,
    );
    let counter = 0;
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
        source.close();
        router.refresh();
      }
    });
    source.addEventListener("state", () => {
      // No live run (e.g. page reload after completion): the server-rendered
      // state is already current; just stop streaming.
      source.close();
      router.refresh();
    });
    source.onerror = () => {
      source.close();
    };
    return () => {
      source.close();
    };
  }, [streaming, projectId, router]);

  const canStart =
    !pending &&
    !streaming &&
    (state.status === "nicht_gestartet" ||
      state.status === "unterbrochen" ||
      state.status === "fehlgeschlagen");

  return (
    <div className="space-y-4">
      {canStart ? (
        <form action={formAction}>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {state.status === "nicht_gestartet"
              ? "Claim-Extraktion starten"
              : "Claim-Extraktion erneut starten"}
          </button>
        </form>
      ) : null}

      {formState.error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {formState.error}
        </p>
      ) : null}

      {streaming ? (
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

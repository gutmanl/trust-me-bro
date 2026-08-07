"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { ErrorBanner, primaryButtonClass } from "@/app/components/ui";
import type { VerificationState } from "@/lib/pipeline";
import type { VerificationFormState } from "./actions";
import { startVerificationAction } from "./actions";

const initialState: VerificationFormState = { error: null };

interface ProgressLine {
  key: number;
  text: string;
}

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
 * Start button + live progress via the SSE stream, the verification twin of
 * ExtractionPanel: durable state renders server-side, this panel adds the
 * volatile per-claim feed (n/m via item events) and refreshes on run end.
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
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [startedForm, setStartedForm] = useState<VerificationFormState | null>(
    null,
  );
  const [stopped, setStopped] = useState(false);

  // Render-phase state adjustment (not an effect): a new successful action
  // result re-arms the panel for the new run.
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
      `/api/projects/${projectId}/verification/stream`,
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
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-700">
            Fortschritt des Prüflaufs
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

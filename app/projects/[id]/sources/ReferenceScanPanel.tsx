"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type { ReferenceScanState } from "@/lib/pipeline";
import { useRunStatus } from "../RunStatusProvider";
import type { ReferenceScanFormState } from "./reference-scan-actions";
import { startReferenceScanAction } from "./reference-scan-actions";

const initialState: ReferenceScanFormState = { error: null };

/**
 * Compact scan control for the sources-list header (source work items — the
 * old standalone panel with its own progress feed is gone): starting is one
 * click, progress shows in the shared run bar and the header's chain chip,
 * and the resulting candidates appear as rows of the unified list. No
 * "already scanned" gate — a rescan is expected and always allowed while
 * nothing else is running.
 */
export function ReferenceScanButton({
  projectId,
  state,
}: {
  projectId: string;
  state: ReferenceScanState;
}) {
  const [formState, formAction, pending] = useActionState(
    startReferenceScanAction.bind(null, projectId),
    initialState,
  );
  // Any active run blocks the start (single writer); the button stays
  // visible but disabled, with the reason in its tooltip — a header control
  // has no room for the usual StartBlockedNotice.
  const activeRun = useRunStatus();
  const blocked = activeRun !== null;

  return (
    <form action={formAction} className="contents">
      <button
        type="submit"
        disabled={pending || blocked}
        title={
          blocked
            ? "Pro Projekt kann nur ein Lauf gleichzeitig laufen – bitte abwarten."
            : "Durchsucht das eingefrorene Briefing nach zitierten Quellen."
        }
        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        {pending
          ? "Wird gestartet …"
          : state.status === "not_started"
            ? "Referenzen scannen"
            : "Erneut scannen"}
      </button>
      <ErrorBanner message={formState.error} />
    </form>
  );
}

/** The scan's durable caveats, shown with the import details below the
 * list: LLM channel currently unavailable, and/or the last committed scan
 * ran regex-only (I2 fix — derived from the DURABLE pointer, not the live
 * health probe, so a degraded scan stays distinguishable from a complete
 * one once the run is over). */
export function ReferenceScanNotices({
  state,
  llmAvailable,
  lastScanMethod,
}: {
  state: ReferenceScanState;
  llmAvailable: boolean;
  lastScanMethod?: "regex" | "regex+llm";
}) {
  return (
    <>
      {!llmAvailable ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Fließtext-Erkennung (KI) derzeit nicht verfügbar – primäres Backend
          nicht angemeldet. Die regelbasierte Erkennung (DOI/arXiv/URL und
          Markdown-Fußnoten <code>[^n]:</code>) funktioniert unabhängig davon.
        </div>
      ) : null}
      {lastScanMethod === "regex" ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-medium">
            Fließtext-Erkennung im letzten Scan übersprungen
          </p>
          <p className="mt-1">
            Nur DOI/arXiv/URL und Markdown-Fußnoten wurden regelbasiert erkannt.
            {state.reason ? ` ${state.reason}` : ""} Ein erneuter Scan versucht
            die Fließtext-Erkennung erneut.
          </p>
        </div>
      ) : null}
    </>
  );
}

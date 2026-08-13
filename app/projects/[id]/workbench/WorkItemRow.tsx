"use client";

import { useActionState } from "react";

import { ErrorBanner } from "@/app/components/ui";
import type { SourceWorkItemVM } from "@/lib/pipeline";
import { formatTimestamp } from "../../status-labels";
import type { RetryCaptureState } from "../sources/actions";
import { dismissCaptureAction, retryCaptureAction } from "../sources/actions";

const initialRetryState: RetryCaptureState = { error: null };

const ORIGIN_LABELS: Record<SourceWorkItemVM["origin"], string> = {
  manual: "manuell erfasst",
  reference_import: "aus dem Referenz-Import",
};

/** Shared status pieces of the unified list's rows — one definition, so a
 * capture work item and a candidate mid-capture can never drift apart. */
export function CapturingChip() {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
      Wird erfasst …
    </span>
  );
}

export function QueuedChip() {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
      Wartet in der Warteschlange
    </span>
  );
}

export function FailureBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
      {children}
    </div>
  );
}

/**
 * One not-yet-successful capture work item in the sources list (source work
 * items): queued, capturing, or durably failed. A successful item never
 * renders here — it becomes an ordinary source row. `liveCapturing` comes
 * from the shared stream and covers the window between item_started and the
 * next server render, where the server-derived status still says "queued".
 */
export function WorkItemRow({
  projectId,
  item,
  liveCapturing,
}: {
  projectId: string;
  item: SourceWorkItemVM;
  liveCapturing: boolean;
}) {
  const capturing = item.status === "capturing" || liveCapturing;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-slate-800">{item.label}</p>
        {capturing ? (
          <CapturingChip />
        ) : item.status === "queued" ? (
          <QueuedChip />
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
            Erfassung fehlgeschlagen
          </span>
        )}
        <span className="text-xs text-slate-500">
          {ORIGIN_LABELS[item.origin]}
        </span>
      </div>

      {!capturing && item.status === "failed" ? (
        <FailureBox>
          <p>
            ⚠ {item.error ?? "Unbekannter Fehler."}
            {item.failedAt !== undefined ? (
              <span className="text-amber-700">
                {" "}
                ({formatTimestamp(item.failedAt)})
              </span>
            ) : null}
          </p>
          {item.origin === "manual" ? null : (
            <p className="mt-1 text-amber-700">
              Der zugehörige Kandidat ist im aktuellen Scan-Ergebnis nicht mehr
              offen – ein erneuter Referenz-Scan nimmt ihn gegebenenfalls wieder
              auf; alternativ die Quelle oben rechts manuell erfassen.
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {item.origin === "manual" ? (
              <RetryButton projectId={projectId} workItemId={item.workItemId} />
            ) : null}
            <DismissButton projectId={projectId} workItemId={item.workItemId} />
          </div>
        </FailureBox>
      ) : null}
    </li>
  );
}

function RetryButton({
  projectId,
  workItemId,
}: {
  projectId: string;
  workItemId: string;
}) {
  const [state, formAction, pending] = useActionState(
    retryCaptureAction.bind(null, projectId, workItemId),
    initialRetryState,
  );
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
      >
        {pending ? "Wird eingereiht …" : "Erneut versuchen"}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}

/** "Verwerfen" on a failed row (source work items): appends the durable
 * dismissal event — the row disappears, the chain keeps the failure.
 * Shared with the candidate row's failure note. */
export function DismissButton({
  projectId,
  workItemId,
}: {
  projectId: string;
  workItemId: string;
}) {
  const [state, formAction, pending] = useActionState(
    dismissCaptureAction.bind(null, projectId, workItemId),
    initialRetryState,
  );
  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="px-1 py-1 text-xs font-medium text-amber-800 underline decoration-amber-300 hover:text-amber-950 disabled:opacity-50"
      >
        {pending ? "Wird verworfen …" : "Verwerfen"}
      </button>
      <ErrorBanner message={state.error} />
    </form>
  );
}

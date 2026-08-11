"use client";

import Link from "next/link";

/**
 * Route-level error boundary (finding 4): any exception that is not a
 * PipelineError — the ones the action funnel turns into form state — reaches
 * here instead of Next's default English crash page. German copy, a retry
 * that re-runs the failed render, and a way back to the project list.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="space-y-4 rounded-md border border-red-200 bg-red-50 p-8 text-center">
      <h1 className="text-2xl font-semibold text-red-800">
        Etwas ist schiefgelaufen
      </h1>
      <p className="text-sm text-red-700">
        Ein unerwarteter Fehler ist aufgetreten und der Vorgang wurde nicht
        abgeschlossen. Die gespeicherten Projektdaten sind davon nicht
        betroffen.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Erneut versuchen
        </button>
        <Link
          href="/projects"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-500"
        >
          Zur Projektliste
        </Link>
      </div>
    </div>
  );
}

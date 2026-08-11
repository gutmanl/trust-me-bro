"use client";

/**
 * Last-resort boundary for an error thrown in the root layout itself, where
 * the ordinary error.tsx (which renders inside the layout) cannot help. It
 * replaces the whole document, so it must supply its own html/body.
 */
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="de">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <main className="mx-auto max-w-5xl px-6 py-8">
          <div className="space-y-4 rounded-md border border-red-200 bg-red-50 p-8 text-center">
            <h1 className="text-2xl font-semibold text-red-800">
              Anwendung nicht verfügbar
            </h1>
            <p className="text-sm text-red-700">
              Ein schwerwiegender Fehler ist aufgetreten. Bitte die Seite neu
              laden.
            </p>
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Neu laden
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}

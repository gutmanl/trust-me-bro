import Link from "next/link";

/** Styled 404 (finding 4): an unknown project id or route lands here — in the
 * app's own shell with a way back — instead of Next's generic page. */
export default function NotFound() {
  return (
    <div className="space-y-4 rounded-md border border-dashed border-slate-300 bg-white p-8 text-center">
      <h1 className="text-2xl font-semibold">Nicht gefunden</h1>
      <p className="text-sm text-slate-500">
        Die angeforderte Seite oder das Projekt existiert nicht (mehr).
      </p>
      <Link
        href="/projects"
        className="inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Zur Projektliste
      </Link>
    </div>
  );
}

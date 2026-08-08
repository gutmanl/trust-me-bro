import Link from "next/link";

/** Shared form/UI primitives — one source for the styling vocabulary the
 * project pages repeat (and TMB-5's adjudication UI will reuse). */

export const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
  "focus:border-slate-500 focus:outline-none";

export const primaryButtonClass =
  "rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white " +
  "hover:bg-slate-700 disabled:opacity-50";

export const fileInputClass =
  "block w-full text-sm text-slate-600 file:mr-3 file:rounded-md " +
  "file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm " +
  "file:font-medium";

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}

export function SuccessBanner({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
      {children}
    </p>
  );
}

/** Progress box of a running job stream (extraction/verification/review). */
export function RunProgressFeed({
  title,
  lines,
}: {
  title: string;
  lines: { key: number; text: string }[];
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <ul className="mt-2 space-y-1 font-mono text-xs text-slate-600">
        {lines.length === 0 ? <li>Verbinde …</li> : null}
        {lines.map((line) => (
          <li key={line.key}>{line.text}</li>
        ))}
      </ul>
    </div>
  );
}

export function SubpageHeader({
  projectId,
  title,
}: {
  projectId: string;
  title: string;
}) {
  return (
    <div>
      <Link
        href={`/projects/${projectId}`}
        className="text-sm text-slate-500 hover:text-slate-700"
      >
        ← Zurück zum Projekt
      </Link>
      <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
    </div>
  );
}

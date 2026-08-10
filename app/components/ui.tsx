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

/** Failure hint of the first failed stage, for banner texts (TMB-49). */
function firstFailureHint(health: {
  stages: readonly { status: string; detail: string; hint?: string }[];
}): string {
  const failed = health.stages.find((stage) => stage.status === "failed");
  return failed?.hint ?? failed?.detail ?? "Backend nicht einsatzbereit.";
}

/**
 * Amber degradation notice above the run panels (TMB-49): marks locked LLM
 * steps and a disabled divergence rule visibly, with the concrete next step
 * and a link to the status page. Renders nothing when all backends are
 * usable.
 */
export function BackendHealthNotice({
  projectId,
  health,
  mode,
}: {
  projectId: string;
  health: {
    primary: {
      cli: string;
      usable: boolean;
      stages: readonly { status: string; detail: string; hint?: string }[];
    };
    secondary?: {
      cli: string;
      usable: boolean;
      stages: readonly { status: string; detail: string; hint?: string }[];
    };
  };
  /** "block": the whole step is LLM-only and refused at start.
   * "verification": only stages 2/3 lock, stage 1 stays usable. */
  mode: "block" | "verification";
}) {
  const messages: string[] = [];
  if (!health.primary.usable) {
    messages.push(
      mode === "verification"
        ? `LLM-Prüfstufen gesperrt – primäres Backend "${health.primary.cli}" ` +
            `nicht einsatzbereit: ${firstFailureHint(health.primary)} ` +
            "Die deterministische Existenzprüfung (Stufe 1) bleibt nutzbar."
        : `Dieser Schritt ist gesperrt – primäres Backend "${health.primary.cli}" ` +
            `nicht einsatzbereit: ${firstFailureHint(health.primary)}`,
    );
  }
  if (
    mode === "verification" &&
    health.primary.usable &&
    health.secondary !== undefined &&
    !health.secondary.usable
  ) {
    messages.push(
      `Divergenzregel deaktiviert – sekundäres Backend "${health.secondary.cli}" ` +
        `nicht einsatzbereit: ${firstFailureHint(health.secondary)}`,
    );
  }
  if (messages.length === 0) {
    return null;
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
      <p className="mt-1">
        <Link
          href={`/projects/${projectId}/status`}
          className="underline decoration-amber-400 hover:decoration-amber-600"
        >
          Zur Statusseite (Einrichtungsdiagnose)
        </Link>
      </p>
    </div>
  );
}

/**
 * Marks a project whose primary backend is the demonstration backend
 * (TMB-54). Its findings are canned, so every view that shows the project
 * says so — the amber vocabulary of BackendHealthNotice, in its compact
 * form. The durable record is the `system:demo_seed` actor in the chained
 * history, which no UI can remove; this badge is the readable half of it.
 */
export function DemoProjectBadge({ title }: { title?: string }) {
  return (
    <span
      title={
        title ??
        "Die Ergebnisse dieses Projekts stammen aus dem Demo-Backend und sind keine echte Verifikation."
      }
      className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
    >
      Demo-Projekt
    </span>
  );
}

/** Full-width version of the badge for a page header: says what the badge
 * only hints at. */
export function DemoProjectNotice() {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      <p>
        <strong>Demo-Projekt.</strong> Das primäre Backend ist das Demo-Backend:
        alle Urteile sind vorgefertigt und keine echte Verifikation. Der Ablauf
        entspricht dem eines regulären Projekts, die Ergebnisse tragen jedoch
        keine Aussagekraft.
      </p>
      <p className="mt-1">
        Die Herkunft steht dauerhaft in der Historie (Akteur{" "}
        <code className="font-mono">system:demo_seed</code>) und bleibt auch im
        Export und unter <code className="font-mono">tmb verify</code> sichtbar.
      </p>
    </div>
  );
}

/**
 * Independence notice (TMB-55). Shown when the briefing was researched by
 * this application with a backend of the same model family as the primary
 * verification backend.
 *
 * Deliberately NOT dismissible: a warning you can click away is worthless
 * in a verification tool. Equally deliberately, it is not an alarm — this
 * is an admissible mode of operation, not a misconfiguration, so it names
 * what is the case and what follows from it, without telling the user to
 * reconfigure anything.
 */
export function IndependenceNotice({ modelFamily }: { modelFamily?: string }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      <p>
        <strong>Briefing und Prüfung aus derselben Modellfamilie</strong>
        {modelFamily ? (
          <>
            {" "}
            (<span className="font-mono">{modelFamily}</span>)
          </>
        ) : null}
        . Das Briefing wurde in dieser Anwendung erzeugt; die Urteile der Stufen
        2 und 3 – Attributionsprüfung und Kalibrierung gegen die Rubrik – sind
        dadurch nicht unabhängig vom Modell, das den Text geschrieben hat.
      </p>
      <p className="mt-1">
        Stufe 1, die Existenzprüfung des zitierten Wortlauts gegen das
        eingefrorene Dokument, ist davon nicht betroffen: sie ist
        deterministisch und modellunabhängig.
      </p>
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

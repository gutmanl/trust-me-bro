import Link from "next/link";

/** Shared form/UI primitives — one source for the styling vocabulary the
 * project pages repeat (and TMB-5's adjudication UI will reuse). */

/**
 * Focus ring shared by every control that suppresses the native outline.
 *
 * The suppression used to stand alone, with a one-pixel border-colour change
 * as its only replacement — effectively no visible focus indicator, and the
 * one thing keyboard-only operation depends on. `focus-visible` rather than
 * `focus` so a mouse click does not leave a ring behind.
 */
export const focusRingClass =
  "focus-visible:ring-2 focus-visible:ring-slate-400 " +
  "focus-visible:ring-offset-1 focus-visible:outline-none";

export const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
  "focus:border-slate-500 focus:outline-none " +
  focusRingClass;

/** Compact form of `inputClass` for controls inside a claim/source card. */
export const compactInputClass =
  "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs " +
  "focus:border-slate-500 focus:outline-none " +
  focusRingClass;

export const primaryButtonClass =
  "rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white " +
  "hover:bg-slate-700 disabled:opacity-50 " +
  focusRingClass;

/** Compact form of `primaryButtonClass`, for buttons inside a row or bar. */
export const compactButtonClass =
  "rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white " +
  "hover:bg-slate-700 disabled:opacity-50 " +
  focusRingClass;

/**
 * Destructive actions (discard a claim, revert an identity). One treatment,
 * because there were two — an outline red and a solid red — sitting one click
 * apart inside the same claim card, which read as two different kinds of
 * action rather than one kind in two places.
 */
export const dangerButtonClass =
  "rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium " +
  "text-red-700 hover:bg-red-100 disabled:opacity-50 " +
  focusRingClass;

/**
 * The project workspace's wide column.
 *
 * The workbench needs more than the layout's `max-w-5xl` — briefing, claim
 * margin-cards and the sources rail sit side by side — so it breaks out of
 * `<main>` to viewport width. Two things that breakout got wrong on its own:
 * on an ultrawide screen it stretched the briefing card into a field of
 * padding, and the sections stacked below it stayed at `max-w-5xl`, so the
 * page rendered as two columns of visibly different widths. The inner cap
 * fixes the first; applying this at the page level rather than inside
 * `Workbench` fixes the second.
 */
export const wideContainerClass = "mx-[calc(50%-50vw)] px-6";
/** Inner bound of `wideContainerClass` — apply to its single child. */
export const wideContentClass = "mx-auto max-w-[110rem]";

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

/** Progress box of a running job stream (extraction/verification/review).
 * `subtitle` carries an optional "n von m" counter derived from durable
 * state, so progress is legible without reading every log line. */
export function RunProgressFeed({
  title,
  subtitle,
  lines,
}: {
  title: string;
  subtitle?: string;
  lines: { key: number; text: string }[];
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-700">{title}</p>
        {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
      </div>
      <ul className="mt-2 space-y-1 font-mono text-xs text-slate-600">
        {lines.length === 0 ? <li>Verbinde …</li> : null}
        {lines.map((line) => (
          <li key={line.key}>{line.text}</li>
        ))}
      </ul>
    </div>
  );
}

/** Shown when a run's live stream dropped before the run finished: the feed
 * went silent because the connection was lost, not because the run ended.
 * The durable state is intact server-side, so a reload recovers it. */
export function ConnectionLostNotice() {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      <p>
        Die Verbindung zum Laufprotokoll wurde unterbrochen – der Lauf selbst
        läuft serverseitig weiter. Seite neu laden, um den aktuellen Stand zu
        sehen.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-1 underline decoration-amber-400 hover:decoration-amber-600"
      >
        Jetzt neu laden
      </button>
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
        ? `KI-Prüfstufen gesperrt – primäres Backend "${health.primary.cli}" ` +
            `nicht einsatzbereit: ${firstFailureHint(health.primary)} ` +
            "Die regelbasierte Zitatprüfung (Stufe 1) bleibt nutzbar."
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
        2 und 3 – Belegprüfung und Bewertung gegen das Bewertungsschema – sind
        dadurch nicht unabhängig vom Modell, das den Text geschrieben hat.
      </p>
      <p className="mt-1">
        Stufe 1, die Zitatprüfung des Wortlauts gegen das eingefrorene Dokument,
        ist davon nicht betroffen: sie ist deterministisch und modellunabhängig.
      </p>
    </div>
  );
}

/**
 * Way back out of a project. The header wordmark also points at `/projects`,
 * but a logo is a home button, not an "up one level" — without this the only
 * route from a project back to the list was the browser's back button.
 */
export function ProjectBreadcrumb() {
  return (
    <nav aria-label="Navigationspfad" className="mb-1 text-sm text-slate-500">
      <Link href="/projects" className="hover:text-slate-700">
        Projekte
      </Link>
      <span aria-hidden="true" className="px-1.5 text-slate-300">
        /
      </span>
      {/* Same terminal crumb the side views' trail uses for this page, so the
          two read as one path rather than two conventions. */}
      <span className="text-slate-700">Arbeitsbereich</span>
    </nav>
  );
}

/**
 * The side views reachable from a project — the single list behind both
 * places they are offered, so adding or reordering one cannot leave the two
 * disagreeing. `label` is the chip in a side view's own header, where the
 * neighbours have to fit on one row; `description` is the workbench footer's
 * fuller wording, where the link is the first time a reader meets the view
 * and the short label would not say what it is for.
 *
 * The two conditional entries — in-app research and the relevance check —
 * are not here: each depends on project state and carries a count in its
 * text, so the workbench renders them itself.
 */
export const PROJECT_SIDE_VIEWS = [
  {
    slug: "start",
    label: "Recherche-Werkzeuge",
    description: "Recherche-Werkzeuge und Prompt-Hilfe",
  },
  {
    slug: "history",
    label: "Verlauf",
    description: "Unveränderlichen Verlauf ansehen",
  },
  {
    slug: "warm-run",
    label: "Folgeprojekt",
    description: "Folgeprojekt zu einer neuen Frage anlegen",
  },
  {
    slug: "metrics",
    label: "Auswertung",
    description: "Auswertung (Kennzahlen) ansehen",
  },
  {
    slug: "traces",
    label: "KI-Aufrufe",
    description: "Protokoll der KI-Aufrufe ansehen",
  },
  { slug: "settings", label: "Einstellungen", description: "Einstellungen" },
  {
    slug: "status",
    label: "Systemstatus",
    description: "Systemstatus (Bereitschaftsprüfung)",
  },
] as const;

/** Link styling of the workbench's "Weitere Sichten" list, shared with the
 * two conditional entries the workbench renders alongside it. */
export const sideViewLinkClass =
  "text-slate-500 underline decoration-slate-300 " +
  "hover:text-slate-700 hover:decoration-slate-600";

/**
 * Header of a side view on a project (history, metrics, traces, research,
 * warm run, settings, status). The `nextStep` forward affordance it used to
 * carry died with the staged step pages — there is no "next step" any more,
 * only the workbench and the views beside it.
 *
 * It carries the sibling views too: they are only listed at the bottom of the
 * workbench, so comparing two of them meant returning to the workbench and
 * finding the link again for every hop.
 */
export function SubpageHeader({
  projectId,
  title,
  /** Slug of the current view, so it is shown as position rather than link. */
  current,
}: {
  projectId: string;
  title: string;
  current?: (typeof PROJECT_SIDE_VIEWS)[number]["slug"];
}) {
  return (
    <div>
      <nav aria-label="Navigationspfad" className="text-sm text-slate-500">
        <Link href="/projects" className="hover:text-slate-700">
          Projekte
        </Link>
        <span aria-hidden="true" className="px-1.5 text-slate-300">
          /
        </span>
        <Link href={`/projects/${projectId}`} className="hover:text-slate-700">
          Arbeitsbereich
        </Link>
        <span aria-hidden="true" className="px-1.5 text-slate-300">
          /
        </span>
        <span className="text-slate-700">{title}</span>
      </nav>
      <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
      <nav
        aria-label="Weitere Sichten"
        className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm"
      >
        {PROJECT_SIDE_VIEWS.map((view) =>
          view.slug === current ? (
            <span
              key={view.slug}
              aria-current="page"
              className="text-slate-700"
            >
              {view.label}
            </span>
          ) : (
            <Link
              key={view.slug}
              href={`/projects/${projectId}/${view.slug}`}
              className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
            >
              {view.label}
            </Link>
          ),
        )}
      </nav>
    </div>
  );
}

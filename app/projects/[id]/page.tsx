import Link from "next/link";

import { loadProjectOrNotFound } from "@/app/lib/load-project";
import {
  getBriefingIndependence,
  getProjectSummary,
  readProject,
} from "@/lib/pipeline";
import { DemoProjectNotice, IndependenceNotice } from "../../components/ui";
import { formatTimestamp, STATUS_LABELS, STATUS_ORDER } from "../status-labels";

export const dynamic = "force-dynamic";

export default async function ProjectPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  const summary = await loadProjectOrNotFound(() => getProjectSummary(id));
  const independence = getBriefingIndependence(await readProject(id));

  return (
    <div className="space-y-6">
      <div>
        <p className="font-mono text-xs text-slate-500">
          {summary.id}
          {summary.origin_id ? (
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 font-sans">
              importiert · Ursprungs-Id {summary.origin_id}
            </span>
          ) : null}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">
          {summary.research_question}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Angelegt: {formatTimestamp(summary.created_at)} · Letzte Änderung:{" "}
          {formatTimestamp(summary.last_change_at)}
        </p>
      </div>

      {summary.is_demo ? <DemoProjectNotice /> : null}
      {independence.sharedModelFamily ? (
        <IndependenceNotice modelFamily={independence.modelFamily} />
      ) : null}

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">Claim-Status</h2>
        {summary.total_claims === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Noch keine Claims – sie entstehen mit der Extraktion aus dem
            Briefing.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-5">
            {STATUS_ORDER.map((status) => (
              <div
                key={status}
                className="rounded-md bg-slate-50 px-3 py-2 text-center"
              >
                <dt className="text-xs text-slate-500">
                  {STATUS_LABELS[status]}
                </dt>
                <dd className="text-lg font-semibold">
                  {summary.claim_counts[status]}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Arbeitsschritte
        </h2>
        <ol className="mt-3 space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <span
              className={
                summary.briefing_imported ? "text-green-600" : "text-slate-400"
              }
            >
              {summary.briefing_imported ? "✓" : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/briefing`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Briefing importieren
            </Link>
            {summary.briefing_imported ? null : (
              <span className="text-slate-500">
                oder{" "}
                <Link
                  href={`/projects/${summary.id}/research`}
                  className="underline decoration-slate-300 hover:decoration-slate-600"
                >
                  in der Anwendung recherchieren
                </Link>
              </span>
            )}
          </li>
          <li className="flex items-center gap-2">
            <span
              className={
                summary.source_count > 0 ? "text-green-600" : "text-slate-400"
              }
            >
              {summary.source_count > 0 ? "✓" : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/sources`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Quellen erfassen
            </Link>
          </li>
          <li className="flex items-center gap-2">
            <span
              className={
                summary.total_claims > 0 ? "text-green-600" : "text-slate-400"
              }
            >
              {summary.total_claims > 0 ? "✓" : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/extraction`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Claims extrahieren
            </Link>
          </li>
          <li className="flex items-center gap-2">
            <span
              className={
                summary.total_claims > 0 &&
                summary.claim_counts.captured +
                  summary.claim_counts.existence_checked ===
                  0
                  ? "text-green-600"
                  : "text-slate-400"
              }
            >
              {summary.total_claims > 0 &&
              summary.claim_counts.captured +
                summary.claim_counts.existence_checked ===
                0
                ? "✓"
                : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/verification`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Claims prüfen (Existenz, Attribution, Kalibrierung)
            </Link>
          </li>
          <li className="flex items-center gap-2">
            <span
              className={
                summary.total_claims > 0 &&
                summary.claim_counts.pending_adjudication === 0
                  ? "text-green-600"
                  : "text-slate-400"
              }
            >
              {summary.total_claims > 0 &&
              summary.claim_counts.pending_adjudication === 0
                ? "✓"
                : "○"}
            </span>
            <Link
              href={`/projects/${summary.id}/review`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Adjudizieren und reparieren
            </Link>
          </li>
          {summary.adopted_claims > 0 ? (
            <li className="flex items-center gap-2">
              <span
                className={
                  summary.pending_relevance === 0
                    ? "text-green-600"
                    : "text-slate-400"
                }
              >
                {summary.pending_relevance === 0 ? "✓" : "○"}
              </span>
              <Link
                href={`/projects/${summary.id}/relevance`}
                className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
              >
                Einschlägigkeit der übernommenen Claims prüfen (
                {summary.adopted_claims} übernommen)
              </Link>
            </li>
          ) : null}
        </ol>
        <p className="mt-3 flex flex-wrap gap-x-4 text-sm">
          <Link
            href={`/projects/${summary.id}/history`}
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
          >
            Verlauf der Append-only-Historie ansehen
          </Link>
          <Link
            href={`/projects/${summary.id}/warm-run`}
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
          >
            Folgefrage als warmen Lauf starten
          </Link>
          <Link
            href={`/projects/${summary.id}/metrics`}
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
          >
            Auswertung (Messgrößen) ansehen
          </Link>
          <Link
            href={`/projects/${summary.id}/traces`}
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
          >
            Trace-Log der LLM-Aufrufe ansehen
          </Link>
          <Link
            href={`/projects/${summary.id}/settings`}
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
          >
            Einstellungen
          </Link>
          <Link
            href={`/projects/${summary.id}/status`}
            className="text-slate-500 underline decoration-slate-300 hover:text-slate-700 hover:decoration-slate-600"
          >
            Systemstatus (Backend-Diagnose)
          </Link>
        </p>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Export &amp; Weitergabe
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          Das .tmb-Bundle ist ein einzelnes Weitergabeartefakt (ZIP-Container)
          mit Manifest-Prüfsummen; die Hash-Kette ist damit auch ohne
          Repository-Historie prüfbar (<code>tmb verify</code>).
        </p>
        {summary.claim_counts.pending_adjudication > 0 ? (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Hinweis: {summary.claim_counts.pending_adjudication} Claim(s) sind
            noch zur Adjudikation offen. Ein jetzt erzeugtes Bundle gibt einen
            Zwischenstand wieder, nicht das abgeschlossene Ergebnis.
          </p>
        ) : null}
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <a
              href={`/api/projects/${summary.id}/export`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Bundle herunterladen (.tmb, mit Blobs)
            </a>
          </li>
          <li>
            <a
              href={`/api/projects/${summary.id}/export?blobs=0`}
              className="text-slate-900 underline decoration-slate-300 hover:decoration-slate-600"
            >
              Schlankes Bundle (ohne Blobs, nur Prüfsummen-Referenzen)
            </a>
          </li>
        </ul>
        <p className="mt-3 text-xs text-slate-500">Abgeleitete Exporte:</p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {["references.csl.json", "prov.jsonld", "traces.json"].map((name) => (
            <li key={name}>
              <a
                href={`/api/projects/${summary.id}/export/derived/${name}`}
                className="font-mono text-xs text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
              >
                {name}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

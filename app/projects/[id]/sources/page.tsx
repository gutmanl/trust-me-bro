import Link from "next/link";

import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { SubpageHeader } from "@/app/components/ui";
import {
  formatCitation,
  getBackendsHealth,
  getReferenceCandidates,
  getReferenceCaptureRun,
  getReferenceScanState,
  getUnpaywallSetting,
  isSourceSetFrozen,
  readProject,
} from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { formatTimestamp } from "../../status-labels";
import { ReferenceCandidateReview } from "./ReferenceCandidateReview";
import { ReferenceScanPanel } from "./ReferenceScanPanel";
import {
  CaptureSourceForm,
  FreezeSourceSetForm,
  ReviseSourceForm,
} from "./SourceForms";
import { UnpaywallSettingPanel } from "./UnpaywallSettingPanel";

export const dynamic = "force-dynamic";

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  peer_reviewed_publication: "Begutachtete Publikation",
  preprint: "Preprint",
  grey_literature: "Grauliteratur",
  vendor_documentation: "Herstellerdokumentation",
};

/** I4 fix: German label per auto-import method, for the provenance badge
 * rendered next to every automatically captured source below. */
const AUTO_CAPTURE_METHOD_LABELS: Record<
  "doi" | "arxiv" | "url" | "crossref_title" | "unresolved",
  string
> = {
  doi: "DOI im Text gefunden",
  arxiv: "arXiv-Id im Text gefunden",
  url: "URL im Text gefunden",
  crossref_title: "Titelabgleich",
  unresolved: "textuell gefunden, manuell vervollständigt",
};

export default async function SourcesPage(
  props: PageProps<"/projects/[id]/sources">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const frozen = isSourceSetFrozen(register);
  const briefingImported = register.project.briefing_import !== undefined;

  // M5 fix: none of this renders for a frozen project or one with no
  // briefing yet (see the `!frozen` / `!briefingImported` branches below) —
  // gate the work accordingly. getBackendsHealth in particular spawns CLI
  // child processes on every call, so computing it unconditionally cost a
  // process spawn on every load of an already-frozen or briefing-less page.
  const showReferenceImport = !frozen && briefingImported;
  const referenceScanState = showReferenceImport
    ? getReferenceScanState(id, register)
    : null;
  const unpaywallSetting = showReferenceImport ? getUnpaywallSetting() : null;
  const [health, candidates] = showReferenceImport
    ? await Promise.all([getBackendsHealth(id), getReferenceCandidates(id)])
    : [null, null];
  // Capture keeps no durable state (run-reference-capture.ts), so unlike the
  // scan/verification panels the page must ask the runner directly whether a
  // capture batch is live — otherwise a reload cannot surface it and the
  // review panel would offer a submit button that 409s with "already a run".
  const captureRunActive = showReferenceImport
    ? (getReferenceCaptureRun(id)?.isActive() ?? false)
    : false;

  return (
    <div className="space-y-6">
      <SubpageHeader
        projectId={id}
        title="Quellen"
        nextStep={{
          href: `/projects/${id}/extraction`,
          label: "Weiter zur Extraktion",
        }}
      />

      {frozen ? (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <p className="font-medium">Quellenbestand eingefroren</p>
          <p className="mt-1">
            Revision {register.project.source_set_revision} ·{" "}
            {register.sources.length} Quelle(n). Alle Prüfungen referenzieren
            diesen Stand.
          </p>
        </div>
      ) : null}

      <section className="rounded-md border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
          Erfasste Quellen ({register.sources.length})
        </h2>
        {register.sources.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            Noch keine Quellen erfasst.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {register.sources.map((source) => {
              const snapshot = source.custom.snapshot;
              return (
                <li key={source.id} className="px-5 py-4">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-medium">
                      {formatCitation(source)}
                    </span>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {SOURCE_TYPE_LABELS[source.custom.source_type]}
                    </span>
                  </div>
                  {typeof source.title === "string" ? (
                    <p className="mt-0.5 text-sm text-slate-600">
                      {source.title}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span className="font-mono">{source.id}</span>
                    {source.custom.identifier_verified?.status ? (
                      <span className="text-green-600">
                        ✓ Identifier verifiziert
                      </span>
                    ) : null}
                    {source.custom.auto_capture ? (
                      // I4 fix: a fuzzy crossref_title match resolved a REAL
                      // DOI (identifier_verified above is correctly true),
                      // but the identifier was GUESSED by title similarity,
                      // not found verbatim in the text — this badge keeps
                      // that provenance legible instead of looking identical
                      // to a hand-typed, directly-found identifier.
                      <span
                        className={
                          source.custom.auto_capture.method === "crossref_title"
                            ? "text-amber-700"
                            : "text-slate-500"
                        }
                      >
                        {source.custom.auto_capture.method === "crossref_title"
                          ? `⚠ automatisch übernommen – ${AUTO_CAPTURE_METHOD_LABELS.crossref_title} (${Math.round((source.custom.auto_capture.score ?? 0) * 100)}% Übereinstimmung)`
                          : `automatisch übernommen – ${AUTO_CAPTURE_METHOD_LABELS[source.custom.auto_capture.method]}`}
                      </span>
                    ) : null}
                    {snapshot ? (
                      <>
                        <span>
                          Snapshot: {formatTimestamp(snapshot.retrieved_at)}{" "}
                          (Revision {snapshot.revision})
                        </span>
                        <span className="font-mono">
                          {snapshot.sha256.slice(0, 12)}…
                        </span>
                        {snapshot.text_blob_path ? (
                          <span className="text-green-600">
                            ✓ Volltext extrahiert
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  {snapshot?.text_extraction_error ? (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      ⚠ {snapshot.text_extraction_error}
                    </div>
                  ) : null}
                  {source.custom.previous_snapshots?.length ? (
                    <p className="mt-1 text-xs text-slate-400">
                      {source.custom.previous_snapshots.length} frühere
                      Revision(en) im Blob-Store erhalten.
                    </p>
                  ) : null}
                  {frozen && snapshot ? (
                    <ReviseSourceForm projectId={id} sourceId={source.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!frozen ? (
        <>
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">
              Referenzen aus dem Briefing importieren
            </h2>
            <p className="mb-4 text-sm text-slate-600">
              Durchsucht das eingefrorene Briefing nach zitierten Quellen (DOI,
              arXiv-Id, URL sowie im Fließtext genannte Referenzen) und schlägt
              sie zur Übernahme vor.
            </p>
            {!briefingImported ? (
              <p className="text-sm text-slate-500">
                Zuerst ein{" "}
                <Link
                  href={`/projects/${id}/briefing`}
                  className="underline decoration-slate-300 hover:text-slate-700"
                >
                  Briefing importieren
                </Link>
                .
              </p>
            ) : referenceScanState &&
              unpaywallSetting &&
              health &&
              candidates ? (
              <div className="space-y-4">
                <UnpaywallSettingPanel
                  projectId={id}
                  setting={unpaywallSetting}
                />
                <ReferenceScanPanel
                  projectId={id}
                  state={referenceScanState}
                  llmAvailable={health.primary.usable}
                  lastScanMethod={register.project.reference_scan?.method}
                />
                {referenceScanState.status !== "not_started" ? (
                  <p className="text-sm text-slate-600">
                    {referenceScanState.candidateCount} Kandidat(en) gefunden (
                    {
                      candidates.filter(
                        (candidate) =>
                          candidate.capturable && !candidate.alreadyCaptured,
                      ).length
                    }{" "}
                    automatisch erfassbar).
                  </p>
                ) : null}
                {candidates.length > 0 ? (
                  <ReferenceCandidateReview
                    projectId={id}
                    candidates={candidates}
                    activeRun={captureRunActive}
                  />
                ) : null}
              </div>
            ) : null}
          </section>
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-700">
              Quelle erfassen
            </h2>
            <CaptureSourceForm projectId={id} />
          </section>
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">
              Quellenbestand einfrieren
            </h2>
            <FreezeSourceSetForm
              projectId={id}
              sourceCount={register.sources.length}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}

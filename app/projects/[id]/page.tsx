import Link from "next/link";

import {
  BackendHealthNotice,
  ProjectBreadcrumb,
  PROJECT_SIDE_VIEWS,
  sideViewLinkClass,
  wideContainerClass,
  wideContentClass,
} from "@/app/components/ui";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import {
  buildAdjudicationQueue,
  buildEvidenceDisplayMap,
  deriveExtractionActivity,
  deriveOriginalIdentity,
  deriveSourceExtractionOutcomes,
  deriveSourceLifecycles,
  formatCitation,
  getBackendsHealth,
  getBriefing,
  getBriefingDraft,
  getBriefingIndependence,
  getActiveRun,
  getBriefingViewModel,
  getOpenExistenceCheckCount,
  getProjectMetrics,
  getProjectSummary,
  getReferenceCandidates,
  getReferenceScanState,
  deriveOpenClaimRepairSuggestions,
  deriveOpenRepairActions,
  deriveOpenChainTriggers,
  getSourceWorkItems,
  getUnpaywallSetting,
  getVerificationState,
  pendingTriggerCount,
  previewClaimRecheck,
  readProject,
} from "@/lib/pipeline";
import type { RecheckPreview } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { DemoProjectNotice, IndependenceNotice } from "../../components/ui";
import { formatTimestamp, SOURCE_TYPE_LABELS } from "../status-labels";
import { autoCaptureRowNote } from "./auto-capture-labels";
import { buildOriginalIdentityRow } from "./original-identity-vm";
import type { ReferenceImportVM } from "./workbench/SourcesRail";
import type { SourceRowVM } from "./workbench/SourceRow";
import { Workbench } from "./workbench/Workbench";

export const dynamic = "force-dynamic";

/**
 * The sweep's preview, or null when it cannot be computed for this project.
 *
 * WHY THIS IS CAUGHT RATHER THAN LEFT TO PROPAGATE. The preview resolves the
 * project's OWN rubric pin through `loadRubricRuleSet`, which throws a plain
 * `Error` — not a `PipelineError` — when the register names a rule file this
 * installation does not ship, and whose rule directory is anchored at
 * `process.cwd()` (TMB-48). Both are correct where the sweep is EXECUTED: an
 * unprüfbare rubric version must never pass silently. But this call sits on
 * the render path of the whole workbench, so letting it propagate turns a
 * config error in one optional affordance into „Etwas ist schiefgelaufen"
 * for the entire project page — including the case where the reviewer's only
 * way to repair the pin is the settings link on that very page. That is a
 * strictly worse outcome than not offering the sweep, so the bar omits the
 * trigger and the server log keeps the cause visible.
 *
 * Regression found by `tests/browser/cold-start/first-contact.spec.ts`, whose
 * server runs with a scratch cwd on purpose.
 */
async function loadRecheckPreview(id: string): Promise<RecheckPreview | null> {
  try {
    return await previewClaimRecheck({ projectId: id });
  } catch (error) {
    console.warn(`Nachprüfungs-Vorschau für "${id}" nicht verfügbar:`, error);
    return null;
  }
}

/** Identifier shape of a source's CURRENT identity, prefilling the
 * correction modal's kind tabs (source correction) — pure presentation
 * derivation, so it lives here rather than in the pipeline. */
function identifierKindOf(
  source: Record<string, unknown>,
): "doi" | "arxiv" | "url" | "upload" {
  if (typeof source.DOI === "string" && source.DOI.length > 0) {
    return "doi";
  }
  const url = typeof source.URL === "string" ? source.URL : undefined;
  if (url !== undefined && url.includes("arxiv.org")) {
    return "arxiv";
  }
  if (url !== undefined && url.length > 0) {
    return "url";
  }
  return "upload";
}

/**
 * The project page IS the workbench (workbench epic). It replaces the five
 * staged step pages — briefing, sources, extraction, verification, review —
 * that used to sit behind a dashboard checklist. Those pages staged a
 * pipeline that is actually iterative: capturing a source, correcting a
 * passage and adjudicating a claim are moves in one loop, and each of them
 * used to cost a page transition.
 *
 * Everything durable is read here, server-side, from the register — the one
 * source of truth — and handed to the client shell as plain data. The
 * remaining subpages (research, warm run, history, metrics, traces,
 * settings, status) stay what they were: side views on this same project,
 * linked from the footer below.
 */
export default async function ProjectPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const summary = await getProjectSummary(id);
  const independence = getBriefingIndependence(register);
  const briefingImported = register.project.briefing_import !== undefined;

  const [briefing, briefingContent, draft, recheckPreview, metrics] =
    await Promise.all([
      getBriefingViewModel(id),
      getBriefing(id),
      getBriefingDraft(id),
      // All three rungs of the sweep's ladder in one read, and deliberately
      // WITHOUT `excludeClaimIds`: the claim to exclude (RERUN-04) is client
      // state in `Workbench`, so the bar subtracts it from the displayed
      // counts and sends the id back with the request. Read-only and
      // un-gated — it takes no lock and starts nothing.
      loadRecheckPreview(id),
      getProjectMetrics(id),
    ]);

  const lifecycles = new Map(
    deriveSourceLifecycles(register).map((lifecycle) => [
      lifecycle.sourceId,
      lifecycle,
    ]),
  );
  const extractionOutcomes = deriveSourceExtractionOutcomes(register);
  const sources: SourceRowVM[] = register.sources.flatMap((source) => {
    const snapshot = source.custom.snapshot;
    const lifecycle = lifecycles.get(source.id);
    // A source without a frozen snapshot has no lifecycle to show — the
    // derivation skips it for the same reason.
    if (!snapshot || !lifecycle) {
      return [];
    }
    const auto = source.custom.auto_capture;
    // Original source identity: the pipeline formats the first archived
    // identity and dates it, the display module phrases it. Bound ONCE, because
    // the same value decides both whether the block renders and whether the
    // row-level auto-capture note is suppressed under it. Gating the note on an
    // independently derived predicate — the count of previous identities, or
    // the presence of auto-capture data — would reintroduce the
    // two-predicates-one-question bug this row has already been fixed for:
    // `deriveOriginalIdentity` also returns undefined when the archived
    // snapshot is missing, so a re-derived predicate would disagree with the
    // block on exactly that state.
    const originalIdentityRow = buildOriginalIdentityRow(
      deriveOriginalIdentity(source),
    );
    const autoCaptureNote = autoCaptureRowNote(auto, {
      originalIdentityShown: originalIdentityRow.originalIdentity !== undefined,
    });
    return [
      {
        id: source.id,
        citation: formatCitation(source),
        ...(typeof source.title === "string" ? { title: source.title } : {}),
        sourceTypeLabel:
          SOURCE_TYPE_LABELS[source.custom.source_type as SourceType],
        revision: lifecycle.revision,
        capturedAt: lifecycle.capturedAt,
        citingClaims: lifecycle.citingClaims,
        identifierVerified: source.custom.identifier_verified?.status === true,
        fullTextExtracted: snapshot.text_blob_path !== undefined,
        ...(snapshot.text_extraction_error !== undefined
          ? { textExtractionError: snapshot.text_extraction_error }
          : {}),
        previousSnapshots: source.custom.previous_snapshots?.length ?? 0,
        // Absent rather than present-and-undefined: the row renders the note on
        // the property being defined.
        ...(autoCaptureNote !== undefined ? { autoCaptureNote } : {}),
        extractionOutcome: extractionOutcomes.get(source.id)?.outcome ?? null,
        ...(extractionOutcomes.get(source.id)?.outcome === "failed"
          ? { extractionMessage: extractionOutcomes.get(source.id)?.message }
          : {}),
        currentKind: identifierKindOf(source as Record<string, unknown>),
        currentSourceType: source.custom.source_type as SourceType,
        previousIdentities: source.custom.previous_identities?.length ?? 0,
        // Last in the literal, so the block still wins any future key
        // collision. Deliberately without the crossref_title score suffix the
        // note carries — the block answers "what was this originally", not
        // "how good was the match".
        ...originalIdentityRow,
      },
    ];
  });
  // The not-yet-sources half of the unified list: queued/capturing from the
  // chain and runner, durable failures from the register.
  const workItems = getSourceWorkItems(id, register);
  // Interrupted chain steps (run visibility): open evaluator brackets — a
  // crash, cancel or deadline cut them off. Informational: each re-runs
  // organically (the repair evaluation with the next existence check, the
  // anchor sweep with the next publish/extraction), but the cut-off must
  // be visible, not silently absorbed.
  const interruptedTriggers = deriveOpenChainTriggers(
    register.project_events,
  ).filter((entry) => entry.kind !== "source_capture");
  // Open auto-repair suggestions, joined onto failed work items and source
  // rows client-side by the rail.
  const repairSuggestions = deriveOpenRepairActions(register);
  // Open verdict-driven claim-repair suggestions, joined per claim id by
  // the briefing view's cards (verdict-driven repair).
  const claimRepairSuggestions = Object.fromEntries(
    deriveOpenClaimRepairSuggestions(register).map((entry) => [
      entry.claimId,
      entry,
    ]),
  );

  // The reference-import section only exists once there is a briefing to
  // scan. Keeping it gated matters beyond tidiness: getBackendsHealth spawns
  // CLI child processes on every call, so computing it unconditionally would
  // cost a process spawn on every load of a briefing-less project.
  const health = briefingImported ? await getBackendsHealth(id) : null;
  let referenceImport: ReferenceImportVM | null = null;
  if (briefingImported && health) {
    const [candidates, unpaywall] = await Promise.all([
      getReferenceCandidates(id),
      Promise.resolve(getUnpaywallSetting()),
    ]);
    // Capture run state and per-candidate outcomes are gone from this VM
    // (source work items): a candidate's live state arrives via its work
    // item in the unified list, and failures are durable register events.
    referenceImport = {
      scanState: getReferenceScanState(id, register),
      unpaywall,
      candidates,
      llmAvailable: health.primary.usable,
      ...(register.project.reference_scan?.method !== undefined
        ? { lastScanMethod: register.project.reference_scan.method }
        : {}),
    };
  }

  return (
    <div className={wideContainerClass}>
      <div className={`${wideContentClass} space-y-6`}>
        <div>
          <ProjectBreadcrumb />
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
        {health ? (
          <BackendHealthNotice
            projectId={id}
            health={health}
            mode="verification"
          />
        ) : null}

        <Workbench
          projectId={id}
          researchQuestion={summary.research_question}
          briefing={briefing}
          briefingText={briefingContent?.text ?? null}
          briefingMeta={briefingContent?.meta ?? null}
          draft={draft}
          queue={buildAdjudicationQueue(register)}
          evidenceDisplay={buildEvidenceDisplayMap(id, register)}
          claimRepairSuggestions={claimRepairSuggestions}
          counts={summary.claim_counts}
          totalClaims={summary.total_claims}
          openExistenceCount={getOpenExistenceCheckCount(register)}
          verificationState={getVerificationState(id, register)}
          verificationBlockedReason={
            register.claims.length === 0
              ? "Vor der Prüfung müssen Aussagen erfasst sein."
              : null
          }
          sources={sources}
          workItems={workItems}
          repairSuggestions={repairSuggestions}
          sourceSetRevision={register.project.source_set_revision}
          pendingTriggers={pendingTriggerCount(id)}
          interruptedTriggers={interruptedTriggers}
          extractionActivity={deriveExtractionActivity(
            register,
            getActiveRun(id)?.kind === "extraction",
          )}
          referenceImport={referenceImport}
          recheckPreview={recheckPreview}
          reverification={metrics.reverification}
        />

        <section className="rounded-md border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-700">
            Weitere Sichten
          </h2>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {/* The two state-dependent entries first, then the fixed list —
                see PROJECT_SIDE_VIEWS for why these two are not in it. */}
            {!briefingImported ? (
              <Link
                href={`/projects/${summary.id}/research`}
                className={sideViewLinkClass}
              >
                In der Anwendung recherchieren
              </Link>
            ) : null}
            {summary.adopted_claims > 0 ? (
              <Link
                href={`/projects/${summary.id}/relevance`}
                className={sideViewLinkClass}
              >
                Relevanz der übernommenen Aussagen prüfen (
                {summary.adopted_claims} übernommen)
              </Link>
            ) : null}
            {PROJECT_SIDE_VIEWS.map((view) => (
              <Link
                key={view.slug}
                href={`/projects/${summary.id}/${view.slug}`}
                className={sideViewLinkClass}
              >
                {view.description}
              </Link>
            ))}
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
              Hinweis: {summary.claim_counts.pending_adjudication} Aussage(n)
              sind noch zur manuellen Überprüfung offen. Ein jetzt erzeugtes
              Bundle gibt einen Zwischenstand wieder, nicht das abgeschlossene
              Ergebnis.
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
            {["references.csl.json", "prov.jsonld", "traces.json"].map(
              (name) => (
                <li key={name}>
                  <a
                    href={`/api/projects/${summary.id}/export/derived/${name}`}
                    className="font-mono text-xs text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
                  >
                    {name}
                  </a>
                </li>
              ),
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

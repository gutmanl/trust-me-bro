/**
 * Architecture guard tests. These deliberately duplicate rules that ESLint
 * and code review also enforce: they fail loudly when a future change —
 * human or LLM-generated — erodes a structural invariant, even if lint
 * config or barrel files are edited along the way. Do not weaken them to
 * make a change pass; change the design consciously instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as adaptersPublic from "../lib/adapters";
import * as exportPublic from "../lib/export";
import * as pipelinePublic from "../lib/pipeline";
import * as registerPublic from "../lib/register";
import { TRANSITIONS } from "../lib/register/statemachine/transitions";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sourceFiles(dir: string): string[] {
  const absolute = path.join(repoRoot, dir);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  return fs
    .readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(dir, name));
}

function read(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

describe("public surface of lib/register", () => {
  it("exposes the store but never the chain minter or the raw engine", () => {
    const surface = registerPublic as Record<string, unknown>;
    expect(surface.RegisterStore).toBeDefined();
    expect(surface.verifyChain).toBeDefined();
    expect(surface.renderBriefing).toBeDefined();
    expect(surface.createBlobStore).toBeDefined();
    expect(surface.countClaimsByStatus).toBeDefined();
    expect(surface.lastActivityAt).toBeDefined();
    // Exposed so the pipeline can CLASSIFY why a claim was routed to
    // adjudication without re-implementing the heuristic; admission itself
    // still happens only inside the creation gate.
    expect(surface.isAtomicClaimText).toBeDefined();
    // Same escape-hatch pattern for TMB-4: the verification pipeline decides
    // WHICH edge to take / WHICH relation to persist via these predicates;
    // the transition gates remain the authority at commit time.
    expect(surface.evaluateAutoConfirmation).toBeDefined();
    expect(surface.resolveEvidenceRelation).toBeDefined();
    expect(surface.latestJudgmentPerBackend).toBeDefined();
    // TMB-5: the repair pipeline decides the re-entry edge with the same
    // predicate the gate re-checks at commit time.
    expect(surface.allExistenceChecksPassed).toBeDefined();
    // RERUN-02: the re-check selection asks the widened
    // pending_adjudication gate whether a queued claim qualifies instead of
    // restating its condition, so it can never offer the reviewer a claim
    // the transition would then refuse.
    expect(surface.machineParkedInAdjudication).toBeDefined();
    // CR-01: the "admitted into recheck_required ⇒ able to leave it"
    // invariant. Public for the same reason — the selection asks the table
    // rather than restating the exit edge's condition, because a claim that
    // fails it is stranded permanently once admitted.
    expect(surface.canLeaveRecheck).toBeDefined();
    // Verdict-driven repair: the repair pipeline and the suggestion
    // eligibility ask the same gate the direct repair edge re-checks at
    // commit time, so no claim is ever offered a repair the transition
    // would then refuse.
    expect(surface.routedRepairable).toBeDefined();
    // TMB-5: anchor resolution/evidence numbering single-sourced for the
    // markdown projection AND the review UI.
    expect(surface.buildBriefingViewModel).toBeDefined();
    expect(surface.formatLocator).toBeDefined();
    // TMB-6: pure read-side helpers for the export bundle — the F4 filter
    // projection, content hashing and the chain tip for the manifest. The
    // ChainAppender itself stays internal (assertion below).
    expect(surface.toPlainCsl).toBeDefined();
    // TMB-45: metrics as a pure register projection; countRepairCycles
    // relocated here from the repair pipeline (shared by re-entry and
    // metrics, pure history derivation).
    expect(surface.computeProjectMetrics).toBeDefined();
    // WR-02: one definition of "the latest run's re-check window", shared
    // by the flag that gates the post-run summary and the numbers in it.
    expect(surface.claimIdsRecheckedInLatestRun).toBeDefined();
    expect(surface.countRepairCycles).toBeDefined();
    expect(surface.sha256Hex).toBeDefined();
    expect(surface.sha256FromBlobPath).toBeDefined();
    expect(surface.latestChainLink).toBeDefined();
    // Workbench epic: the shared verbatim-quote normal form and paragraph
    // split, relocated here so lib/register itself can do quote-first anchor
    // resolution without depending on lib/pipeline.
    expect(surface.containsNormalized).toBeDefined();
    expect(surface.normalizeForSearch).toBeDefined();
    expect(surface.splitBriefingParagraphs).toBeDefined();
    // Chain links and status changes must only be producible inside a
    // RegisterStore transaction (single-writer invariant).
    expect(surface.ChainAppender).toBeUndefined();
    expect(surface.applyTransition).toBeUndefined();
    expect(surface.createClaim).toBeUndefined();
    expect(surface.withProjectLock).toBeUndefined();
    expect(surface.writeFileAtomic).toBeUndefined();
  });
});

describe("public surface of lib/adapters", () => {
  it("exposes the orchestrator, backends and errors but never the internals", () => {
    const surface = adaptersPublic as Record<string, unknown>;
    expect(surface.Orchestrator).toBeDefined();
    expect(surface.createProjectOrchestrator).toBeDefined();
    expect(surface.resolveConfiguredBackends).toBeDefined();
    expect(surface.createClaudeBackend).toBeDefined();
    expect(surface.createCodexBackend).toBeDefined();
    expect(surface.createMockBackend).toBeDefined();
    expect(surface.renderPromptForJob).toBeDefined();
    expect(surface.AdapterRateLimitError).toBeDefined();
    // TMB-49: the preflight facade; probe mechanics and the login-probe
    // cache stay internal.
    expect(surface.checkCliHealth).toBeDefined();
    expect(surface.runCliLoginProbe).toBeDefined();
    expect(surface.probeLogin).toBeUndefined();
    expect(surface.probePresenceAndVersion).toBeUndefined();
    expect(surface.setCachedLoginProbe).toBeUndefined();
    // TMB-51: the API spike backend; its HTTP port implementation stays
    // internal like nodeProcessRunner.
    expect(surface.createAnthropicApiBackend).toBeDefined();
    expect(surface.nodeFetchHttpPort).toBeUndefined();
    // Internals stay internal: prompt loading/interpolation, the raw spawn
    // site, the output validator and the trace writer are reachable only
    // through the orchestrator/backend path.
    expect(surface.substitute).toBeUndefined();
    expect(surface.loadPromptTemplate).toBeUndefined();
    expect(surface.nodeProcessRunner).toBeUndefined();
    expect(surface.validateJobOutput).toBeUndefined();
  });
});

describe("public surface of lib/export", () => {
  it("exposes the bundle core but never the fflate internals", () => {
    const surface = exportPublic as Record<string, unknown>;
    expect(surface.zipBundle).toBeDefined();
    expect(surface.unzipBundle).toBeDefined();
    expect(surface.bundleText).toBeDefined();
    expect(surface.buildManifest).toBeDefined();
    expect(surface.serializeManifest).toBeDefined();
    expect(surface.Manifest).toBeDefined();
    expect(surface.MANIFEST_PATH).toBeDefined();
    expect(surface.MANIFEST_VERSION).toBeDefined();
    expect(surface.collectBlobPaths).toBeDefined();
    expect(surface.verifyBundleFiles).toBeDefined();
    expect(surface.describeBundleProblem).toBeDefined();
    expect(surface.BundleFormatError).toBeDefined();
    expect(surface.assertSafeRelativePath).toBeDefined();
    expect(surface.writeBundleToDirectory).toBeDefined();
    // The zip library never leaks past the confined wrapper.
    expect(surface.zipSync).toBeUndefined();
    expect(surface.unzipSync).toBeUndefined();
    expect(surface.strToU8).toBeUndefined();
  });
});

describe("public surface of lib/pipeline", () => {
  it("exposes the use-cases the web layer calls", () => {
    const surface = pipelinePublic as Record<string, unknown>;
    expect(surface.createProject).toBeDefined();
    expect(surface.archiveProject).toBeDefined();
    expect(surface.listProjects).toBeDefined();
    expect(surface.getProjectSummary).toBeDefined();
    expect(surface.readProject).toBeDefined();
    expect(surface.slugify).toBeDefined();
    expect(surface.mintProjectId).toBeDefined();
    expect(surface.importBriefing).toBeDefined();
    expect(surface.getBriefing).toBeDefined();
    // Workbench epic: briefing drafts + the revision publish path; the pure
    // re-anchor computation is reachable only through publish.
    expect(surface.saveBriefingDraft).toBeDefined();
    expect(surface.getBriefingDraft).toBeDefined();
    expect(surface.discardBriefingDraft).toBeDefined();
    expect(surface.publishBriefingRevision).toBeDefined();
    expect(surface.computeReanchorUpdates).toBeUndefined();
    expect(surface.captureSource).toBeDefined();
    // Source work items (workbench epic): the asynchronous capture queue's
    // app-facing trio; the trigger runner, the failure recorder/derivation
    // and the request/work-item shapes stay internal.
    expect(surface.enqueueManualCapture).toBeDefined();
    expect(surface.retryManualCapture).toBeDefined();
    expect(surface.dismissCaptureFailure).toBeDefined();
    expect(surface.getSourceWorkItems).toBeDefined();
    expect(surface.getSourceCaptureRun).toBeDefined();
    // Source correction: only the enqueue is app-facing — the correction
    // use-case itself runs exclusively inside the queued work item.
    expect(surface.enqueueSourceCorrection).toBeDefined();
    expect(surface.correctSource).toBeUndefined();
    // …except the metadata-only mode, which queues nothing and freezes no
    // document, so it is called straight from the server action.
    expect(surface.correctSourceMetadata).toBeDefined();
    expect(surface.sweepSourceRecheck).toBeUndefined();
    // Metadata derivation from the uploaded document, one step before the
    // correction it proposes: app-facing because the modal calls it
    // directly. Its verification predicate and its CSL→manual pre-fill
    // mapper are details of that derivation and stay off the barrel.
    expect(surface.deriveMetadataFromDocument).toBeDefined();
    expect(surface.verifyDerivedCandidate).toBeUndefined();
    expect(surface.cslToManualMetadata).toBeUndefined();
    // The undo is app-facing where the correction itself is not: it queues
    // no work item and touches no network, restoring only what the register
    // already archived.
    expect(surface.revertSourceIdentity).toBeDefined();
    // Automatic repair: suggestions (derive/apply/dismiss) and the anchor
    // sweep's enqueue are app-facing; the evaluators, the quote-fit
    // disambiguation, the Crossref re-resolution and the briefing
    // substitution run only off the auto-chain and stay internal.
    expect(surface.deriveOpenRepairActions).toBeDefined();
    expect(surface.applySuggestedRepair).toBeDefined();
    expect(surface.dismissRepairAction).toBeDefined();
    expect(surface.enqueueAnchorRepair).toBeDefined();
    expect(surface.evaluateSourceRepair).toBeUndefined();
    expect(surface.evaluateCaptureFailureRepair).toBeUndefined();
    expect(surface.evaluateQuoteFit).toBeUndefined();
    expect(surface.deriveCitationMeta).toBeUndefined();
    expect(surface.matchViaCrossrefTitle).toBeUndefined();
    expect(surface.crossCheckIdentifiedSeed).toBeUndefined();
    expect(surface.sourcesNeedingRepairEvaluation).toBeUndefined();
    expect(surface.runFuzzyReanchorSweep).toBeUndefined();
    expect(surface.runBriefingSubstitution).toBeUndefined();
    expect(surface.substituteIdentifierOccurrences).toBeUndefined();
    expect(surface.startSourceCaptureItem).toBeUndefined();
    expect(surface.recordCaptureFailure).toBeUndefined();
    expect(surface.deriveOpenCaptureFailures).toBeUndefined();
    expect(surface.pendingCaptureItems).toBeUndefined();
    expect(surface.activeCaptureItem).toBeUndefined();
    // TMB-44: revises a captured source's snapshot; the shared document
    // acquisition helper stays internal.
    expect(surface.reviseSource).toBeDefined();
    expect(surface.acquireDocument).toBeUndefined();
    // TMB-43: warm runs — creation and relevance check; the population
    // selection and state derivation stay internal.
    expect(surface.createWarmRunProject).toBeDefined();
    expect(surface.startRelevanceCheck).toBeDefined();
    expect(surface.getRelevanceState).toBeDefined();
    expect(surface.getRelevanceRun).toBeDefined();
    expect(surface.pendingRelevancePopulation).toBeUndefined();
    expect(surface.deriveRelevanceState).toBeUndefined();
    expect(surface.formatCitation).toBeDefined();
    expect(surface.toPlainCsl).toBeDefined();
    // Workbench epic: the per-source pass, the unevidenced sweep and the two
    // derivations the workbench renders. The project-wide one-shot run
    // (startExtraction/getExtractionState/getExtractionRun) is deliberately
    // gone from this list — extraction is incremental now — and the commit
    // step stays internal: a pass is committed only through a run.
    expect(surface.startSourceExtraction).toBeDefined();
    expect(surface.startUnevidencedExtraction).toBeDefined();
    expect(surface.deriveExtractionActivity).toBeDefined();
    // Source work items: the per-source verdict of the last pass, read off
    // the bracket events' structured source_id.
    expect(surface.deriveSourceExtractionOutcomes).toBeDefined();
    expect(surface.deriveSourceLifecycles).toBeDefined();
    // Original source identity: the sources rail renders the first archived
    // identity of a corrected source, so the projection is public surface.
    expect(surface.deriveOriginalIdentity).toBeDefined();
    // The item-level citation formatter it uses is an implementation detail of
    // the projection — app/** goes through formatCitation and
    // deriveOriginalIdentity only. The barrel comment says so; this is what
    // makes the claim binding rather than aspirational.
    expect(surface.formatCitationItem).toBeUndefined();
    expect(surface.applyExtractionOutput).toBeUndefined();
    expect(surface.startVerification).toBeDefined();
    expect(surface.getVerificationState).toBeDefined();
    expect(surface.getVerificationRun).toBeDefined();
    // Workbench epic: stage 1 as its own auto-runnable, LLM-free check.
    expect(surface.startExistenceCheck).toBeDefined();
    expect(surface.getOpenExistenceCheckCount).toBeDefined();
    // Reviewer-triggered re-verification: only the request use-case is
    // app-facing. Its eligibility predicate, its selection helper and the
    // shared eligible-status set stay internal — the app tier may ask for a
    // re-check, never re-implement who qualifies for one.
    expect(surface.requestClaimRecheck).toBeDefined();
    expect(surface.classifyRecheckEligibility).toBeUndefined();
    expect(surface.selectRequestedClaims).toBeUndefined();
    expect(surface.RECHECK_STATUSES).toBeUndefined();
    // RERUN-02: the sweep's preview joins it — the confirmation dialog
    // cannot itemise what it cannot count. The shared classification, the
    // scope-selection helper and the scope list stay internal for the same
    // reason as the predicate above: the app tier may ask what a rung
    // covers, never decide it.
    expect(surface.previewClaimRecheck).toBeDefined();
    expect(surface.classifyClaimForRecheck).toBeUndefined();
    expect(surface.selectClaimsForScope).toBeUndefined();
    expect(surface.RECHECK_SCOPES).toBeUndefined();
    // Workbench epic: the auto-chain drain queue's three app-facing
    // functions; the factory and the singleton-getter stay internal.
    expect(surface.enqueueSourceExtraction).toBeDefined();
    expect(surface.enqueueExistenceCheck).toBeDefined();
    expect(surface.enqueueReferenceScan).toBeDefined();
    expect(surface.pendingTriggerCount).toBeDefined();
    expect(surface.createAutoChain).toBeUndefined();
    // Reference auto-import: scan + per-candidate capture use-cases; the
    // regex/merge/Crossref/review internals stay internal. The batch
    // capture run and its volatile outcome projection are retired (source
    // work items): candidate captures queue as work items now, and their
    // failures are durable register events.
    expect(surface.startReferenceScan).toBeDefined();
    expect(surface.getReferenceScanState).toBeDefined();
    expect(surface.getReferenceScanRun).toBeDefined();
    expect(surface.enqueueCandidateCapture).toBeDefined();
    expect(surface.enqueueReadyCandidateCaptures).toBeDefined();
    expect(surface.startReferenceCapture).toBeUndefined();
    expect(surface.getReferenceCaptureRun).toBeUndefined();
    expect(surface.getReferenceCaptureOutcomes).toBeUndefined();
    expect(surface.getReferenceCandidates).toBeDefined();
    // The automatic post-publish captures are reached only through the
    // auto-chain: the item-building policy is not app-facing.
    expect(surface.buildAutoCaptureItems).toBeUndefined();
    // BibTeX support: a companion .bib is desugared into the footnote
    // convention at import. The rewrite runs INSIDE importBriefing /
    // publishBriefingRevision — the reader and the transform are not
    // app-facing, only the German report they produce is (and that is a
    // type, so it leaves no runtime surface here to assert).
    expect(surface.parseBibtex).toBeUndefined();
    expect(surface.bestIdentifier).toBeUndefined();
    expect(surface.desugarCitations).toBeUndefined();
    expect(surface.desugarBriefingCitations).toBeUndefined();
    expect(surface.scanRegex).toBeUndefined();
    expect(surface.mergeCandidates).toBeUndefined();
    expect(surface.candidateId).toBeUndefined();
    expect(surface.excludeCaptured).toBeUndefined();
    expect(surface.suggestSourceType).toBeUndefined();
    expect(surface.searchCrossref).toBeUndefined();
    expect(surface.scoreMatch).toBeUndefined();
    expect(surface.titleSimilarity).toBeUndefined();
    expect(surface.buildCandidateReview).toBeUndefined();
    expect(surface.deriveReferenceScanState).toBeUndefined();
    // TMB-5: adjudication, repair, history and snapshot use-cases.
    expect(surface.getBriefingViewModel).toBeDefined();
    expect(surface.buildAdjudicationQueue).toBeDefined();
    expect(surface.buildEvidenceDisplayMap).toBeDefined();
    expect(surface.buildTimeline).toBeDefined();
    expect(surface.decideClaim).toBeDefined();
    expect(surface.proposeRepair).toBeDefined();
    expect(surface.applyRepair).toBeDefined();
    expect(surface.discardClaim).toBeDefined();
    // Verdict-driven repair: suggestions (derive/dismiss) and the backfill
    // enqueue are app-facing; the evaluator, the eligibility derivation and
    // the shared critique/job builders run only off the auto-chain (or
    // inside proposeRepair) and stay internal.
    expect(surface.deriveOpenClaimRepairSuggestions).toBeDefined();
    expect(surface.dismissClaimRepairSuggestion).toBeDefined();
    expect(surface.enqueueClaimRepairEvaluations).toBeDefined();
    expect(surface.evaluateClaimRepair).toBeUndefined();
    expect(surface.claimsEligibleForRepairSuggestion).toBeUndefined();
    expect(surface.buildRepairCritique).toBeUndefined();
    expect(surface.buildRepairJob).toBeUndefined();
    // Workbench epic: the two manual anchor repairs; their paragraph
    // resolution helpers stay internal.
    expect(surface.repairClaimAnchor).toBeDefined();
    expect(surface.repairBriefingPassage).toBeDefined();
    expect(surface.anchorIndex).toBeUndefined();
    expect(surface.getProjectBlob).toBeDefined();
    expect(surface.getChainVerification).toBeDefined();
    // TMB-41: derived export accessors; the pure builders stay internal.
    expect(surface.getReferencesCsl).toBeDefined();
    expect(surface.getProvDocument).toBeDefined();
    expect(surface.getTracesAggregate).toBeDefined();
    expect(surface.summarizeTraces).toBeDefined();
    expect(surface.buildReferencesCsl).toBeUndefined();
    expect(surface.buildProvDocument).toBeUndefined();
    expect(surface.buildTracesAggregate).toBeUndefined();
    // TMB-45: metrics accessor and CSV serialization.
    expect(surface.getProjectMetrics).toBeDefined();
    expect(surface.metricsToCsv).toBeDefined();
    // TMB-47: first-run setup use-cases; identity internals stay behind
    // lib/identity (the pipeline barrel never re-exports them).
    expect(surface.isSetupComplete).toBeDefined();
    expect(surface.completeFirstRunSetup).toBeDefined();
    expect(surface.writeIdentityConfig).toBeUndefined();
    expect(surface.isIdentityConfigured).toBeUndefined();
    // Reference auto-import (Task 3b/Amendment 2): the Unpaywall setting
    // read accessor and its write use-case; the raw identity write helper
    // stays internal.
    expect(surface.getUnpaywallSetting).toBeDefined();
    expect(surface.setUnpaywallEmail).toBeDefined();
    expect(surface.writeUnpaywallEmail).toBeUndefined();
    // TMB-54 (D5): the workspace root read accessor and its first-run-only
    // write use-case; the identity writer stays internal.
    expect(surface.getWorkspaceRootSetting).toBeDefined();
    expect(surface.setWorkspaceRoot).toBeDefined();
    expect(surface.writeWorkspaceRoot).toBeUndefined();
    // TMB-54 (D6): the actor handle accessor and its update use-case; the
    // identity writer and the handle validator stay internal.
    expect(surface.getActorHandleSetting).toBeDefined();
    expect(surface.updateActorHandle).toBeDefined();
    expect(surface.isValidActorHandle).toBeUndefined();
    // TMB-49: backend preflight accessors; probe mechanics and the run
    // precondition seam stay internal.
    expect(surface.getBackendsHealth).toBeDefined();
    expect(surface.runLoginProbe).toBeDefined();
    expect(surface.probeBackendUsable).toBeUndefined();
    expect(surface.withoutSecondaryBackend).toBeUndefined();
    // TMB-54 (D7): installation-level diagnosis, no project required.
    expect(surface.getInstallationBackendsHealth).toBeDefined();
    expect(surface.runInstallationLoginProbe).toBeDefined();
    // Excludes the always-usable demo backend from "is any real backend
    // ready", so the empty-state onboarding warning can actually fire.
    expect(surface.usableRealBackends).toBeDefined();
    // TMB-51: the UI's flag accessor; family mapping and allowlist stay
    // internal.
    expect(surface.isApiBackendEnabled).toBeDefined();
    expect(surface.modelFamilyOf).toBeUndefined();
    expect(surface.knownModelFamilyOf).toBeUndefined();
    expect(surface.allowedBackendClis).toBeUndefined();
    // TMB-54: the demo-project badge predicate. The backend id constant it
    // compares against stays internal — the web layer asks the question,
    // it does not re-implement it.
    expect(surface.isDemoProject).toBeDefined();
    expect(surface.DEMO_BACKEND_CLI).toBeUndefined();
    // TMB-54: the example project use-case and the fixed id the UI needs to
    // link to it. The seeding actors stay internal.
    expect(surface.createDemoProject).toBeDefined();
    expect(surface.DEMO_PROJECT_ID).toBeDefined();
    // TMB-55: in-app initial research. The run use-case, its state and the
    // independence finding are public; the provenance-prefix parsing and
    // the state derivation stay internal.
    expect(surface.startResearch).toBeDefined();
    expect(surface.getResearchState).toBeDefined();
    expect(surface.getResearchRun).toBeDefined();
    expect(surface.getBriefingIndependence).toBeDefined();
    expect(surface.researchBackendOf).toBeUndefined();
    expect(surface.deriveResearchState).toBeUndefined();
    expect(surface.RESEARCH_TOOL_PREFIX).toBeUndefined();
    // TMB-46: settings use-case; diff formatter and backends builder stay
    // internal.
    expect(surface.updateProjectConfig).toBeDefined();
    expect(surface.describeConfigChanges).toBeUndefined();
    expect(surface.buildBackendsConfig).toBeUndefined();
    // TMB-39: the bundle download use-case; assembly stays internal.
    expect(surface.exportProjectBundle).toBeDefined();
    expect(surface.buildExportFilename).toBeUndefined();
    // TMB-40: bundle import (verify in memory, then materialize).
    expect(surface.importProjectBundle).toBeDefined();
    // Repair internals stay internal: the re-entry rule and cycle count are
    // reachable only through applyRepair.
    expect(surface.decideReEntry).toBeUndefined();
    expect(surface.countRepairCycles).toBeUndefined();
    // Verification internals stay internal: stage checkers, rubric rules,
    // aggregation and the sample draw are reachable only through the run.
    expect(surface.pickUnfinishedClaims).toBeUndefined();
    expect(surface.checkClaimExistence).toBeUndefined();
    expect(surface.runAttributionAndRubric).toBeUndefined();
    expect(surface.aggregateSupportDegree).toBeUndefined();
    expect(surface.loadRubricRuleSet).toBeUndefined();
    expect(surface.evaluateMechanicalRubric).toBeUndefined();
    expect(surface.drawSample).toBeUndefined();
    // Network access stays behind the fetcher port; the production fetcher
    // is wired internally, not part of the public surface.
    expect(surface.nodeHttpFetcher).toBeUndefined();
    // Runs start only through the use-cases, never by driving the runner
    // or the orchestrator wiring directly from the web layer.
    expect(surface.getGlobalJobRunner).toBeUndefined();
    expect(surface.createJobRunner).toBeUndefined();
    // TMB-50: cooperative run control is a use-case, the runner stays
    // internal.
    expect(surface.pauseRun).toBeDefined();
    expect(surface.resumeRun).toBeDefined();
    expect(surface.cancelRun).toBeDefined();
    // Runner UI: project-level status truth. The live run handle stays
    // internal — the kind-agnostic status stream route that used to need it
    // is gone, and the unified event stream attaches to runs itself.
    expect(surface.getActiveRun).toBeDefined();
    expect(surface.getActiveRunHandle).toBeUndefined();
    // Workbench epic: the unified project event stream the single SSE route
    // consumes. The runner's run-start announcement stays internal — even
    // its project-filtered wrapper is not on the surface, because the route
    // never needs to drive attachment itself.
    expect(surface.streamProjectRunEvents).toBeDefined();
    expect(surface.subscribeProjectRunStarts).toBeUndefined();
    // Run visibility: the unified activity surface. One truth for "what
    // occupies this project" (runner run OR off-runner chain trigger), one
    // cancel that reaches either, a descriptor for blocked-action messages,
    // queued work removable, interrupted work derivable and retryable. The
    // ledgers themselves stay internal — the app never touches them.
    expect(surface.getProjectActivity).toBeDefined();
    expect(surface.cancelActivity).toBeDefined();
    expect(surface.describeBlockingActivity).toBeDefined();
    expect(surface.removeQueuedCapture).toBeDefined();
    expect(surface.retryInterruptedCapture).toBeDefined();
    expect(surface.deriveInterruptedCaptureAttempts).toBeDefined();
    expect(surface.deriveOpenChainTriggers).toBeDefined();
    expect(surface.getGlobalActivityLedger).toBeUndefined();
    expect(surface.createActivityLedger).toBeUndefined();
    expect(surface.openTriggerBracket).toBeUndefined();
    expect(surface.closeTriggerBracket).toBeUndefined();
  });
});

describe("module boundaries", () => {
  const domainFiles = [...sourceFiles("lib"), ...sourceFiles("cli")];

  it("finds domain sources to scan (guard against silent renames)", () => {
    expect(domainFiles.length).toBeGreaterThan(20);
  });

  it("keeps the domain core free of app/ imports", () => {
    for (const file of domainFiles) {
      expect(read(file), file).not.toMatch(/from\s+["'][^"']*\bapp\//);
    }
  });

  it("confines process.env access to lib/identity", () => {
    for (const file of domainFiles) {
      if (file.startsWith(path.join("lib", "identity"))) {
        continue;
      }
      expect(read(file), file).not.toContain("process.env");
    }
  });

  it("keeps chain and projection modules free of filesystem access (pure)", () => {
    const pureDirs = [
      path.join("lib", "register", "chain"),
      path.join("lib", "register", "projection"),
      // Shared normal form of TMB-24's extraction and TMB-4's stage 1 —
      // trustworthy exactly because it stays pure.
      path.join("lib", "register", "text"),
    ];
    for (const file of domainFiles) {
      if (pureDirs.some((dir) => file.startsWith(dir))) {
        expect(read(file), file).not.toMatch(/["']node:fs["']/);
      }
    }
  });

  it("allows raw file writes only inside the sanctioned write sites", () => {
    const allowed = [
      path.join("lib", "register", "persistence", "atomic-write.ts"),
      // TMB-47: identity's config-file writer is the SECOND sanctioned
      // site. It cannot reuse the register's atomic-write helper because
      // lib/register depends on lib/identity — the import would invert the
      // layering, so the few lines are deliberately duplicated there.
      path.join("lib", "identity", "config-file.ts"),
    ];
    for (const file of domainFiles) {
      if (allowed.includes(file)) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /fs\.(writeFileSync|appendFileSync|createWriteStream)\(/,
      );
    }
  });

  it("confines workspace/project path resolution to its sanctioned callers", () => {
    // TMB-47 acceptance: outside lib/identity no module resolves the
    // workspace root or project paths on its own. The two read-side
    // authorities (store lookup, project listing) and the import target
    // resolution are the pinned exceptions; everything else receives
    // directories from them.
    const allowed = [
      path.join("lib", "register", "persistence", "store.ts"),
      path.join("lib", "pipeline", "projects.ts"),
      path.join("lib", "pipeline", "export", "import-bundle.ts"),
      path.join("lib", "pipeline", "setup.ts"),
    ];
    for (const file of domainFiles) {
      if (
        file.startsWith(path.join("lib", "identity")) ||
        allowed.includes(file)
      ) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /getWorkspaceRoot\(|resolveProjectDir\(/,
      );
    }
  });

  it("confines network access to the sanctioned http implementations", () => {
    const allowed = [
      // The one production implementation …
      path.join("lib", "pipeline", "sources", "node-http-fetcher.ts"),
      // … its port declaration (interface method named fetch) …
      path.join("lib", "pipeline", "sources", "fetch-port.ts"),
      // TMB-51: the adapter layer's own HTTP port for API-based backends —
      // the transport twin of the single child-process spawn site.
      path.join("lib", "adapters", "runtime", "node-fetch-http-port.ts"),
    ];
    for (const file of domainFiles) {
      // … and test doubles implementing the port.
      if (allowed.includes(file) || file.includes("__fixtures__")) {
        continue;
      }
      // Bare global fetch(...) only; calls through the HttpFetcher port
      // (fetcher.fetch(...)) are exactly the sanctioned indirection.
      expect(read(file), file).not.toMatch(/(?<![.\w])fetch\(/);
    }
  });

  it("confines child-process spawning to the adapter process runner", () => {
    const allowed = path.join(
      "lib",
      "adapters",
      "runtime",
      "node-process-runner.ts",
    );
    for (const file of domainFiles) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(/["']node:child_process["']/);
    }
  });

  it("confines the fflate dependency to the bundle core's zip wrapper", () => {
    // Same pattern as the network/child-process confinement: the ZIP format
    // has exactly one implementation site (TMB-6).
    const allowed = path.join("lib", "export", "zip.ts");
    for (const file of domainFiles) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(/["']fflate["']/);
    }
  });

  it("keeps the bundle core (lib/export) off the use-case and adapter layers", () => {
    // lib/export is domain core beside lib/register: usable by the CLI
    // without pulling in lib/pipeline (job runner, orchestrator, Next.js
    // concerns) or lib/adapters. It may only use the register's public
    // barrel — never its write internals, with ONE ratified exception
    // mirroring the trace sink (TMB-20): the bundle materializer reuses the
    // sanctioned atomic-write site instead of duplicating it (TMB-40).
    const allowedAtomicWrite = path.join("lib", "export", "write-bundle.ts");
    for (const file of sourceFiles(path.join("lib", "export"))) {
      const content = read(file);
      expect(content, file).not.toMatch(/from\s+["'][^"']*\bpipeline\//);
      expect(content, file).not.toMatch(/from\s+["'][^"']*\badapters\//);
      if (file === allowedAtomicWrite) {
        expect(content, file).not.toMatch(
          /from\s+["'][^"']*register\/(statemachine|chain)\//,
        );
        continue;
      }
      expect(content, file).not.toMatch(
        /from\s+["'][^"']*register\/(persistence|statemachine|chain)\//,
      );
    }
  });

  it("keeps the CLI on the domain core (register + bundle core only)", () => {
    // The standalone CLI works without the web application: the PUBLIC
    // barrels of lib/register and lib/export are its whole world — never
    // lib/pipeline (job runner, orchestration, Next.js concerns),
    // lib/adapters, app/, or register sub-barrels (lib/register/chain
    // exposes the ChainAppender the top-level barrel deliberately hides).
    // Ratified with TMB-42, previously an undocumented convention.
    for (const file of sourceFiles("cli")) {
      const content = read(file);
      for (const match of content.matchAll(
        /from\s+["'](\.\.\/lib\/[^"']+)["']/g,
      )) {
        expect(
          ["../lib/register", "../lib/export"].includes(match[1]),
          `${file} imports ${match[1]} — the CLI may only use the public barrels ../lib/register and ../lib/export`,
        ).toBe(true);
      }
    }
  });

  it("keeps the adapter layer off the register's write internals", () => {
    // The trace sink's atomic-write deep import is the single ratified
    // exception (TMB-20): reusing the one sanctioned raw-write site instead
    // of duplicating it. Everything else in lib/adapters may only use the
    // register's public schema surface.
    const allowed = path.join("lib", "adapters", "runtime", "trace-sink.ts");
    for (const file of sourceFiles(path.join("lib", "adapters"))) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /register\/(persistence|statemachine|chain)\//,
      );
    }
  });
});

describe("web-layer boundary", () => {
  /** All app/ sources incl. .tsx (sourceFiles only collects .ts). */
  function appSourceFiles(): string[] {
    const absolute = path.join(repoRoot, "app");
    return fs
      .readdirSync(absolute, { recursive: true, encoding: "utf8" })
      .filter(
        (name) =>
          (name.endsWith(".ts") || name.endsWith(".tsx")) &&
          !name.endsWith(".test.ts"),
      )
      .map((name) => path.join("app", name));
  }

  it("keeps runtime imports on the pipeline barrel (pinned deep imports)", () => {
    // Pure, node:fs-free modules that CLIENT components must deep-import
    // because the barrel transitively pulls node:fs. Every other runtime
    // import from lib/ goes through @/lib/pipeline; type-only imports are
    // erased at build time and free (label maps import types from
    // @/lib/register).
    const allowedRuntime = new Set([
      "@/lib/pipeline",
      "@/lib/pipeline/adjudication/effort-timer",
      "@/lib/pipeline/ids",
    ]);
    const files = appSourceFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = read(file);
      for (const match of content.matchAll(
        /import\s+(type\s+)?[^;]*?from\s+["'](@\/lib\/[^"']+)["']/g,
      )) {
        if (match[1] !== undefined) {
          continue; // type-only import
        }
        expect(
          allowedRuntime.has(match[2]),
          `${file} imports ${match[2]} at runtime — use the @/lib/pipeline barrel or pin a new pure deep import here`,
        ).toBe(true);
      }
    }
  });
});

describe("status model transition table", () => {
  it("matches the ratified edge set exactly (change requires touching both places)", () => {
    const edges = TRANSITIONS.map((def) => ({
      from: def.from,
      to: def.to,
      actorKind: def.actorKind,
      decision: def.decision ?? null,
    }));
    expect(edges).toEqual([
      { from: null, to: "captured", actorKind: "system", decision: null },
      {
        from: null,
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      {
        from: "captured",
        to: "existence_checked",
        actorKind: "system",
        decision: null,
      },
      {
        from: "captured",
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      {
        from: "existence_checked",
        to: "prechecked",
        actorKind: "system",
        decision: null,
      },
      // Ratified with TMB-19: adapter-failure escalation instead of a claim
      // stuck in existence_checked (see transitions.ts for the rationale).
      {
        from: "existence_checked",
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      {
        from: "prechecked",
        to: "auto_confirmed",
        actorKind: "system",
        decision: null,
      },
      {
        from: "prechecked",
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      {
        from: "auto_confirmed",
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      {
        from: "pending_adjudication",
        to: "confirmed",
        actorKind: "human",
        decision: "category_null",
      },
      {
        from: "pending_adjudication",
        to: "contested",
        actorKind: "human",
        decision: "category_required",
      },
      {
        from: "contested",
        to: "revised",
        actorKind: "system",
        decision: null,
      },
      {
        from: "contested",
        to: "revised",
        actorKind: "human",
        decision: null,
      },
      // Ratified with the verdict-driven repair: a machine-parked claim
      // with a repairable routing takes the repair edge without a
      // complaint (gate: routedRepairable); discard stays contested-only.
      {
        from: "pending_adjudication",
        to: "revised",
        actorKind: "human",
        decision: null,
      },
      {
        from: "contested",
        to: "discarded",
        actorKind: "human",
        decision: "optional",
      },
      {
        from: "revised",
        to: "captured",
        actorKind: "system",
        decision: null,
      },
      {
        from: "revised",
        to: "existence_checked",
        actorKind: "system",
        decision: null,
      },
      {
        from: "revised",
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      // Ratified with TMB-7: warm-run adoption creates claims directly in
      // their settled origin status (gate: provenance.origin_project_id).
      { from: null, to: "confirmed", actorKind: "system", decision: null },
      {
        from: null,
        to: "auto_confirmed",
        actorKind: "system",
        decision: null,
      },
      { from: null, to: "discarded", actorKind: "system", decision: null },
      // Ratified with TMB-43: negative relevance of an adopted claim.
      {
        from: "confirmed",
        to: "pending_adjudication",
        actorKind: "system",
        decision: null,
      },
      // Ratified with TMB-44: source revision reopens settled claims.
      {
        from: "existence_checked",
        to: "recheck_required",
        actorKind: "system",
        decision: null,
      },
      {
        from: "prechecked",
        to: "recheck_required",
        actorKind: "system",
        decision: null,
      },
      {
        from: "auto_confirmed",
        to: "recheck_required",
        actorKind: "system",
        decision: null,
      },
      {
        from: "confirmed",
        to: "recheck_required",
        actorKind: "system",
        decision: null,
      },
      // Ratified with the source correction: an identity correction readmits
      // claims that adjudication only holds because of a failed existence
      // check (gate: latest routing === existence_check_failed).
      {
        from: "pending_adjudication",
        to: "recheck_required",
        actorKind: "system",
        decision: null,
      },
      {
        from: "recheck_required",
        to: "captured",
        actorKind: "system",
        decision: null,
      },
    ]);
  });

  it("keeps discarded outgoing-terminal and confirmed reopenable only by TMB-7's system edges", () => {
    // Since TMB-7 confirmed is settled, not eternal: exactly two
    // narrowly-scoped system edges reopen it (source revision → recheck,
    // negative warm-run relevance → adjudication). discarded stays fully
    // terminal, and a discard is still never directly reachable from
    // adjudication (repair is offered first).
    expect(
      TRANSITIONS.filter((def) => def.from === "confirmed").map((def) => ({
        to: def.to,
        actorKind: def.actorKind,
      })),
    ).toEqual([
      { to: "pending_adjudication", actorKind: "system" },
      { to: "recheck_required", actorKind: "system" },
    ]);
    expect(TRANSITIONS.filter((def) => def.from === "discarded")).toHaveLength(
      0,
    );
    expect(
      TRANSITIONS.filter(
        (def) => def.from === "pending_adjudication" && def.to === "discarded",
      ),
    ).toHaveLength(0);
  });

  it("has no duplicate (from, to, actorKind) triple (findTransition first-match trap)", () => {
    const seen = new Set<string>();
    for (const def of TRANSITIONS) {
      const key = `${def.from}→${def.to}:${def.actorKind}`;
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe("committed artifacts", () => {
  it("keeps the generated JSON Schema at the repo root", () => {
    expect(
      fs.existsSync(path.join(repoRoot, "schema", "claims.schema.json")),
    ).toBe(true);
  });
});

"use server";

import { revalidatePath } from "next/cache";

import { runPipelineAction } from "@/app/lib/pipeline-action";
import {
  discardBriefingDraft,
  enqueueAnchorRepair,
  enqueueReferenceScan,
  enqueueSourceExtraction,
  getBriefing,
  publishBriefingRevision,
  readProject,
  saveBriefingDraft,
  startSourceExtraction,
  startUnevidencedExtraction,
  startVerification,
} from "@/lib/pipeline";
import type { CitationRewriteReport } from "@/lib/pipeline";

/**
 * Server actions of the unified workbench. Everything the page mutates goes
 * through here, and every one of them revalidates the SAME path — the
 * workbench IS the project page now, so there is no per-step route left to
 * target.
 *
 * Source capture and revision deliberately keep living in
 * `../sources/actions.ts` beside the forms that are their only callers: they
 * already enqueue the auto-chain after a durable success, and duplicating
 * them here would mean two call sites racing to enqueue the same follow-up
 * pass.
 */

/** Every action below re-renders the workbench, nothing else. */
function revalidateWorkbench(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
}

export interface DraftSaveState {
  error: string | null;
  savedAt?: string;
}

/**
 * Stores the briefing editor's current text as the project's draft. Called
 * directly (debounced) from the editor rather than through a form, and
 * deliberately WITHOUT revalidation: the draft is scratch state outside the
 * register, and re-rendering the server tree on every keystroke pause would
 * fight the textarea the user is typing in.
 */
export async function saveBriefingDraftAction(
  projectId: string,
  text: string,
): Promise<DraftSaveState> {
  const result = await runPipelineAction(() =>
    saveBriefingDraft(projectId, text),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  return { error: null, savedAt: result.value.saved_at };
}

export interface BriefingFormState {
  error: string | null;
  published?: boolean;
  discarded?: boolean;
  /** BibTeX support: what the companion `.bib` did to the submitted text —
   * present only when one was uploaded. */
  citationReport?: CitationRewriteReport;
}

/** The companion BibTeX file of a briefing submit, if one was chosen. An
 * empty file input still arrives as a zero-byte File, which is why the size
 * is checked rather than mere presence. */
async function parseBibliography(
  formData: FormData,
): Promise<string | undefined> {
  const file = formData.get("bibliography");
  if (file instanceof File && file.size > 0) {
    return file.text();
  }
  return undefined;
}

/**
 * Re-triggers the extraction pass of every source the project already has,
 * after its FIRST briefing arrived. Capturing a source always enqueues its
 * pass (`../sources/actions.ts`), but on a briefing-less project that pass
 * fails its precondition and the auto-chain drops it with a warning — by
 * contract, since a dropped trigger costs a moment of automation, not data.
 * Nothing re-triggered those sources once the briefing was imported, which
 * is the one moment where the whole backlog becomes runnable at once.
 *
 * Wiring, deliberately in the app layer: the pipeline use-case stays free of
 * run side effects, exactly like capture and revision, which enqueue from
 * their actions rather than from `captureSource`/`reviseSource`.
 *
 * Enqueuing per source is safe even for a source whose pass somehow did run:
 * the chain coalesces consecutive identical triggers, and a repeated pass
 * merges into the existing claims instead of duplicating them.
 */
async function backfillSourceExtractions(projectId: string): Promise<void> {
  const register = await readProject(projectId);
  for (const source of register.sources) {
    enqueueSourceExtraction(projectId, source.id);
  }
}

/**
 * Publishes the editor's text as the briefing's next revision — or, for a
 * project without a briefing yet, as the initial import (the pipeline
 * use-case decides, and requires the tool name only on that path). Only that
 * initial import backfills the extraction passes that were dropped while the
 * project had no briefing; an ordinary revision (2, 3, …) must not re-run
 * every source.
 *
 * Every publish that CHANGED the briefing additionally starts the reference
 * chain: scan the new text for the sources it cites, capture the ones that
 * resolved cleanly, and let those captures chain their own extraction. A
 * briefing therefore arrives with its bibliography and its first claims by
 * itself — before this, a freshly imported briefing sat in front of an empty
 * source list, produced no claims, and the workbench reported that nothing
 * was waiting for adjudication, which read like a verdict rather than like
 * work not yet started.
 */
export async function publishBriefingRevisionAction(
  projectId: string,
  _previous: BriefingFormState,
  formData: FormData,
): Promise<BriefingFormState> {
  const text = String(formData.get("text") ?? "");
  const tool = String(formData.get("tool") ?? "").trim();
  const bibliography = await parseBibliography(formData);
  const result = await runPipelineAction(async () => {
    // Asked BEFORE publishing, inside the same error policy: afterwards a
    // briefing always exists. The published revision cannot answer it
    // either — revision 1 is stored as an absent field, so a checksum no-op
    // republish of a live revision 1 looks exactly like a fresh import.
    const before = await getBriefing(projectId);
    const published = await publishBriefingRevision(projectId, {
      text,
      ...(tool.length > 0 ? { tool } : {}),
      ...(bibliography !== undefined ? { bibliography } : {}),
    });
    const initialImport = before === null;
    // Republishing checksum-identical text is a total no-op inside the
    // use-case — no revision, no event, no register write. The text a scan
    // would read is then the text the last scan already read, so re-running
    // it would only spend Crossref and LLM quota on the same answer.
    const changed = initialImport || published.sha256 !== before.meta.sha256;
    return {
      initialImport,
      changed,
      citationReport: published.citationRewrite,
    };
  });
  if (result.error !== null) {
    return { error: result.error };
  }
  if (result.value.initialImport) {
    await backfillSourceExtractions(projectId);
  }
  if (result.value.changed) {
    enqueueReferenceScan(projectId);
    // Anchor auto-repair: quotes the revision moved beyond the silent
    // exact remap's reach get one bounded fuzzy attempt.
    enqueueAnchorRepair(projectId);
  }
  revalidateWorkbench(projectId);
  return {
    error: null,
    published: true,
    ...(result.value.citationReport
      ? { citationReport: result.value.citationReport }
      : {}),
  };
}

/** Throws the draft away; the frozen briefing is untouched by it anyway. */
export async function discardBriefingDraftAction(
  projectId: string,
  _previous: BriefingFormState,
  _formData: FormData,
): Promise<BriefingFormState> {
  const result = await runPipelineAction(() => discardBriefingDraft(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null, discarded: true };
}

/** Run starts report only failure: whether a run is live is answered by the
 * shared project event stream, not by a stale action result. A `started`
 * flag here would go stale the moment the run ends and could not be told
 * apart from "still running" without a second latch. */
export interface RunFormState {
  error: string | null;
}

/** The sweep for claims citing no captured source — the one extraction pass
 * that belongs to no single source (the per-source passes auto-chain from a
 * capture, or are re-run from the source's own row). */
export async function startUnevidencedExtractionAction(
  projectId: string,
  _previous: RunFormState,
  _formData: FormData,
): Promise<RunFormState> {
  const result = await runPipelineAction(() =>
    startUnevidencedExtraction(projectId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null };
}

/** Re-runs the extraction pass for one source — the manual counterpart of
 * the pass the auto-chain starts after a capture (a revised source, or a
 * pass that failed, needs one without re-capturing). */
export async function startSourceExtractionAction(
  projectId: string,
  sourceId: string,
  _previous: RunFormState,
  _formData: FormData,
): Promise<RunFormState> {
  const result = await runPipelineAction(() =>
    startSourceExtraction(projectId, sourceId),
  );
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null };
}

/** Stages 2 and 3 (attribution + calibration) over the open claims. */
export async function startVerificationAction(
  projectId: string,
  _previous: RunFormState,
  _formData: FormData,
): Promise<RunFormState> {
  const result = await runPipelineAction(() => startVerification(projectId));
  if (result.error !== null) {
    return { error: result.error };
  }
  revalidateWorkbench(projectId);
  return { error: null };
}

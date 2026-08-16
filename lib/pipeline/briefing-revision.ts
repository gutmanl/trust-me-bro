import { getCurrentActor } from "../identity";
import type { ActorId } from "../identity";
import type { BriefingDraft, BriefingImport } from "../register";
import { sha256Hex, splitBriefingParagraphs } from "../register";
import { computeReanchorUpdates } from "./briefing-reanchor";
import { importBriefing } from "./briefing";
import {
  BriefingRevisionPreconditionError,
  InvalidBriefingInputError,
  RunActiveError,
} from "./errors";
import { requireProjectStore } from "./projects";
import { briefingRenderContext } from "./research/independence";
import { describeBlockingActivity } from "./runs/control";
import { getGlobalJobRunner } from "./runs/job-runner";

export type { BriefingDraft };

/** The revision the workbench's draft would be published on top of: 0
 * before any briefing exists, otherwise the current briefing's revision
 * (absence of the field means revision 1, mirroring `BriefingImport`). */
function currentRevision(briefing: BriefingImport | undefined): number {
  if (!briefing) {
    return 0;
  }
  return briefing.revision ?? 1;
}

/**
 * Saves (overwrites) the workbench's briefing draft for a project — scratch
 * storage outside the register, so editing does not touch the append-only
 * chain until the user actually publishes (publishBriefingRevision).
 */
export async function saveBriefingDraft(
  projectId: string,
  text: string,
): Promise<BriefingDraft> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  store.saveDraft(text, currentRevision(register.project.briefing_import));
  // Re-read rather than constructing the record locally: the store owns the
  // saved_at timestamp, so this keeps that single source of truth. The
  // write above is synchronous and just succeeded, so the read-back cannot
  // legitimately come back null here.
  return store.readDraft() as BriefingDraft;
}

/** The project's saved draft, or null when there is none. */
export async function getBriefingDraft(
  projectId: string,
): Promise<BriefingDraft | null> {
  return requireProjectStore(projectId).readDraft();
}

/** Discards the project's saved draft, if any. */
export async function discardBriefingDraft(projectId: string): Promise<void> {
  requireProjectStore(projectId).clearDraft();
}

export interface PublishBriefingRevisionInput {
  /** Text to publish; the saved draft's text when omitted. */
  text?: string;
  /** Generating tool — required only when the project has no briefing yet
   * (the initial-import path). A revision of an existing briefing keeps the
   * prior import's tool verbatim; a value given here is ignored on that
   * path. */
  tool?: string;
  /** German reason recorded on the `briefing_revised` event. Defaults to the
   * plain workbench wording; callers that revise on behalf of something more
   * specific (the passage repair, which names its claim) pass their own.
   * Ignored on the initial-import path, which records its own event. */
  reason?: string;
  /** Actor recorded on the revision — defaults to the current human actor.
   * The automatic briefing substitution (automatic repair) passes its
   * system token, so a mechanical revision is never misattributed to a
   * person. Ignored on the initial-import path. */
  actor?: ActorId;
}

/**
 * Publishes workbench text as the briefing's next revision (workbench
 * epic) — or, when the project has no briefing yet, as the initial import
 * via `importBriefing` (so the reserved research-tool-prefix guard still
 * applies; this never calls `freezeBriefing` directly).
 *
 * The impure work — reading the register, hashing the candidate text,
 * storing the new blob — runs BEFORE the single transaction. The re-anchor
 * computation itself is pure (computeReanchorUpdates) and deliberately runs
 * INSIDE the transaction, against the mutator's own fresh `tx.listClaims()`
 * rather than the earlier register read: that closes the TOCTOU window a
 * concurrent claim write could open between the preparatory read and the
 * commit. The transaction then does exactly two kinds of write:
 * `reviseBriefing` (the one evented, audited change) and, per moved claim, a
 * silent `remapClaimAnchor` (mechanical, no event of its own — the enclosing
 * transaction's state root covers it). No claim status ever changes here.
 *
 * Checksum-identical text is a no-op: the current BriefingImport is
 * returned unchanged and no transaction runs — but the draft is still
 * cleared, since publishing text identical to what is already live makes
 * the draft redundant regardless.
 *
 * Refuses while a run is active for the project (RunActiveError), mirroring
 * `reviseSource`'s guard: a run caches state at its start, and a
 * concurrent revision would let it silently validate against superseded
 * wording/anchors.
 */
export async function publishBriefingRevision(
  projectId: string,
  input: PublishBriefingRevisionInput,
): Promise<BriefingImport> {
  if (getGlobalJobRunner().isRunning(projectId)) {
    const blocking = describeBlockingActivity(projectId);
    throw new RunActiveError(projectId, blocking);
  }
  const store = requireProjectStore(projectId);
  const draft = store.readDraft();
  const text = input.text ?? draft?.text;
  if (text === undefined || text.trim().length === 0) {
    throw new BriefingRevisionPreconditionError(
      "Die überarbeitete Fassung darf nicht leer sein.",
    );
  }

  const register = await store.read();
  const current = register.project.briefing_import;

  if (!current) {
    const tool = input.tool?.trim();
    if (!tool) {
      throw new InvalidBriefingInputError(
        "Bitte das erzeugende Werkzeug angeben (z. B. den Namen des Deep-Research-Tools).",
      );
    }
    const result = await importBriefing({ projectId, content: text, tool });
    store.clearDraft();
    return result;
  }

  const sha256 = sha256Hex(text);
  if (sha256 === current.sha256) {
    // Recognized via checksum, deliberately a total no-op: no revision
    // bump, no event, no re-anchor pass, no register write at all.
    store.clearDraft();
    return current;
  }

  const blob = store.blobs().put(text, "md");
  const briefingImport = await store.transaction((tx) => {
    tx.reviseBriefing({
      sha256: blob.sha256,
      blob_path: blob.blobPath,
      tool: current.tool,
      actor: input.actor ?? getCurrentActor(),
      reason: input.reason ?? "Briefing überarbeitet (Arbeitsbereich).",
    });
    // Deliberately computed here, not from the register read above: it is
    // pure (no I/O), and running it against tx.listClaims() — the claim
    // list as of THIS transaction, under the project lock — means a claim
    // written concurrently between the earlier read and this commit is
    // still seen and re-anchored. Only the blob put (I/O) had to stay
    // outside; this computation does not.
    const updates = computeReanchorUpdates(
      splitBriefingParagraphs(text),
      tx.listClaims(),
    );
    for (const update of updates) {
      tx.remapClaimAnchor(update.claimId, {
        anchor: update.anchor,
        quote: update.quote,
      });
    }
    return tx.getProject().briefing_import as BriefingImport;
  });

  await store.renderBriefingFile(briefingRenderContext(await store.read()));
  store.clearDraft();
  return briefingImport;
}

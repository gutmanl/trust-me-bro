import { getCurrentActor } from "../../identity";
import {
  buildBriefingViewModel,
  containsNormalized,
  splitBriefingParagraphs,
} from "../../register";
import type { BriefingImport, ClaimsRegister } from "../../register";
import { publishBriefingRevision } from "../briefing-revision";
import { AnchorPreconditionError } from "../errors";
import { requireProjectStore } from "../projects";

/**
 * The two manual anchor repairs the workbench offers beside the wording
 * repair (workbench epic). Both start from the same observation — the
 * briefing text and a claim's anchor disagree — and differ in which side the
 * reviewer decides is wrong:
 *
 * - `repairClaimAnchor`: the TEXT is right, the anchor drifted. Re-points the
 *   claim at the paragraph the reviewer picked, as an audited
 *   `claim_anchor_revised` event.
 * - `repairBriefingPassage`: the ANCHOR is right, the passage is wrong.
 *   Rewrites that one paragraph and publishes the result as an ordinary
 *   briefing revision — whose silent re-anchor pass then moves every claim
 *   whose quote shifted, so no separate anchor event is needed here.
 *
 * Neither touches `claim.status`: an anchor correction is not a verification
 * outcome, and a contested claim goes on through its normal repair re-entry.
 */

/** Where a claim should point after the correction. */
export interface RepairClaimAnchorInput {
  /** Target paragraph in the `p<N>` anchor convention (1-based). */
  anchor: string;
  /** Verbatim wording the anchor is bound to; must occur in that paragraph. */
  quote: string;
}

interface BriefingContext {
  briefing: BriefingImport;
  register: ClaimsRegister;
  text: string;
  paragraphs: string[];
}

/** Reads the frozen briefing plus the register, refusing in German when
 * either the briefing or the addressed claim is missing. Impure (register
 * read + blob read) and therefore deliberately outside any transaction. */
async function readBriefingContext(
  projectId: string,
  claimId: string,
): Promise<BriefingContext> {
  const store = requireProjectStore(projectId);
  const register = await store.read();
  const briefing = register.project.briefing_import;
  if (!briefing) {
    throw new AnchorPreconditionError(
      "Für dieses Projekt ist noch kein Briefing eingefroren – " +
        "ohne Briefing gibt es keinen Absatz, auf den ein Anker zeigen könnte.",
    );
  }
  if (!register.claims.some((claim) => claim.id === claimId)) {
    throw new AnchorPreconditionError(
      `Claim „${claimId}" existiert in diesem Projekt nicht.`,
    );
  }
  const text = store.blobs().readText(briefing.blob_path);
  return {
    briefing,
    register,
    text,
    paragraphs: splitBriefingParagraphs(text),
  };
}

/** 0-based paragraph index of a `p<N>` anchor, or null when it does not
 * parse or points past the briefing's last paragraph. */
function anchorIndex(anchor: string, paragraphCount: number): number | null {
  const match = /^p([1-9][0-9]*)$/.exec(anchor.trim());
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return index < paragraphCount ? index : null;
}

/**
 * Manual, audited re-anchor of a single claim — allowed in ANY claim status,
 * because an anchor that points at the wrong paragraph is a bookkeeping
 * defect rather than a verification verdict, and it is just as wrong on a
 * confirmed claim as on a contested one.
 *
 * Register discipline: everything impure (register read, blob read) and the
 * whole validation happen BEFORE the transaction, which then performs
 * exactly one write — `tx.reviseClaimAnchor`, carrying the before/after pair
 * into the chain as a `claim_anchor_revised` event.
 *
 * The validation is the reason this use-case exists rather than a bare
 * store call: the quote must actually occur in the chosen paragraph
 * (`containsNormalized`, the same comparison the display-side resolution
 * uses), so a manual correction cannot install a second unresolvable anchor.
 */
export async function repairClaimAnchor(
  projectId: string,
  claimId: string,
  input: RepairClaimAnchorInput,
): Promise<void> {
  const { paragraphs } = await readBriefingContext(projectId, claimId);
  const quote = input.quote.trim();
  if (quote.length === 0) {
    throw new AnchorPreconditionError(
      "Bitte den Wortlaut angeben, an den der Anker gebunden wird.",
    );
  }
  const index = anchorIndex(input.anchor, paragraphs.length);
  if (index === null) {
    throw new AnchorPreconditionError(
      `„${input.anchor}" ist kein Absatz dieses Briefings ` +
        `(es hat ${paragraphs.length} Absätze).`,
    );
  }
  if (!containsNormalized(paragraphs[index], quote)) {
    throw new AnchorPreconditionError(
      `Der gewählte Absatz (${input.anchor.trim()}) enthält den angegebenen ` +
        "Wortlaut nicht – bitte einen Absatz wählen, in dem er vorkommt, " +
        "oder stattdessen die Briefing-Passage korrigieren.",
    );
  }

  const anchor = `p${index + 1}`;
  await requireProjectStore(projectId).transaction((tx) => {
    tx.reviseClaimAnchor(claimId, {
      new_anchor: anchor,
      new_quote: quote,
      actor: getCurrentActor(),
      reason: `Anker manuell auf ${anchor} korrigiert (Arbeitsbereich).`,
    });
  });
}

/**
 * Rewrites the ONE briefing paragraph a claim is anchored to and publishes
 * the result as the briefing's next revision. The paragraph the claim
 * currently resolves to is taken from the shared view model — the display
 * truth, quote-first — so the passage the reviewer was shown beside the
 * claim is exactly the one that gets replaced.
 *
 * REFUSES while the project has an unpublished briefing draft. Publishing a
 * revision clears the draft — so repairing a passage over an open draft
 * would silently throw away an unrelated, half-finished rewrite of the whole
 * briefing that the workbench autosaved. Publishing or discarding the draft
 * first is a decision only the reviewer can make, so this asks for it
 * instead of guessing; the check runs before anything else, so nothing is
 * written on that path.
 *
 * Deliberately no `tx.reviseClaimAnchor` here: `publishBriefingRevision`'s
 * silent re-anchor pass already remaps every claim whose quote moved in the
 * rewritten text, and an extra audited anchor event would double-record the
 * same mechanical consequence of one authored change. The revision event's
 * reason names the claim, so the correction stays traceable to it.
 *
 * A contested claim is NOT transitioned here either — it proceeds through
 * its normal repair re-entry afterwards.
 */
export async function repairBriefingPassage(
  projectId: string,
  claimId: string,
  newParagraphText: string,
): Promise<void> {
  if (requireProjectStore(projectId).readDraft() !== null) {
    throw new AnchorPreconditionError(
      "Es liegt eine ungespeicherte Briefing-Überarbeitung vor – bitte " +
        "zuerst den Entwurf veröffentlichen oder verwerfen, dann die " +
        "Passage korrigieren.",
    );
  }
  const { register, text, paragraphs } = await readBriefingContext(
    projectId,
    claimId,
  );
  if (newParagraphText.trim().length === 0) {
    throw new AnchorPreconditionError(
      "Die korrigierte Passage darf nicht leer sein.",
    );
  }
  const view = buildBriefingViewModel(text, register);
  const paragraph = view.paragraphs.find((candidate) =>
    candidate.claims.some((marker) => marker.claim.id === claimId),
  );
  if (paragraph === undefined) {
    throw new AnchorPreconditionError(
      "Dieser Claim ist keinem Absatz des Briefings zugeordnet – " +
        "zuerst den Anker korrigieren, dann die Passage.",
    );
  }

  const revised = [...paragraphs];
  revised[paragraph.index] = newParagraphText.trim();
  await publishBriefingRevision(projectId, {
    text: revised.join("\n\n"),
    reason: `Briefing-Passage zu Claim ${claimId} korrigiert (Arbeitsbereich).`,
  });
}

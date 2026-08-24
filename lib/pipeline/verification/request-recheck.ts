import { getCurrentActor } from "../../identity";
import { machineParkedInAdjudication } from "../../register";
import type { Claim, ClaimsRegister } from "../../register";
import { InvalidProjectInputError, RunActiveError } from "../errors";
import { requireProjectStore } from "../projects";
import { describeBlockingActivity } from "../runs/control";
import { getGlobalJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import { RECHECK_STATUSES } from "./recheck-statuses";
import { loadRubricRuleSet } from "./rubric-rules";

/**
 * Why this file composes with `pickUnfinishedClaims` instead of
 * reimplementing a work list (ROADMAP must-not, D-08).
 *
 * The sweep does not run anything. It moves claims into `recheck_required`
 * and stops; the reviewer's next „KI-Prüfung starten" is what picks them up,
 * and it picks them up through `pickUnfinishedClaims`
 * (`./select-claims.ts`), which recomputes the work set from the CURRENT
 * register on every run start. Status is therefore the bookmark: a
 * rate-limited, paused or crashed sweep-then-run resumes into the remainder
 * with no bookkeeping of its own, because every claim still carrying
 * `recheck_required` still needs the cascade.
 *
 * A claim list enumerated here — "the forty ids the reviewer confirmed" —
 * would have to be persisted somewhere to survive a crash, and the half of
 * it already processed would restart from the beginning. The composition is
 * the resumability, and `request-recheck.test.ts` asserts it directly:
 * after a sweep, every moved id is in `pickUnfinishedClaims`.
 */

/**
 * Actor of the transition itself.
 *
 * A re-run is human-INITIATED but system-EXECUTED: the reviewer asks for
 * it, the machine performs the move and will perform the re-check. Writing
 * the reviewer into `history[].actor` would report the audit trail the
 * thesis cites as if a human had personally re-classified the claim. The
 * human's intent is recorded instead on the bracket event, whose actor is
 * the real reviewer and whose German reason says what they asked for.
 *
 * The transition table independently requires it: every
 * `* → recheck_required` edge is declared `actorKind: "system"`, so a human
 * actor here would be refused at the gate.
 */
const RECHECK_ACTOR = "system:recheck_request" as const;

/** Persisted German prose on the claim's own history entry. */
const TRANSITION_REASON =
  "Erneute Prüfung angefordert: die Aussage durchläuft die Prüfstufen " +
  "noch einmal, beginnend bei der Zitatprüfung.";

/**
 * The sweep's scope: ONE escalation ladder of three rungs, each a strict
 * superset of the previous (D-08 + D-11).
 *
 * Deliberately a three-value union and NOT a pair of booleans
 * ("vintage-aware?" × "include confirmed?"). Two toggles produce four
 * combinations to word, confirm and test, and a reviewer cannot hold four
 * scopes in mind while confirming an action that looks destructive. The
 * nesting is the whole point: whatever rung 1 selects, rung 2 also selects,
 * and whatever rung 2 selects, rung 3 also selects.
 *
 * - `stale` — eligible, not human-confirmed, and carrying a calibration
 *   vintage other than the one the project's pinned rule set resolves
 *   today. An ABSENT stamp counts as legacy and therefore stale, which is
 *   correct for every reasoning already stored: the stamp only exists from
 *   D-03 onwards, so its absence means "written before we recorded this".
 * - `all` — eligible and not human-confirmed, regardless of vintage.
 *   P-11's non-reproducibility makes "give me a fresh sample even though
 *   the vintage matches" a legitimate thing to want.
 * - `all_including_confirmed` — eligible, human-confirmed claims included.
 *   The only rung that can un-confirm a human decision, and it carries its
 *   own itemisation row for exactly that reason.
 */
export type RecheckScope = "stale" | "all" | "all_including_confirmed";

/** Internal — the barrel exposes the preview, never the ladder's encoding;
 * the dialog transcribes its three German labels from the Copywriting
 * Contract, not from a runtime list. */
export const RECHECK_SCOPES: readonly RecheckScope[] = [
  "stale",
  "all",
  "all_including_confirmed",
];

function isRecheckScope(value: unknown): value is RecheckScope {
  return (
    typeof value === "string" &&
    (RECHECK_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Why a claim the reviewer's scope covered was not moved.
 *
 * A named union rather than a free string because the confirmation must
 * ITEMISE rather than count: a reviewer shown "40" who then sees 37 move
 * reads data loss, not an exclusion (P-20). Every value here is a sentence
 * the UI can write.
 *
 * - `open_in_workbench` — the claim the reviewer currently has expanded
 *   (RERUN-04). Client-supplied; see `excludeClaimIds`.
 * - `discarded` — terminal by construction (`discarded` has zero outgoing
 *   edges), so never base-eligible. Reported anyway, under its own name, so
 *   the group is countable instead of being an unexplained gap.
 * - `legacy_unrouted` — parked in the adjudication queue with no structured
 *   routing reason on its latest history entry, i.e. parked before the
 *   `RoutingReason` extension existed. This is 04-03's gate's stated blind
 *   spot (P-20), counted here so it reads as excluded rather than missing.
 * - `human_confirmed` — rung-definitional: excluded from `stale` and `all`
 *   because a sweep that silently un-confirms what a reviewer decided is
 *   the failure D-11 and SC4 both circle.
 * - `vintage_current` — rung-definitional: the calibration already carries
 *   the version the project's pinned rule set resolves, so `stale` skips it
 *   and P-19's quota is not spent regenerating prose already current.
 * - `raced` — the claim moved between the pre-lock read and the
 *   transaction, and a human verdict arriving in that window wins. Only the
 *   transaction can observe this, so it never appears in a preview.
 */
export type RecheckExclusionReason =
  | "open_in_workbench"
  | "discarded"
  | "legacy_unrouted"
  | "human_confirmed"
  | "vintage_current"
  | "raced";

/** Every reason a PREVIEW can report — i.e. all of them but the race, which
 * is post-hoc by definition. */
export type RecheckPreviewExclusionReason = Exclude<
  RecheckExclusionReason,
  "raced"
>;

/**
 * The three groups the confirmation's exclusions line names („{o} gerade
 * geöffnet, {d} verworfen, {l} ohne maschinellen Einordnungsvermerk").
 *
 * `human_confirmed` and `vintage_current` are counted in the breakdown but
 * NOT listed per claim: they are what the chosen rung MEANS, the rung's own
 * label already says them, and listing a hundred current-vintage claims as
 * „nicht vorgemerkt" would turn the honest report into an alarm.
 */
const ITEMISED_EXCLUSION_REASONS: ReadonlySet<RecheckPreviewExclusionReason> =
  new Set(["open_in_workbench", "discarded", "legacy_unrouted"]);

export interface RecheckExclusion {
  claimId: string;
  reason: RecheckExclusionReason;
}

/** Per-reason counts for one rung. Zero-filled, never sparse, so the dialog
 * can render „omitted when its count is 0" from the value rather than from
 * the key's presence. */
export type RecheckExclusionBreakdown = Record<
  RecheckPreviewExclusionReason,
  number
>;

export interface RequestClaimRecheckInput {
  projectId: string;
  /** Explicit per-claim mode (surface 1). Mutually exclusive with `scope`:
   * the reviewer named the claim, so neither its vintage nor its
   * confirmation is a reason to skip it. */
  claimIds?: readonly string[];
  /** Sweep mode (surfaces 2+3). Mutually exclusive with `claimIds`. */
  scope?: RecheckScope;
  /**
   * Claims the reviewer is working on right now (RERUN-04, D-05).
   *
   * WHY THIS IS CLIENT STATE AND NOT REGISTER STATE. The effort timer is a
   * client-only `useRef` hook (`app/projects/[id]/review/useEffortTimer.ts`)
   * and the complaint draft is plain `useState`
   * (`app/projects/[id]/review/ComplaintDialog.tsx:38-39`); the server sees
   * neither. TrustMeBro is single-user and local-first, so the browser
   * holding the timer and the draft is the same browser initiating the
   * sweep — the exclusion belongs where the state already is. The rejected
   * alternative was a persisted „in Bearbeitung" lease next to
   * `claims.json` (the `BriefingDraft` precedent): durable state with a
   * lifecycle nobody owns, whose stale form silently blocks a legitimate
   * sweep — a failure mode that presents to the user as a bug.
   *
   * WHY ONE ID IS ENOUGH. `ComplaintDialog` renders only inside an EXPANDED
   * card, and `useEffortTimer(selectedClaimId)` is bound to the same value
   * (`app/projects/[id]/workbench/Workbench.tsx:84,89`). So „the claim with
   * an open complaint draft" and „the claim with a running effort timer"
   * are both subsets of the selected claim. Excluding that one id
   * implements RERUN-04 completely: one prop, no draft-state lifting.
   *
   * WHY IT IS SAFE TO HONOUR UNVERIFIABLE CLIENT STATE. This list can only
   * ever REMOVE claims from a server-derived selection; the client never
   * sends a list of claims to act on. A forged value can at worst
   * under-select.
   *
   * CONSEQUENCE FOR TESTING. The server half is tested here; RERUN-04's
   * other half — that the workbench actually passes the selected id — is
   * only observable at the UI seam, and 04-07 owns that test. A green suite
   * in `lib/` is therefore not evidence that RERUN-04 ships.
   */
  excludeClaimIds?: readonly string[];
}

/**
 * A structured result, deliberately NOT the bare `string[]` that
 * `readmitStaleExistenceChecks` and `sweepSourceRecheck` return (both keep
 * theirs — this is an addition, not a migration).
 *
 * Those two are machine-initiated and report only what they did. This one
 * answers a reviewer who was shown an itemisation BEFORE pressing, and
 * therefore needs the AFTER truth as well: `string[]` cannot express
 * "five requested, three moved, two raced", and a count discrepancy the
 * reviewer cannot explain reads as data loss rather than as an exclusion.
 */
export interface RequestClaimRecheckResult {
  moved: string[];
  excluded: RecheckExclusion[];
}

export interface RequestClaimRecheckDependencies {
  runner?: JobRunner;
  /** Injected timestamp — the transitions and the bracket pair share it. */
  at?: string;
}

/**
 * Whether a claim may be pulled back into `recheck_required` right now.
 *
 * Two sources, both read from their shipped homes so this file can never
 * select a claim the gate would refuse:
 * - `RECHECK_STATUSES`, shared with the source-revision and extraction
 *   writers and aligned edge-for-edge with the transition table;
 * - the transition table's OWN gate for the fifth source status,
 *   `pending_adjudication`, widened in 04-03. Calling the gate rather than
 *   restating its condition is what keeps "selected" and "takeable"
 *   identical by construction.
 */
export function isRecheckEligible(claim: Claim): boolean {
  return (
    RECHECK_STATUSES.has(claim.status) ||
    (claim.status === "pending_adjudication" &&
      machineParkedInAdjudication(claim).ok)
  );
}

/**
 * The prompt-template version the project's OWN pin resolves today.
 *
 * Read through the shipped loader from `register.config.rubric_version` —
 * never a version string written into this file. `rubric_version` is a
 * per-project, UI-editable setting validated at write time, and "move one
 * project's pin, then re-run it" is the value proposition of the whole
 * phase; a constant here would silently answer for a different project.
 *
 * `prompt_template_version` carries a schema default, so this is always a
 * concrete string. A load failure means the register names a rule file this
 * installation does not ship — a config error the project-settings writer
 * already refuses, left to propagate as the programming error it is.
 */
function currentPromptVersion(register: ClaimsRegister): string {
  return loadRubricRuleSet(register.config.rubric_version)
    .prompt_template_version;
}

/**
 * The one predicate. The preview and the request both call it, which is
 * what makes "the number the reviewer confirms is the number the sweep acts
 * on" true up to the races the transaction re-derives away — two
 * implementations that agree today would not.
 *
 * `null` means "never a candidate and not worth reporting": `captured`,
 * `recheck_required`, `contested`, the repair statuses. The sweep was never
 * going to touch them, so naming them in an exclusions line would pad the
 * report with claims that were never in scope.
 */
export function classifyClaimForRecheck(
  claim: Claim,
  scope: RecheckScope,
  promptVersion: string,
  excludeClaimIds: ReadonlySet<string>,
): "selected" | RecheckPreviewExclusionReason | null {
  if (claim.status === "discarded") {
    return "discarded";
  }
  if (!isRecheckEligible(claim)) {
    return claim.status === "pending_adjudication" ? "legacy_unrouted" : null;
  }
  // Ordered BEFORE the rung filters on purpose. `open_in_workbench` is a
  // displayed group; `human_confirmed` and `vintage_current` are not. A
  // confirmed claim the reviewer has open must read as „gerade geöffnet"
  // rather than vanish into a rung-definitional count — and it must be
  // reported exactly once, which this ordering guarantees by returning.
  if (excludeClaimIds.has(claim.id)) {
    return "open_in_workbench";
  }
  if (claim.status === "confirmed" && scope !== "all_including_confirmed") {
    return "human_confirmed";
  }
  if (scope === "stale" && claim.calibration_prompt_version === promptVersion) {
    return "vintage_current";
  }
  return "selected";
}

export interface RecheckScopeSelection {
  claims: Claim[];
  /** Only the itemised groups — see `ITEMISED_EXCLUSION_REASONS`. */
  exclusions: RecheckExclusion[];
  breakdown: RecheckExclusionBreakdown;
}

function emptyBreakdown(): RecheckExclusionBreakdown {
  return {
    open_in_workbench: 0,
    discarded: 0,
    legacy_unrouted: 0,
    human_confirmed: 0,
    vintage_current: 0,
  };
}

/** One pass over the register in register order, applied to every rung and
 * to the explicit per-claim mode alike. `restrictTo` is the explicit mode's
 * id set; absent means the whole project. */
export function selectClaimsForScope(
  register: ClaimsRegister,
  scope: RecheckScope,
  promptVersion: string,
  excludeClaimIds: ReadonlySet<string>,
  restrictTo?: ReadonlySet<string>,
): RecheckScopeSelection {
  const claims: Claim[] = [];
  const exclusions: RecheckExclusion[] = [];
  const breakdown = emptyBreakdown();
  for (const claim of register.claims) {
    if (restrictTo !== undefined && !restrictTo.has(claim.id)) {
      continue;
    }
    const disposition = classifyClaimForRecheck(
      claim,
      scope,
      promptVersion,
      excludeClaimIds,
    );
    if (disposition === "selected") {
      claims.push(claim);
      continue;
    }
    if (disposition === null) {
      continue;
    }
    breakdown[disposition] += 1;
    if (ITEMISED_EXCLUSION_REASONS.has(disposition)) {
      exclusions.push({ claimId: claim.id, reason: disposition });
    }
  }
  return { claims, exclusions, breakdown };
}

/** One rung of the ladder, as the confirmation needs to itemise it. */
export interface RecheckRungPreview {
  scope: RecheckScope;
  /**
   * The ids this rung would move, in register order.
   *
   * NOT for display — the dialog carries counts and groups only, never a
   * list of ids (a forty-item list pushes the forcing field below the fold
   * and makes the last thing the reviewer sees a wall of ids). They are
   * here so the client can subtract the claim it has selected SINCE this
   * preview was computed from the displayed counts, without a round trip
   * that would let the shown number drift from the acted-on one.
   */
  claimIds: string[];
  total: number;
  /** Of `total`, how many currently await manual adjudication — the number
   * the forcing step asks the reviewer to type, because it is the thing at
   * risk. */
  queued: number;
  /** Of `total`, how many are human-confirmed. Non-zero only on the top
   * rung, which is the one that un-confirms them. */
  confirmed: number;
  exclusions: RecheckExclusionBreakdown;
}

/** All three rungs, keyed by scope. */
export type RecheckPreview = Record<RecheckScope, RecheckRungPreview>;

export interface PreviewClaimRecheckInput {
  projectId: string;
  /** Same meaning as on the request — see `RequestClaimRecheckInput`. */
  excludeClaimIds?: readonly string[];
}

function buildRung(
  register: ClaimsRegister,
  scope: RecheckScope,
  promptVersion: string,
  excludeClaimIds: ReadonlySet<string>,
): RecheckRungPreview {
  const { claims, breakdown } = selectClaimsForScope(
    register,
    scope,
    promptVersion,
    excludeClaimIds,
  );
  return {
    scope,
    claimIds: claims.map((claim) => claim.id),
    total: claims.length,
    queued: claims.filter((claim) => claim.status === "pending_adjudication")
      .length,
    confirmed: claims.filter((claim) => claim.status === "confirmed").length,
    exclusions: breakdown,
  };
}

/**
 * What the confirmation itemises from (RERUN-02).
 *
 * ALL THREE RUNGS IN ONE CALL, because the reviewer changes rungs
 * client-side and the itemisation has to recompute instantly — and because
 * a per-rung round trip would let the displayed count drift from the count
 * the submit acts on.
 *
 * A BARE TOTAL IS THE FAILURE THIS EXISTS TO PREVENT. The ROADMAP is
 * explicit that a bare count „produces automatic agreement and is a useless
 * confirmation", so every rung carries its queued and confirmed sub-counts
 * and a per-reason exclusion breakdown. A dialog can only itemise what the
 * pipeline can count.
 *
 * Read-only and un-gated: it takes no lock, starts nothing and blocks on
 * nothing. Everything it reports is stale the moment it returns — the
 * transaction is the authority, and it re-derives the same predicate.
 */
export async function previewClaimRecheck(
  input: PreviewClaimRecheckInput,
): Promise<RecheckPreview> {
  const register = await requireProjectStore(input.projectId).read();
  const promptVersion = currentPromptVersion(register);
  const excludeClaimIds = new Set(input.excludeClaimIds ?? []);
  return {
    stale: buildRung(register, "stale", promptVersion, excludeClaimIds),
    all: buildRung(register, "all", promptVersion, excludeClaimIds),
    all_including_confirmed: buildRung(
      register,
      "all_including_confirmed",
      promptVersion,
      excludeClaimIds,
    ),
  };
}

/**
 * The rung the request acts on, validated at the pipeline boundary.
 *
 * The scope arrives from a client form and is the only untrusted input on
 * this path, so an unrecognised value is REFUSED rather than allowed to
 * fall through to a default — and the default it would fall through to is
 * the widest rung, which is the one that un-confirms human decisions.
 *
 * One throw for every invalid shape, because every one of them is the same
 * mistake made by the caller, and none is reachable from the shipped
 * dialog's three radio values.
 */
function resolveScope(input: RequestClaimRecheckInput): RecheckScope {
  const explicit = input.claimIds !== undefined;
  if (explicit && input.scope === undefined) {
    // The explicit per-claim path applies no rung filter: the ladder exists
    // to narrow a sweep the reviewer did NOT enumerate.
    return "all_including_confirmed";
  }
  if (!explicit && isRecheckScope(input.scope)) {
    return input.scope;
  }
  throw new InvalidProjectInputError(
    "Ungültige Anfrage für eine erneute Prüfung: erwartet werden entweder " +
      "einzelne Aussagen oder genau ein Umfang („nur veraltete " +
      "Vorprüfungen“, „alle vorgeprüften Aussagen“ oder „auch bestätigte " +
      "Aussagen“).",
  );
}

/**
 * Reviewer-triggered re-verification (RERUN-01/02/04): moves the selected
 * claims into `recheck_required` and brackets the request in the chain. It
 * starts NO run — the reviewer's next „KI-Prüfung starten" picks the claims
 * up through the ordinary cascade, which is why the bracket closes inside
 * the same transaction that opens it.
 *
 * Idempotent by construction: `recheck_required` is neither an eligible
 * source status nor a reportable one, so a second request on the same claim
 * selects nothing, moves nothing and appends no event.
 */
export async function requestClaimRecheck(
  input: RequestClaimRecheckInput,
  deps: RequestClaimRecheckDependencies = {},
): Promise<RequestClaimRecheckResult> {
  const scope = resolveScope(input);
  const actor = getCurrentActor();
  const runner = deps.runner ?? getGlobalJobRunner();
  // Precondition, not an error handler: asked AFTER the transaction, the
  // refusal would arrive having already moved claims. Same pair, same
  // reason, as reviseSource and correctSourceMetadata — a run caches its
  // work set at start, so a mid-run status change is invisible to it.
  const blocking = describeBlockingActivity(input.projectId);
  if (blocking || runner.isRunning(input.projectId)) {
    throw new RunActiveError(input.projectId, blocking);
  }

  const store = requireProjectStore(input.projectId);
  const register = await store.read();
  const excludeClaimIds = new Set(input.excludeClaimIds ?? []);
  const restrictTo =
    input.claimIds === undefined ? undefined : new Set(input.claimIds);
  const promptVersion = currentPromptVersion(register);
  const selection = selectClaimsForScope(
    register,
    scope,
    promptVersion,
    excludeClaimIds,
    restrictTo,
  );
  if (selection.claims.length === 0) {
    // A rung that selects nothing appends NO bracket event — an empty
    // re-run is not a project event, and the dialog renders its empty state
    // from the preview rather than from a no-op write.
    return { moved: [], excluded: selection.exclusions };
  }

  const at = deps.at ?? new Date().toISOString();
  return store.transaction((tx) => {
    const moved: string[] = [];
    const excluded: RecheckExclusion[] = [...selection.exclusions];
    for (const candidate of selection.claims) {
      // Re-derive the WHOLE predicate under the lock — not just base
      // eligibility: a human may have adjudicated, discarded, confirmed or
      // otherwise moved one of these between the read above and this
      // transaction, and their verdict wins over a machine re-check.
      //
      // A per-claim failure is a `continue`, never an exception: one raced
      // claim out of forty must cost one claim, not thirty-nine. This is
      // the second half of D-05's enforcement — the client passes the
      // excluded id, and the server re-derives everything anyway.
      const current = tx.getClaim(candidate.id);
      const disposition = classifyClaimForRecheck(
        current,
        scope,
        promptVersion,
        excludeClaimIds,
      );
      if (disposition !== "selected") {
        // Reported as `raced` whatever the new disposition is: what the
        // reviewer needs to know is that it moved after they were shown the
        // count, not which status it landed in.
        excluded.push({ claimId: candidate.id, reason: "raced" });
        continue;
      }
      tx.transitionClaim(candidate.id, {
        to: "recheck_required",
        actor: RECHECK_ACTOR,
        reason: TRANSITION_REASON,
        at,
      });
      moved.push(candidate.id);
    }
    if (moved.length > 0) {
      // The payload is `moved`, never the requested selection: the bracket
      // must describe the transitions actually made inside this
      // transaction.
      tx.recordReverificationRun({
        claim_ids: moved,
        actor,
        started_reason:
          `Erneute Prüfung angefordert für ${moved.length} ` +
          `Aussage${moved.length === 1 ? "" : "n"}.`,
        completed_reason:
          `${moved.length} Aussage${moved.length === 1 ? "" : "n"} zur ` +
          "Nachprüfung vorgemerkt – die Prüfung selbst startet erst mit " +
          "dem nächsten Prüflauf.",
        at,
      });
    }
    return { moved, excluded };
  });
}

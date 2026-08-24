import type { CalibrationResult, CalibrationSnapshot } from "@/lib/register";

/**
 * Display-tier derivation over the append-only `Claim.previous_calibrations`
 * array: has the pre-check changed its mind about this claim, what did it
 * conclude before, and how often has it moved?
 *
 * The sibling this module deliberately does NOT extend, because a later
 * reader will otherwise try to merge them: `judgment-supersession.ts`, beside
 * it in this directory, answers the same *shape* of question over
 * `Evidence.judgments`. It must stay a separate module. Judgments are
 * per-backend and per-evidence, and that module's whole substance is grouping
 * by backend so a backend is compared only against ITSELF — its header warns
 * at length that comparing across backends mislabels divergence as a
 * self-revision. Calibration is per-claim and single-valued: it has no
 * backend dimension at all. A shared implementation would have to invent one
 * and pass a constant through it, which is the same mislabelling arrived at
 * from the other direction — a fake actor axis over data that has none. The
 * two modules resemble each other because the register is append-only in both
 * places, not because they compute the same thing.
 *
 * Placement in `app/` is deliberate, not incidental. A display-tier
 * derivation living in `lib/**` is reachable from prompt construction and
 * from a `.tmb` export, and what the UI says about a claim's history must
 * never become input to the machine or content of a bundle — the Phase 02
 * placement rule this phase inherits. The `@/lib/register` import is
 * therefore type-only, which is the only reason an `app/` module may name
 * that package at all: a runtime import from `app/` outside the
 * `@/lib/pipeline` barrel fails `tests/architecture.test.ts`.
 *
 * Like the sibling, what this feeds states WHAT changed and WHEN. It says
 * nothing about which of the two verdicts is better, and it quantifies
 * nothing as a rate — that is the reviewer's call, and it is the call this
 * tool exists to support.
 */
export interface CalibrationSupersession {
  /**
   * The archived entry that superseding refers to: the NEWEST element of
   * `previous_calibrations`, carrying the whole triple plus its vintage.
   * `support_degree` is optional on the snapshot, so a caller naming the
   * previous verdict must have a fallback for its absence.
   */
  previous: CalibrationSnapshot;
  /**
   * The newest archived `calibration_result` differs from the current one.
   * False when the claim has been re-checked but the newest re-check reached
   * the same conclusion as the one before it.
   */
  changed: boolean;
  /** Pre-checks this claim has had: archived entries plus the current one. */
  preCheckCount: number;
  /**
   * Distinct `calibration_result` values across the archive AND the current
   * one. Note this is a count over the closed enum, so it is bounded by the
   * number of `CalibrationResult` members and is NOT the archive's length.
   */
  distinctResultCount: number;
  /**
   * The depth line's render gate: two or more archived entries AND two or
   * more distinct results. Below that threshold the count says nothing a
   * reviewer can act on, and printing it anyway would dress one flip up as a
   * pattern.
   */
  showDepth: boolean;
}

/**
 * `null` = the note renders nothing at all: no placeholder, no „unverändert"
 * line, no zero state.
 *
 * The render rules, exactly as the UI-SPEC states them:
 *
 * - no archive → `null`
 * - archive present, newest archived result = current, and only one distinct
 *   result overall → `null`. A re-run that reached the same conclusion
 *   superseded nothing; this is the same judgment `judgment-supersession.ts`
 *   makes when it skips a backend that repeated itself.
 * - newest archived result ≠ current → `changed`, which renders line 1
 * - two or more archived entries AND two or more distinct results →
 *   `showDepth`, which renders line 2. Independent of `changed`: an archive
 *   that has moved and moved back reads as depth without a current change.
 *
 * Comparison is over `calibration_result` ENUM VALUES from the closed set,
 * never over rendered German strings. The display tier deliberately keeps two
 * separate German forms for these values (`CALIBRATION_LABELS`, the
 * verdict-matrix phrases), so comparing prose would make this derivation
 * depend on which map a caller happened to reach for.
 *
 * Array order is write order: `previous_calibrations` is append-only, rotated
 * one entry per calibration write, and the register's chain is gapless. Do
 * NOT reorder it by `superseded_at` — two rotations sharing a timestamp would
 * be silently transposed, and the newest entry is what the whole note names.
 */
export function deriveCalibrationSupersession(
  previousCalibrations: readonly CalibrationSnapshot[] | undefined,
  currentResult: CalibrationResult | undefined,
): CalibrationSupersession | null {
  if (previousCalibrations === undefined || previousCalibrations.length === 0) {
    return null;
  }
  if (currentResult === undefined) {
    // Unreachable through the pipeline: an entry is only ever archived BY a
    // calibration write, which sets the current result in the same
    // transaction. There is no current verdict to have changed from, so the
    // honest rendering is nothing rather than a sentence about a verdict the
    // card is not showing.
    return null;
  }

  const previous = previousCalibrations[previousCalibrations.length - 1];
  const changed = previous.calibration_result !== currentResult;

  const distinct = new Set<CalibrationResult>([currentResult]);
  for (const snapshot of previousCalibrations) {
    distinct.add(snapshot.calibration_result);
  }
  const distinctResultCount = distinct.size;

  if (!changed && distinctResultCount === 1) {
    return null;
  }

  return {
    previous,
    changed,
    preCheckCount: previousCalibrations.length + 1,
    distinctResultCount,
    showDepth: previousCalibrations.length >= 2 && distinctResultCount >= 2,
  };
}

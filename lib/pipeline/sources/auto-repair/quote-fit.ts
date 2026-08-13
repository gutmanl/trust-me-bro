import { containsNormalized } from "../../../register";

/**
 * Quote-fit disambiguation (automatic repair): when a source's identity is
 * only SUSPECTED wrong — claims' quoted wording is missing from the frozen
 * text, which could equally mean the wording is wrong — the deciding
 * evidence is which document actually CONTAINS the quotes. Same
 * normalization as stage 1's verbatim proof, so "the candidate fits
 * better" means exactly "stage 1 would pass against it".
 */
export interface QuoteFitResult {
  /** Failing excerpts found verbatim in the candidate document. */
  candidateMatches: number;
  /** The same excerpts found in the CURRENT frozen text (expected ~0 —
   * they failed stage 1 against it — but recomputed, never assumed). */
  currentMatches: number;
  checkedExcerpts: number;
  /** The auto-apply bar: the candidate must contain strictly more of the
   * failing excerpts than the current text, and at least one. */
  confident: boolean;
}

export function evaluateQuoteFit(
  candidateText: string,
  failingExcerpts: readonly string[],
  currentText: string | undefined,
): QuoteFitResult {
  let candidateMatches = 0;
  let currentMatches = 0;
  for (const excerpt of failingExcerpts) {
    if (containsNormalized(candidateText, excerpt)) {
      candidateMatches += 1;
    }
    if (currentText !== undefined && containsNormalized(currentText, excerpt)) {
      currentMatches += 1;
    }
  }
  return {
    candidateMatches,
    currentMatches,
    checkedExcerpts: failingExcerpts.length,
    confident: candidateMatches > currentMatches && candidateMatches >= 1,
  };
}

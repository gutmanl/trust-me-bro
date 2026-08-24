import { extractText, getDocumentProxy } from "unpdf";

import { TextExtractionTimeoutError } from "../errors";
import { raceTimeout } from "../timeout";

/** unpdf's bundled pdf.js calls `Math.sumPrecise` (TC39 proposal) in its font
 * code. Chromium ships it, but Node 24 and below do not, so extracting a PDF
 * that exercises font subsetting throws `TypeError: Math.sumPrecise is not a
 * function` on every supported Node version (engines: >= 20.9). Polyfilled
 * here — the single sanctioned pdf.js entry point — rather than globally,
 * because only pdf.js needs it. Neumaier-compensated so the "precise sum"
 * contract actually holds instead of silently degrading to naive addition. */
const patchableMath = Math as Math & {
  sumPrecise?: (values: Iterable<number>) => number;
};
if (typeof patchableMath.sumPrecise !== "function") {
  patchableMath.sumPrecise = (values: Iterable<number>): number => {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const t = sum + value;
      if (Math.abs(sum) >= Math.abs(value)) {
        compensation += sum - t + value;
      } else {
        compensation += value - t + sum;
      }
      sum = t;
    }
    return sum + compensation;
  };
}

/** Time budget for parsing one PDF. unpdf (pdf.js) has no internal bound and
 * can spin indefinitely on a malformed cross-reference table or content
 * stream — a small crafted file is enough — so the parse must be capped from
 * outside or one bad document hangs the whole capture run. */
const DEFAULT_PDF_TIMEOUT_MS = 20_000;

/**
 * PDF → text via unpdf (serverless build of pdf.js). Deterministic for
 * identical bytes: no OCR, no clock, no randomness in the text pipeline.
 * Bounded by a timeout because the parse itself is not: on expiry it throws
 * TextExtractionTimeoutError (a fatal capture failure, not a soft
 * text-extraction note). The abandoned parse keeps running in the background
 * — JS cannot cancel it — but no longer blocks the run.
 */
export async function extractPdfText(
  content: Buffer,
  timeoutMs: number = DEFAULT_PDF_TIMEOUT_MS,
): Promise<string> {
  return raceTimeout(
    parsePdf(content),
    timeoutMs,
    () => new TextExtractionTimeoutError(Math.round(timeoutMs / 1000)),
  );
}

async function parsePdf(content: Buffer): Promise<string> {
  const document = await getDocumentProxy(new Uint8Array(content));
  const { text } = await extractText(document, { mergePages: true });
  return text;
}

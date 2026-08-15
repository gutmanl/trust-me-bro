import { describe, expect, it } from "vitest";

import {
  findInterrupted,
  MAX_INTERRUPTION_CHARS,
  MIN_FRAGMENT_CHARS,
} from "./interrupted";

/** The shape that motivated this module: an ACM copyright block emitted in
 * the middle of a sentence crossing the foot of column 1. */
const QUOTE =
  "Expert programmers are especially adept at program comprehension of " +
  "familiar code—their eyes dance around, finding points of interest, " +
  "called beacons (or semantic cues) that provide hints about a program's " +
  "purpose, such as method signatures, and common programming idioms.";

const COPYRIGHT =
  "Permission to make digital or hard copies of all or part of this work " +
  "for personal or classroom use is granted without fee provided that " +
  "copies are not made or distributed for profit or commercial advantage " +
  "and that copies bear this notice and the full citation on the first " +
  "page. ESEC/FSE'17, September 04-08, 2017, Paderborn, Germany. " +
  "© 2017 ACM. 978-1-4503-5105-8/17/09. . . $15.00";

function splitAround(quote: string, at: number, filler: string): string {
  return `${quote.slice(0, at)}\n${filler}\n${quote.slice(at)}`;
}

describe("findInterrupted", () => {
  it("reports a contiguous quote as zero interruptions", () => {
    expect(findInterrupted(`Vorspann. ${QUOTE} Nachspann.`, QUOTE)).toEqual({
      interruptions: 0,
      skipped: 0,
    });
  });

  it("matches across an interpolated copyright block", () => {
    const text = splitAround(QUOTE, 49, COPYRIGHT);
    const match = findInterrupted(text, QUOTE);
    expect(match?.interruptions).toBe(1);
    expect(match?.skipped).toBeGreaterThan(300);
  });

  it("composes with de-hyphenation elsewhere in the quote", () => {
    const quote =
      "the high-performance participants displayed higher performance " +
      "for working memory and attention resource allocation";
    const text =
      "the high-\nperformance participants displayed higher performance\n" +
      `${COPYRIGHT}\nfor working memory and attention resource allocation`;
    expect(findInterrupted(text, quote)?.interruptions).toBe(1);
  });

  it("cannot bridge an interruption that lands ON a hyphenated break", () => {
    // Documented limitation, not an oversight: the shared normal form joins
    // "high-\n" to whatever follows, so an interruption at exactly that
    // point glues the word to the boilerplate and leaves nothing to anchor.
    // Both halves would have to be re-split to recover it.
    const quote = "the high-performance participants displayed higher recall";
    const text = `the high-\n${COPYRIGHT}\nperformance participants displayed higher recall`;
    expect(findInterrupted(text, quote)).toBeNull();
  });

  it("refuses an interruption longer than the budget", () => {
    const filler = "x".repeat(MAX_INTERRUPTION_CHARS + 100);
    expect(findInterrupted(splitAround(QUOTE, 49, filler), QUOTE)).toBeNull();
  });

  it("refuses more interruptions than the budget", () => {
    let text = QUOTE;
    for (const at of [200, 140, 80, 40]) {
      text = splitAround(text, at, "Abbildung 3: Versuchsaufbau.");
    }
    expect(findInterrupted(text, QUOTE)).toBeNull();
  });

  it("refuses a quote assembled from fragments below the minimum", () => {
    // Every word of the quote is present, scattered — the thing this must
    // never accept, or it stops being a verbatim proof.
    const scattered = QUOTE.split(" ")
      .map((word) => `${word} ${"z".repeat(40)} `)
      .join("");
    expect(findInterrupted(scattered, QUOTE)).toBeNull();
  });

  it("completes a match whose final fragment is shorter than the minimum", () => {
    const at = QUOTE.length - Math.floor(MIN_FRAGMENT_CHARS / 2);
    const match = findInterrupted(
      splitAround(QUOTE, at, "Tabelle 1: Kennwerte."),
      QUOTE,
    );
    expect(match?.interruptions).toBe(1);
  });

  it("rejects wording that is absent however the text is cut", () => {
    expect(
      findInterrupted(
        `${QUOTE} ${COPYRIGHT}`,
        "Novizen lasen den Code zeilenweise",
      ),
    ).toBeNull();
  });

  it("rejects an empty needle", () => {
    expect(findInterrupted(QUOTE, "   ")).toBeNull();
  });

  it("does not match fragments that appear out of order", () => {
    const half = Math.floor(QUOTE.length / 2);
    const reversed = `${QUOTE.slice(half)}\n${COPYRIGHT}\n${QUOTE.slice(0, half)}`;
    expect(findInterrupted(reversed, QUOTE)).toBeNull();
  });
});

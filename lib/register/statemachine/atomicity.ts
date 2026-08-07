/**
 * Conservative atomicity heuristic of the extraction gate (TMB-25): an
 * extraction result that bundles multiple statements violates the claim
 * model (A1: atomar) and must not enter the verification pipeline as
 * "erfasst". The heuristic looks for internal sentence boundaries while
 * ignoring decimals, ordinals, initials and common German abbreviations.
 * It never needs to be perfect: a false positive costs one adjudication
 * review, a false negative is still caught by the human reading the claim —
 * routing, not dropping, either way.
 */

const ABBREVIATIONS = new Set([
  "z",
  "b",
  "u",
  "a",
  "d",
  "h",
  "o",
  "ä",
  "bzw",
  "bspw",
  "ca",
  "vgl",
  "etc",
  "usw",
  "ggf",
  "evtl",
  "inkl",
  "insb",
  "sog",
  "nr",
  "s",
  "abb",
  "tab",
  "kap",
  "abschn",
  "et",
  "al",
  "engl",
  "dt",
  "mio",
  "mrd",
]);

/** Internal sentence boundary: terminal punctuation, whitespace, then an
 * uppercase letter, digit or opening quote. */
const BOUNDARY = /([^\s.!?]*)([.!?])\s+(?=[\p{Lu}\d„"])/gu;

export function isAtomicClaimText(text: string): boolean {
  for (const match of text.trim().matchAll(BOUNDARY)) {
    const [, word, punct] = match;
    if (punct === "!" || punct === "?") {
      return false;
    }
    const cleaned = word.replace(/[„“”"'‚‘’()[\]{},;:]+/g, "").toLowerCase();
    if (/^\d+$/.test(cleaned)) {
      continue; // ordinal ("am 3. Januar") or enumerated number
    }
    if (/^\p{L}$/u.test(cleaned)) {
      continue; // initial ("A. Meyer")
    }
    if (ABBREVIATIONS.has(cleaned)) {
      continue; // "z. B.", "bzw.", "vgl." …
    }
    return false;
  }
  return true;
}

import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../../register";
import {
  failingExcerptsForSource,
  sourcesNeedingRepairEvaluation,
} from "./candidates";

/** Just the slice of the register the derivations look at. */
function registerWith(
  claims: Array<{
    status: string;
    routing?: string;
    evidence: Array<{ source_id: string; verbatim_excerpt: string }>;
  }>,
): ClaimsRegister {
  return {
    claims: claims.map((claim) => ({
      status: claim.status,
      history: claim.routing !== undefined ? [{ routing: claim.routing }] : [],
      evidence: claim.evidence,
    })),
  } as unknown as ClaimsRegister;
}

describe("sourcesNeedingRepairEvaluation", () => {
  it("collects only sources of claims stuck by a failed existence check", () => {
    const register = registerWith([
      {
        status: "pending_adjudication",
        routing: "existence_check_failed",
        evidence: [{ source_id: "src_kaputt", verbatim_excerpt: "Zitat." }],
      },
      // Adjudication for a DIFFERENT reason — not a repair candidate.
      {
        status: "pending_adjudication",
        routing: "quote_missing",
        evidence: [{ source_id: "src_zitat", verbatim_excerpt: "Anders." }],
      },
      // Not stuck at all.
      {
        status: "confirmed",
        evidence: [{ source_id: "src_ok", verbatim_excerpt: "Belegt." }],
      },
    ]);
    expect(sourcesNeedingRepairEvaluation(register)).toEqual(["src_kaputt"]);
  });
});

describe("failingExcerptsForSource", () => {
  it("returns only the requested source's excerpts from stuck claims", () => {
    const register = registerWith([
      {
        status: "pending_adjudication",
        routing: "existence_check_failed",
        evidence: [
          { source_id: "src_kaputt", verbatim_excerpt: "Erstes Zitat." },
          { source_id: "src_andere", verbatim_excerpt: "Fremdes Zitat." },
        ],
      },
      {
        status: "captured",
        evidence: [
          { source_id: "src_kaputt", verbatim_excerpt: "Nicht dran." },
        ],
      },
    ]);
    expect(failingExcerptsForSource(register, "src_kaputt")).toEqual([
      "Erstes Zitat.",
    ]);
  });
});

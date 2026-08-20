import { describe, expect, it } from "vitest";

import type { RoutingReason } from "@/lib/register";
import { deriveVerdict, type Verdict } from "../../verdict-labels";
import { ROUTING_LABELS, routingSupersededByVerdict } from "./routing-labels";

// Enumerated as a typed const (mirroring verdict-labels.test.ts) so an
// eighth routing reason fails to compile here instead of slipping through
// as an untested branch of the suppression gate.
const ROUTING_REASONS: RoutingReason[] = [
  "no_evidence",
  "existence_check_failed",
  "divergence",
  "negative_precheck",
  "spot_check",
  "escalated",
  "negative_relevance",
];

const SOME_VERDICT: Verdict = { phrase: "stützt", severity: "green" };

describe("ROUTING_LABELS", () => {
  it("labels every routing reason in German", () => {
    for (const reason of ROUTING_REASONS) {
      expect(ROUTING_LABELS[reason].length).toBeGreaterThan(0);
    }
  });

  // The suppression of the `divergence` chip is only correct as long as the
  // routing label and the divergence verdict phrase are the SAME string.
  // They are identical by construction: the pipeline sets
  // routing: "divergence" in the very transition that leaves
  // support_degree/calibration_result unset (see
  // lib/pipeline/verification/run-verification.ts), and deriveVerdict
  // returns its divergence branch exactly on that shape. If someone rewords
  // one label without the other, the chips stop saying the same thing and
  // suppressing one silently drops information. This assertion is what
  // turns that reword into a failing test instead of a resurrected
  // duplicate badge.
  it("keeps the divergence label identical to the divergence verdict phrase", () => {
    expect(ROUTING_LABELS.divergence).toBe(
      deriveVerdict(undefined, undefined, true)!.phrase,
    );
  });
});

describe("routingSupersededByVerdict", () => {
  it("suppresses divergence and negative_precheck when a verdict is rendered", () => {
    expect(routingSupersededByVerdict("divergence", SOME_VERDICT)).toBe(true);
    expect(routingSupersededByVerdict("negative_precheck", SOME_VERDICT)).toBe(
      true,
    );
  });

  it("keeps every informative routing reason visible", () => {
    const informative: RoutingReason[] = [
      "spot_check",
      "escalated",
      "negative_relevance",
      "no_evidence",
      "existence_check_failed",
    ];
    for (const reason of informative) {
      expect(routingSupersededByVerdict(reason, SOME_VERDICT)).toBe(false);
    }
  });

  it("suppresses nothing while no verdict chip is rendered", () => {
    for (const reason of ROUTING_REASONS) {
      expect(routingSupersededByVerdict(reason, null)).toBe(false);
    }
  });

  it("does not depend on which verdict phrase was produced", () => {
    const other = deriveVerdict("unsupported", "weakened", false);
    expect(routingSupersededByVerdict("divergence", other)).toBe(true);
    expect(routingSupersededByVerdict("spot_check", other)).toBe(false);
  });
});

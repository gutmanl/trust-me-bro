import { describe, expect, it } from "vitest";

import { runKindLabel as clientLabel } from "../app/projects/[id]/RunStatusProvider";
import { runKindLabel as serverLabel } from "../lib/pipeline/runs/labels";

/**
 * The client keeps its own copy of the RUN label map because the pipeline
 * barrel is server-only (it reaches node:fs) and must not be bundled into a
 * client component; the server map additionally carries the off-runner
 * trigger labels, whose per-instance descriptions travel in the activity
 * payload anyway. Two maps is a drift hazard — this test is the pin that
 * makes drift a red build instead of a silent mismatch.
 */
describe("run kind labels", () => {
  const RUN_KINDS = [
    "extraction",
    "verification",
    "reference_scan",
    "source_capture",
    "research",
    "relevance",
    "existence_check",
  ];

  it("client and server agree on every runner kind and the fallback", () => {
    for (const kind of RUN_KINDS) {
      expect(clientLabel(kind), kind).toBe(serverLabel(kind));
    }
    expect(clientLabel(null)).toBe(serverLabel(null));
    expect(clientLabel("unknown_kind")).toBe(serverLabel("unknown_kind"));
  });

  it("the server map names every off-runner trigger kind", () => {
    for (const kind of [
      "capture_failure_repair",
      "source_repair_evaluation",
      "anchor_repair",
      "briefing_substitution",
    ]) {
      expect(serverLabel(kind), kind).not.toBe("Lauf");
    }
  });
});

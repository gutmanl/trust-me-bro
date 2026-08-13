import { describe, expect, it } from "vitest";

import type {
  RepairActionVM,
  ReviewCandidate,
  SourceWorkItemVM,
} from "@/lib/pipeline";
import { deriveRailBuckets } from "./derive-rail-buckets";

const candidate = (
  id: string,
  overrides: Partial<ReviewCandidate> = {},
): ReviewCandidate => ({
  candidate_id: id,
  raw_text: `Zitat ${id}`,
  method: "doi",
  suggested_source_type: "peer_reviewed_publication",
  alreadyCaptured: false,
  capturable: true,
  selected: true,
  ...overrides,
});

const workItem = (
  workItemId: string,
  origin: SourceWorkItemVM["origin"],
  overrides: Partial<SourceWorkItemVM> = {},
): SourceWorkItemVM => ({
  workItemId,
  origin,
  label: `Eintrag ${workItemId}`,
  status: "failed",
  ...overrides,
});

const suggestion = (target: RepairActionVM["target"]): RepairActionVM => ({
  target,
  mode: "suggested",
  basis: "capture_failure_rematch",
  candidate: { kind: "doi", identifier: "10.1000/x" },
  reason: "Vorschlag.",
  recordedAt: "2026-08-01T08:00:00Z",
});

describe("deriveRailBuckets", () => {
  it("filters captured candidates out and counts the selected remainder", () => {
    const buckets = deriveRailBuckets({
      candidates: [
        candidate("cand_1"),
        candidate("cand_2", { alreadyCaptured: true }),
        candidate("cand_3", { selected: false }),
      ],
      workItems: [],
      repairSuggestions: [],
    });
    expect(buckets.openCandidates.map((c) => c.candidate_id)).toEqual([
      "cand_1",
      "cand_3",
    ]);
    expect(buckets.readyCandidateCount).toBe(1);
  });

  it("renders a reference-import item on its open candidate row, not standalone", () => {
    const item = workItem("cand_1", "reference_import");
    const buckets = deriveRailBuckets({
      candidates: [candidate("cand_1")],
      workItems: [item],
      repairSuggestions: [],
    });
    expect(buckets.workItemByCandidate.get("cand_1")).toBe(item);
    expect(buckets.standaloneWorkItems).toEqual([]);
  });

  it("keeps an orphaned reference-import item (candidate rescanned away) standalone", () => {
    const item = workItem("cand_gone", "reference_import");
    const buckets = deriveRailBuckets({
      candidates: [candidate("cand_1")],
      workItems: [item],
      repairSuggestions: [],
    });
    expect(buckets.standaloneWorkItems).toEqual([item]);
  });

  it("collects ALL correction items per source, never as standalone rows", () => {
    const first = workItem("wi_1", "correction", { targetSourceId: "src_1" });
    const second = workItem("wi_2", "auto_repair", {
      targetSourceId: "src_1",
      status: "capturing",
    });
    const buckets = deriveRailBuckets({
      candidates: undefined,
      workItems: [first, second],
      repairSuggestions: [],
    });
    expect(buckets.correctionsBySource.get("src_1")).toEqual([first, second]);
    expect(buckets.standaloneWorkItems).toEqual([]);
  });

  it("routes a target-less auto-repair item to its candidate row like a retry", () => {
    const retry = workItem("cand_1", "auto_repair");
    const buckets = deriveRailBuckets({
      candidates: [candidate("cand_1")],
      workItems: [retry],
      repairSuggestions: [],
    });
    expect(buckets.workItemByCandidate.get("cand_1")).toBe(retry);
    expect(buckets.standaloneWorkItems).toEqual([]);
  });

  it("always keeps manual capture items standalone", () => {
    const manual = workItem("wi_manual", "manual", { status: "queued" });
    const buckets = deriveRailBuckets({
      candidates: undefined,
      workItems: [manual],
      repairSuggestions: [],
    });
    expect(buckets.standaloneWorkItems).toEqual([manual]);
  });

  it("splits repair suggestions by target kind", () => {
    const forItem = suggestion({
      kind: "capture_failure",
      workItemId: "wi_1",
    });
    const forSource = suggestion({ kind: "source", sourceId: "src_1" });
    const buckets = deriveRailBuckets({
      candidates: undefined,
      workItems: [],
      repairSuggestions: [forItem, forSource],
    });
    expect(buckets.suggestionByWorkItem.get("wi_1")).toBe(forItem);
    expect(buckets.suggestionBySource.get("src_1")).toBe(forSource);
  });
});

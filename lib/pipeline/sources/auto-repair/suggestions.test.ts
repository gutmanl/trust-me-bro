import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import type { RepairAction } from "../../../register/schema/history";
import { PipelineError } from "../../errors";
import { createProject } from "../../projects";
import type {
  SourceCaptureItemInfo,
  SourceCaptureWorkItem,
} from "../work-items/types";
import {
  applySuggestedRepair,
  deriveOpenRepairActions,
  dismissRepairAction,
} from "./suggestions";

const PROJECT = "proj_repair-suggestions";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-suggest-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Überleben Vorschläge?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const SOURCE_SUGGESTION: RepairAction = {
  target: { kind: "source", source_id: "src_falsch" },
  mode: "suggested",
  basis: "quote_fit_rematch",
  candidate: {
    kind: "doi",
    identifier: "10.1109/TSE.2025.3489012",
    title: "Effects of AI Assistants on Code Review Duration",
  },
  confidence: 0.55,
  quote_fit: { candidate_matches: 0, current_matches: 0, checked_excerpts: 2 },
};

async function record(action: RepairAction): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.recordRepairAction({
      action,
      actor: "system:auto_repair",
      reason: "Reparaturvorschlag (Test).",
    });
  });
}

async function addSource(id: string): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.addSource({
      id,
      type: "document",
      title: "Falsch erfasst",
      custom: { source_type: "preprint" },
    });
  });
}

describe("deriveOpenRepairActions", () => {
  it("keeps only suggestions; applied actions are audit-only and supersede", async () => {
    await record(SOURCE_SUGGESTION);
    let open = deriveOpenRepairActions(
      await RegisterStore.forProject(PROJECT).read(),
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      target: { kind: "source", sourceId: "src_falsch" },
      candidate: { identifier: "10.1109/TSE.2025.3489012" },
      confidence: 0.55,
      quoteFit: { checkedExcerpts: 2 },
    });

    await record({ ...SOURCE_SUGGESTION, mode: "applied" });
    open = deriveOpenRepairActions(
      await RegisterStore.forProject(PROJECT).read(),
    );
    expect(open).toHaveLength(0);
  });

  it("maps a minimal payload (no confidence, no quote_fit, no title)", async () => {
    await record({
      target: { kind: "capture_failure", work_item_id: "cand_min" },
      mode: "suggested",
      basis: "capture_failure_rematch",
      candidate: { kind: "url", identifier: "https://example.org/report" },
    });
    const open = deriveOpenRepairActions(
      await RegisterStore.forProject(PROJECT).read(),
    );
    expect(open).toHaveLength(1);
    expect(open[0].confidence).toBeUndefined();
    expect(open[0].quoteFit).toBeUndefined();
    expect(open[0].candidate).toEqual({
      kind: "url",
      identifier: "https://example.org/report",
    });
    // Dismissal via the work_item_id scalar closes it.
    await dismissRepairAction(PROJECT, {
      kind: "capture_failure",
      workItemId: "cand_min",
    });
    expect(
      deriveOpenRepairActions(await RegisterStore.forProject(PROJECT).read()),
    ).toHaveLength(0);
  });

  it("a later identity correction of the target closes the suggestion", async () => {
    await addSource("src_falsch");
    await record(SOURCE_SUGGESTION);
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.recordIdentityCorrection({
        source_id: "src_falsch",
        previous_item: { title: "Alt" },
        new_item: { title: "Neu" },
        snapshot_revision: { from: 1, to: 2 },
        recheck_claim_ids: [],
        actor: "system:source_correction",
        reason: "Quellenkennung korrigiert (Test).",
      });
    });
    expect(
      deriveOpenRepairActions(await RegisterStore.forProject(PROJECT).read()),
    ).toHaveLength(0);
  });

  it("a capture-failure suggestion dies with its failure's resolution", async () => {
    await record({
      ...SOURCE_SUGGESTION,
      target: { kind: "capture_failure", work_item_id: "cand_0001" },
      basis: "capture_failure_rematch",
    });
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.addSource({
        id: "src_neu",
        type: "document",
        title: "Erfolgreich erfasst",
        custom: {
          source_type: "preprint",
          capture_attempt_id: "cand_0001",
        },
      });
    });
    expect(
      deriveOpenRepairActions(await RegisterStore.forProject(PROJECT).read()),
    ).toHaveLength(0);
  });
});

describe("dismissRepairAction", () => {
  it("hides the suggestion durably; a fresh one reopens", async () => {
    await record(SOURCE_SUGGESTION);
    await dismissRepairAction(PROJECT, {
      kind: "source",
      sourceId: "src_falsch",
    });
    const store = RegisterStore.forProject(PROJECT);
    expect(deriveOpenRepairActions(await store.read())).toHaveLength(0);
    // Chain order: a NEWER suggestion for the same target reopens.
    await record(SOURCE_SUGGESTION);
    expect(deriveOpenRepairActions(await store.read())).toHaveLength(1);
  });

  it("rejects a target without an open suggestion", async () => {
    await expect(
      dismissRepairAction(PROJECT, { kind: "source", sourceId: "src_x" }),
    ).rejects.toThrow(PipelineError);
  });

  it("apply rejects a capture-failure suggestion whose failure was dismissed away", async () => {
    // A suggestion can only outlive its failure through unusual chains;
    // guard anyway: dismissal of the FAILURE also kills the suggestion, so
    // applying afterwards must refuse with the no-open-suggestion error.
    await record({
      ...SOURCE_SUGGESTION,
      target: { kind: "capture_failure", work_item_id: "cand_weg" },
      basis: "capture_failure_rematch",
    });
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.recordProjectEvent({
        event: "source_capture_dismissed",
        reason: "Fehlgeschlagener Erfassungsversuch verworfen (Test).",
        actor: "human:lg",
        work_item_id: "cand_weg",
      });
    });
    await expect(
      applySuggestedRepair(PROJECT, {
        kind: "capture_failure",
        workItemId: "cand_weg",
      }),
    ).rejects.toThrow(/kein offener Reparaturvorschlag/);
  });
});

describe("applySuggestedRepair", () => {
  it("rejects a source target whose source has vanished", async () => {
    await record(SOURCE_SUGGESTION);
    await expect(
      applySuggestedRepair(PROJECT, { kind: "source", sourceId: "src_falsch" }),
    ).rejects.toThrow(/existiert nicht mehr/);
  });

  it("applies a URL candidate without identifier via its document URL", async () => {
    await addSource("src_url");
    await record({
      target: { kind: "source", source_id: "src_url" },
      mode: "suggested",
      basis: "quote_fit_rematch",
      candidate: {
        kind: "url",
        document_url: "https://publisher.example.org/paper.pdf",
      },
    });
    const enqueued: SourceCaptureWorkItem[] = [];
    const chain = {
      enqueueSourceCapture: (_p: string, item: SourceCaptureWorkItem) => {
        enqueued.push(item);
      },
      pendingCaptureItems: (): SourceCaptureItemInfo[] => [],
      activeCaptureItem: (): SourceCaptureItemInfo | undefined => undefined,
    };
    await applySuggestedRepair(
      PROJECT,
      { kind: "source", sourceId: "src_url" },
      { chain },
    );
    // No title, no identifier — the candidate kind is the fallback label.
    expect(enqueued[0].label).toBe("url");
    expect(enqueued[0].request).toEqual({
      kind: "url",
      sourceType: "preprint",
      targetSourceId: "src_url",
      documentUrl: "https://publisher.example.org/paper.pdf",
    });
  });

  it("refuses a source target while a correction is already in flight", async () => {
    await addSource("src_falsch");
    await record({
      ...SOURCE_SUGGESTION,
      candidate: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        document_url: "https://publisher.example.org/paper.pdf",
      },
    });
    const chain = {
      enqueueSourceCapture: () => {},
      pendingCaptureItems: (): SourceCaptureItemInfo[] => [
        {
          workItemId: "wi_läuft",
          origin: "correction",
          label: "Korrektur",
          targetSourceId: "src_falsch",
        },
      ],
      activeCaptureItem: (): SourceCaptureItemInfo | undefined => undefined,
    };
    await expect(
      applySuggestedRepair(
        PROJECT,
        { kind: "source", sourceId: "src_falsch" },
        { chain },
      ),
    ).rejects.toThrow(/läuft bereits eine Korrektur/);
    // The suggestion was NOT consumed by the refused apply.
    expect(
      deriveOpenRepairActions(await RegisterStore.forProject(PROJECT).read()),
    ).toHaveLength(1);
  });

  it("re-enqueues a capture-failure suggestion under the failure's own id", async () => {
    const { recordCaptureFailure } = await import("../work-items/failures");
    await recordCaptureFailure(
      PROJECT,
      {
        workItemId: "cand_0001",
        origin: "reference_import",
        label: "Kandidat",
        request: {
          kind: "doi",
          sourceType: "peer_reviewed_publication",
          identifier: "10.9999/halluziniert.123",
          autoCapture: { raw_text: "Meyer 2025", method: "doi" },
        },
      },
      new Error("DOI nicht auflösbar."),
    );
    await record({
      ...SOURCE_SUGGESTION,
      target: { kind: "capture_failure", work_item_id: "cand_0001" },
      basis: "capture_failure_rematch",
      candidate: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        document_url: "https://publisher.example.org/paper.pdf",
      },
    });
    const enqueued: SourceCaptureWorkItem[] = [];
    const chain = {
      enqueueSourceCapture: (_p: string, item: SourceCaptureWorkItem) => {
        enqueued.push(item);
      },
      pendingCaptureItems: (): SourceCaptureItemInfo[] => [],
      activeCaptureItem: (): SourceCaptureItemInfo | undefined => undefined,
    };
    const { workItemId } = await applySuggestedRepair(
      PROJECT,
      { kind: "capture_failure", workItemId: "cand_0001" },
      { chain },
    );
    expect(workItemId).toBe("cand_0001");
    expect(enqueued[0]).toMatchObject({
      workItemId: "cand_0001",
      origin: "auto_repair",
      request: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://publisher.example.org/paper.pdf",
        sourceType: "peer_reviewed_publication",
        autoCapture: { raw_text: "Meyer 2025", method: "crossref_title" },
      },
    });
  });

  it("enqueues the candidate as an auto_repair correction and consumes the suggestion", async () => {
    await addSource("src_falsch");
    await record(SOURCE_SUGGESTION);
    const enqueued: SourceCaptureWorkItem[] = [];
    const chain = {
      enqueueSourceCapture: (_p: string, item: SourceCaptureWorkItem) => {
        enqueued.push(item);
      },
      pendingCaptureItems: (): SourceCaptureItemInfo[] => [],
      activeCaptureItem: (): SourceCaptureItemInfo | undefined => undefined,
    };
    const { workItemId } = await applySuggestedRepair(
      PROJECT,
      { kind: "source", sourceId: "src_falsch" },
      { chain },
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      workItemId,
      origin: "auto_repair",
      request: {
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        targetSourceId: "src_falsch",
        sourceType: "preprint",
      },
    });
    const store = RegisterStore.forProject(PROJECT);
    expect(deriveOpenRepairActions(await store.read())).toHaveLength(0);
    // Applying again must fail — the suggestion was consumed.
    await expect(
      applySuggestedRepair(
        PROJECT,
        { kind: "source", sourceId: "src_falsch" },
        { chain },
      ),
    ).rejects.toThrow(PipelineError);
  });
});

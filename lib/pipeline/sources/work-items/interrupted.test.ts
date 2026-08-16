import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { createProject } from "../../projects";
import {
  closeTriggerBracket,
  openTriggerBracket,
} from "../../runs/trigger-brackets";
import { deriveOpenChainTriggers } from "../../runs/derive-brackets";
import {
  deriveInterruptedCaptureAttempts,
  dismissCaptureFailure,
  recordCaptureFailure,
} from "./failures";
import { getSourceWorkItems, retryInterruptedCapture } from "./queue";
import type { SourceCaptureWorkItem } from "./types";

const PROJECT_ID = "proj_interrupted-captures";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-wi-interrupted-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT_ID,
    research_question: "Bleibt Unterbrochenes sichtbar?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

const ATTEMPT = {
  work_item_id: "wi_cut",
  origin: "manual" as const,
  input: {
    kind: "doi" as const,
    source_type: "peer_reviewed_publication" as const,
    identifier: "10.1/x",
  },
};

async function openCaptureBracket(workItemId = "wi_cut") {
  await openTriggerBracket({
    projectId: PROJECT_ID,
    kind: "source_capture",
    workItemId,
    captureAttempt: { ...ATTEMPT, work_item_id: workItemId },
  });
}

describe("interrupted capture attempts (run visibility)", () => {
  it("an open start bracket derives as interrupted, with the retryable input", async () => {
    await openCaptureBracket();
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    const interrupted = deriveInterruptedCaptureAttempts(register);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      workItemId: "wi_cut",
      origin: "manual",
      input: { identifier: "10.1/x" },
    });
    // …and it reaches the rail as an "interrupted" row.
    const rows = getSourceWorkItems(PROJECT_ID, register, {
      chain: {
        enqueueSourceCapture: () => {},
        pendingCaptureItems: () => [],
        activeCaptureItem: () => undefined,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("interrupted");
  });

  it("a recorded failure closes the bracket — the failure row takes over", async () => {
    await openCaptureBracket();
    await recordCaptureFailure(
      PROJECT_ID,
      {
        workItemId: "wi_cut",
        origin: "manual",
        label: "x",
        request: { kind: "doi", sourceType: "peer_reviewed_publication" },
      } as SourceCaptureWorkItem,
      new Error("kaputt"),
    );
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(deriveInterruptedCaptureAttempts(register)).toHaveLength(0);
  });

  it("dismissing an interrupted attempt closes it without a failure event", async () => {
    await openCaptureBracket();
    await dismissCaptureFailure(PROJECT_ID, "wi_cut");
    const register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(deriveInterruptedCaptureAttempts(register)).toHaveLength(0);
  });

  it("retryInterruptedCapture re-queues from the bracket's snapshot, same id", async () => {
    await openCaptureBracket();
    const enqueued: SourceCaptureWorkItem[] = [];
    await retryInterruptedCapture(PROJECT_ID, "wi_cut", {
      chain: {
        enqueueSourceCapture: (_p, item) => {
          enqueued.push(item);
        },
        pendingCaptureItems: () => [],
        activeCaptureItem: () => undefined,
      },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      workItemId: "wi_cut",
      origin: "manual",
      request: { kind: "doi", identifier: "10.1/x" },
    });
  });

  it("evaluator brackets open and close through the real writers", async () => {
    await openTriggerBracket({
      projectId: PROJECT_ID,
      kind: "source_repair_evaluation",
      sourceId: "src_a",
    });
    let register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(deriveOpenChainTriggers(register.project_events)).toHaveLength(1);

    await closeTriggerBracket({
      projectId: PROJECT_ID,
      kind: "source_repair_evaluation",
      sourceId: "src_a",
      outcome: "completed",
    });
    register = await RegisterStore.forProject(PROJECT_ID).read();
    expect(deriveOpenChainTriggers(register.project_events)).toHaveLength(0);
  });
});

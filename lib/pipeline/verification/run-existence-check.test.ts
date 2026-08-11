import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { createProject } from "../projects";
import { createJobRunner } from "../runs/job-runner";
import type { JobRunner } from "../runs/job-runner";
import { captureSource } from "../sources/capture";
import { reviseSource } from "../sources/revise";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import {
  getOpenExistenceCheckCount,
  startExistenceCheck,
} from "./run-existence-check";

const PROJECT = "proj_existenzpruefung";
const MATCHING_TEXT = Buffer.from("Die Reviewzeit sank messbar im Test.");
const OTHER_TEXT = Buffer.from("Ein völlig anderer Inhalt ohne den Beleg.");

let workspace: string;
let runner: JobRunner;
let nextClaim: number;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-existence-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  runner = createJobRunner();
  nextClaim = 0;
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function captureMatchingSource(): Promise<string> {
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Bericht", year: "2026" },
      upload: { content: MATCHING_TEXT, filename: "match.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  return source.id;
}

async function captureNonMatchingSource(): Promise<string> {
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Anderer Bericht", year: "2026" },
      upload: { content: OTHER_TEXT, filename: "other.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  return source.id;
}

/** Every claim minted here cites the same fixed verbatim excerpt
 * ("Reviewzeit sank" — see addClaimWalkedTo), so a claim on a matching
 * source passes stage 1 and one on a non-matching source fails it. */
async function addClaim(
  sourceId: string,
  status: "captured" | "existence_checked" = "captured",
): Promise<string> {
  nextClaim += 1;
  return addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: nextClaim,
    sourceId,
    status,
  });
}

async function readRegister() {
  return RegisterStore.forProject(PROJECT).read();
}

function claimStatusOf(
  register: Awaited<ReturnType<typeof readRegister>>,
  claimId: string,
) {
  return register.claims.find((claim) => claim.id === claimId)?.status;
}

describe("startExistenceCheck", () => {
  it("passes a captured claim whose wording is proven — existence_checked, no LLM/preflight", async () => {
    const sourceId = await captureMatchingSource();
    const claimId = await addClaim(sourceId);

    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    const register = await readRegister();
    const claim = register.claims.find((c) => c.id === claimId);
    expect(claim?.status).toBe("existence_checked");
    expect(claim?.evidence[0].existence_check?.status).toBe("passed");
    expect(claim?.history.map((h) => h.to_status)).toEqual([
      "captured",
      "existence_checked",
    ]);
    expect(handle.kind).toBe("existence_check");

    const results = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) =>
        event.type === "item_completed" ? event.outcome.result : undefined,
      );
    expect(results).toEqual([{ checked: 1, passed: 1, failed: 0 }]);
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });

  it("routes a claim whose wording is not proven to pending_adjudication", async () => {
    const sourceId = await captureNonMatchingSource();
    const claimId = await addClaim(sourceId);

    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    const register = await readRegister();
    const claim = register.claims.find((c) => c.id === claimId);
    expect(claim?.status).toBe("pending_adjudication");
    expect(claim?.evidence[0].existence_check?.status).toBe("failed");
    expect(claim?.history.at(-1)?.routing).toBe("existence_check_failed");

    const results = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) =>
        event.type === "item_completed" ? event.outcome.result : undefined,
      );
    expect(results).toEqual([{ checked: 1, passed: 0, failed: 1 }]);
  });

  it("re-admits a recheck_required claim: captured, then existence_checked again", async () => {
    const sourceId = await captureMatchingSource();
    const claimId = await addClaim(sourceId, "existence_checked");

    // A revision with different (still matching) content pulls the settled
    // claim into recheck_required.
    await reviseSource(
      {
        projectId: PROJECT,
        sourceId,
        upload: {
          content: Buffer.concat([MATCHING_TEXT, Buffer.from(" Zusatz.")]),
          filename: "match.txt",
        },
      },
      { fetcher: fakeFetcher({}) },
    );
    expect(claimStatusOf(await readRegister(), claimId)).toBe(
      "recheck_required",
    );

    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    const register = await readRegister();
    const claim = register.claims.find((c) => c.id === claimId);
    expect(claim?.status).toBe("existence_checked");
    expect(claim?.history.map((h) => h.to_status)).toEqual([
      "captured",
      "existence_checked",
      "recheck_required",
      "captured",
      "existence_checked",
    ]);
  });

  it("skips claims outside captured/recheck_required — untouched, not even started", async () => {
    const sourceId = await captureMatchingSource();
    nextClaim += 1;
    const awaiting = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: nextClaim,
      sourceId,
      status: "pending_adjudication",
    });
    nextClaim += 1;
    const confirmed = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: nextClaim,
      sourceId,
      status: "confirmed",
    });

    const before = await readRegister();
    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    expect(
      handle.eventsSoFar().filter((event) => event.type === "item_started"),
    ).toHaveLength(0);
    const after = await readRegister();
    expect(claimStatusOf(after, awaiting)).toBe("pending_adjudication");
    expect(claimStatusOf(after, confirmed)).toBe("confirmed");
    expect(after).toEqual(before);
  });

  it("checks claims in register order and reports the running summary per item", async () => {
    const matching = await captureMatchingSource();
    const nonMatching = await captureNonMatchingSource();
    const first = await addClaim(matching);
    const second = await addClaim(nonMatching);

    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    const itemIds = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) => event.itemId);
    expect(itemIds).toEqual([first, second]);

    const results = handle
      .eventsSoFar()
      .filter((event) => event.type === "item_completed")
      .map((event) =>
        event.type === "item_completed" ? event.outcome.result : undefined,
      );
    expect(results).toEqual([
      { checked: 1, passed: 1, failed: 0 },
      { checked: 2, passed: 1, failed: 1 },
    ]);
  });

  it("records no project event — state derives from claim statuses alone", async () => {
    const sourceId = await captureMatchingSource();
    await addClaim(sourceId);
    const before = (await readRegister()).project_events;

    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    const after = (await readRegister()).project_events;
    expect(after).toHaveLength(before.length);
    expect(after.some((event) => event.event.includes("existence_check"))).toBe(
      false,
    );
  });

  it("runs with zero eligible claims without error", async () => {
    const handle = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await handle.done;
    expect(
      handle.eventsSoFar().filter((event) => event.type === "item_completed"),
    ).toHaveLength(0);
  });

  it("blocks concurrent runs on the same project", async () => {
    const sourceId = await captureMatchingSource();
    await addClaim(sourceId);
    const first = await startExistenceCheck(PROJECT, {
      runner,
      fetcher: fakeFetcher({}),
    });
    await expect(
      startExistenceCheck(PROJECT, { runner, fetcher: fakeFetcher({}) }),
    ).rejects.toThrow(/bereits ein Lauf/);
    await first.done;
  });
});

describe("getOpenExistenceCheckCount", () => {
  it("counts only captured and recheck_required claims", async () => {
    const sourceId = await captureMatchingSource();
    await addClaim(sourceId, "captured");
    await addClaim(sourceId, "existence_checked");
    nextClaim += 1;
    await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: nextClaim,
      sourceId,
      status: "pending_adjudication",
    });

    expect(getOpenExistenceCheckCount(await readRegister())).toBe(1);
  });
});

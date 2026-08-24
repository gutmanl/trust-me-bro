import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore, verifyChain } from "../../register";
import type { ClaimsRegister } from "../../register";
import { RunActiveError } from "../errors";
import { createProject } from "../projects";
import { createJobRunner } from "../runs/job-runner";
import { captureSource } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { requestClaimRecheck } from "./request-recheck";

const PROJECT = "proj_nachpruefung";
const DOCUMENT = Buffer.from("Die Reviewzeit sank von 42 auf 19 Minuten.");

let workspace: string;
let sourceId: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-recheck-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Studie", authors: "Studie, A." },
      upload: { content: DOCUMENT, filename: "studie.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  sourceId = source.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function readRegister(): Promise<ClaimsRegister> {
  return RegisterStore.forProject(PROJECT).read();
}

function bracketEvents(register: ClaimsRegister) {
  return register.project_events.filter((event) =>
    event.event.startsWith("reverification_run"),
  );
}

/** A runner holding the project's single-writer seat for the whole test. */
function busyRunner() {
  const runner = createJobRunner();
  runner.submit(
    PROJECT,
    ["item"],
    (item) => item,
    () => new Promise((resolve) => setTimeout(() => resolve("ok"), 50)),
    { kind: "verification" },
  );
  return runner;
}

describe("requestClaimRecheck", () => {
  it("moves a prechecked claim and brackets the request in the chain", async () => {
    const claimId = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "prechecked",
    });

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      claimIds: [claimId],
    });

    expect(result).toEqual({ moved: [claimId], excluded: [] });
    const register = await readRegister();
    expect(register.claims[0].status).toBe("recheck_required");
    const bracket = bracketEvents(register);
    expect(bracket.map((event) => event.event)).toEqual([
      "reverification_run_started",
      "reverification_run_completed",
    ]);
    expect(bracket[0].reverification_run?.claim_ids).toEqual([claimId]);
    // The human's intent lives on the bracket; the machine's transition
    // carries the system token.
    expect(bracket[0].actor).toBe("human:lg");
    expect(register.claims[0].history.at(-1)?.actor).toBe(
      "system:recheck_request",
    );
    expect(verifyChain(register).ok).toBe(true);
  });

  it("skips a claim raced out from under the request and omits it from the bracket", async () => {
    const stable = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "prechecked",
    });
    const raced = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 2,
      sourceId,
      status: "auto_confirmed",
    });
    // The race: the second claim is drawn into manual review between the
    // use-case's read and its transaction, so by the time the lock is held
    // it sits mid human-workflow and must not be yanked out from under the
    // reviewer. Simulated by a store whose read returns the pre-race
    // register while the transaction sees the post-race one.
    const store = RegisterStore.forProject(PROJECT);
    const staleRegister = await store.read();
    await store.transaction((tx) => {
      tx.transitionClaim(raced, {
        to: "pending_adjudication",
        actor: "system:spot_check",
        reason: "Stichprobe gezogen, bevor die Nachprüfung griff.",
      });
    });
    const racingStore = Object.create(store) as RegisterStore;
    racingStore.read = async () => staleRegister;
    vi.spyOn(RegisterStore, "forProject").mockReturnValue(racingStore);

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      claimIds: [stable, raced],
    });
    vi.restoreAllMocks();

    expect(result.moved).toEqual([stable]);
    expect(result.excluded).toEqual([{ claimId: raced, reason: "raced" }]);
    const register = await readRegister();
    expect(bracketEvents(register)[0].reverification_run?.claim_ids).toEqual([
      stable,
    ]);
    expect(register.claims.find((claim) => claim.id === raced)?.status).toBe(
      "pending_adjudication",
    );
    expect(verifyChain(register).ok).toBe(true);
  });

  it("refuses while a run is active and moves nothing", async () => {
    const claimId = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "prechecked",
    });
    const before = await readRegister();

    const attempt = requestClaimRecheck(
      { projectId: PROJECT, claimIds: [claimId] },
      { runner: busyRunner() },
    );
    await expect(attempt).rejects.toBeInstanceOf(RunActiveError);
    // Identity, not substring: the shipped message is the contract the
    // ErrorBanner renders verbatim.
    await expect(attempt).rejects.toThrow(new RunActiveError(PROJECT).message);

    const after = await readRegister();
    expect(after.claims.map((claim) => claim.status)).toEqual(
      before.claims.map((claim) => claim.status),
    );
    expect(bracketEvents(after)).toHaveLength(0);
  });

  it("moves a claim once: the second request finds it ineligible", async () => {
    const claimId = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "prechecked",
    });
    await requestClaimRecheck({ projectId: PROJECT, claimIds: [claimId] });
    const afterFirst = await readRegister();

    const second = await requestClaimRecheck({
      projectId: PROJECT,
      claimIds: [claimId],
    });

    expect(second).toEqual({ moved: [], excluded: [] });
    const afterSecond = await readRegister();
    expect(afterSecond.claims[0].history).toHaveLength(
      afterFirst.claims[0].history.length,
    );
    expect(bracketEvents(afterSecond)).toHaveLength(2);
    expect(verifyChain(afterSecond).ok).toBe(true);
  });

  it("moves every eligible source status and leaves the rest alone", async () => {
    const eligible = await Promise.all(
      (["existence_checked", "prechecked", "auto_confirmed"] as const).map(
        (status, index) =>
          addClaimWalkedTo({
            projectId: PROJECT,
            claimNumber: index + 1,
            sourceId,
            status,
          }),
      ),
    );
    const midWorkflow = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 9,
      sourceId,
      status: "pending_adjudication",
    });

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      claimIds: [...eligible, midWorkflow],
    });

    expect(result.moved).toEqual(eligible);
    // An ineligible-from-the-start claim is not an exclusion the reviewer
    // needs explained here — it was never selected. Only a claim that moved
    // between the read and the lock is reported as raced.
    expect(result.excluded).toEqual([]);
    const register = await readRegister();
    expect(
      register.claims.find((claim) => claim.id === midWorkflow)?.status,
    ).toBe("pending_adjudication");
  });
});

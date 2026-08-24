import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore, verifyChain } from "../../register";
import type { ClaimsRegister } from "../../register";
import { InvalidProjectInputError, RunActiveError } from "../errors";
import { createProject } from "../projects";
import { createJobRunner } from "../runs/job-runner";
import { captureSource } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { requestClaimRecheck, selectClaimsForScope } from "./request-recheck";
import type { RecheckScope } from "./request-recheck";
import { loadRubricRuleSet } from "./rubric-rules";
import { pickUnfinishedClaims } from "./select-claims";

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

/**
 * The prompt-template version THIS project's pin resolves — read the way the
 * production code reads it, so the assertions below keep meaning when the
 * default rubric version moves. No test in this file names a version string.
 */
async function currentPromptVersion(): Promise<string> {
  const register = await readRegister();
  return loadRubricRuleSet(register.config.rubric_version)
    .prompt_template_version;
}

/** Stamps a claim's calibration with a prompt-template vintage, the way a
 * real stage-2/3 run does. */
async function stampVintage(claimId: string, version: string): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.setCalibrationResult(claimId, "licensed", "Begründung.", version);
  });
}

/**
 * A claim parked in the adjudication queue with NO structured routing
 * reason — the P-20 legacy shape. Written by hand because the walk fixture
 * always sets `routing`, and this is precisely the case that predates the
 * routing extension.
 */
async function parkWithoutRouting(claimId: string): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: "system:spot_check",
      reason: "Ohne maschinellen Einordnungsvermerk geparkt (Altbestand).",
    });
  });
}

async function selectIds(
  scope: RecheckScope,
  excluded: readonly string[] = [],
): Promise<string[]> {
  const register = await readRegister();
  return selectClaimsForScope(
    register,
    scope,
    await currentPromptVersion(),
    new Set(excluded),
  ).claims.map((claim) => claim.id);
}

async function breakdownFor(
  scope: RecheckScope,
  excluded: readonly string[] = [],
) {
  const register = await readRegister();
  return selectClaimsForScope(
    register,
    scope,
    await currentPromptVersion(),
    new Set(excluded),
  ).breakdown;
}

/**
 * One register covering every disposition the ladder has to tell apart.
 * Ids are stable (`clm_000N`) so the rung assertions can name exact SETS
 * rather than counts — a count would pass while selecting the wrong claims.
 */
async function seedLadder(): Promise<Record<string, string>> {
  const staleClaim = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 1,
    sourceId,
    status: "prechecked",
  });
  const currentClaim = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 2,
    sourceId,
    status: "prechecked",
  });
  await stampVintage(currentClaim, await currentPromptVersion());
  const autoConfirmed = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 3,
    sourceId,
    status: "auto_confirmed",
  });
  const confirmed = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 4,
    sourceId,
    status: "confirmed",
  });
  const queued = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 5,
    sourceId,
    status: "pending_adjudication",
  });
  const legacy = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 6,
    sourceId,
    status: "auto_confirmed",
  });
  await parkWithoutRouting(legacy);
  const discarded = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 7,
    sourceId,
    status: "discarded",
  });
  const captured = await addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: 8,
    sourceId,
    status: "captured",
  });
  return {
    staleClaim,
    currentClaim,
    autoConfirmed,
    confirmed,
    queued,
    legacy,
    discarded,
    captured,
  };
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

  it("moves every eligible source status, including a machine-parked one", async () => {
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
    // The FIFTH source status, reachable only through 04-03's widened gate:
    // a claim a machine parked in the queue WITH a structured routing
    // reason. Before that widening this claim stayed put; admitting it is
    // the point of the gate, and RERUN-04's exclusion — not the status —
    // is what protects a claim the reviewer is working on.
    const machineParked = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 9,
      sourceId,
      status: "pending_adjudication",
    });
    // …and one parked BEFORE the routing extension, which the gate refuses.
    const legacyParked = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 10,
      sourceId,
      status: "auto_confirmed",
    });
    await parkWithoutRouting(legacyParked);

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      claimIds: [...eligible, machineParked, legacyParked],
    });

    expect(result.moved).toEqual([...eligible, machineParked]);
    // Excluded, never missing (P-20): the legacy claim is named with its
    // reason rather than silently absent from a total nobody can reconcile.
    expect(result.excluded).toEqual([
      { claimId: legacyParked, reason: "legacy_unrouted" },
    ]);
    const register = await readRegister();
    expect(
      register.claims.find((claim) => claim.id === legacyParked)?.status,
    ).toBe("pending_adjudication");
  });

  it("rejects an unrecognised scope instead of falling through to the widest rung", async () => {
    await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "confirmed",
    });
    const before = await readRegister();

    await expect(
      requestClaimRecheck({
        projectId: PROJECT,
        scope: "everything" as unknown as RecheckScope,
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
    // Belt and braces: naming both modes at once is the same mistake.
    await expect(
      requestClaimRecheck({
        projectId: PROJECT,
        claimIds: [],
        scope: "all",
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);

    const after = await readRegister();
    expect(after.claims.map((claim) => claim.status)).toEqual(
      before.claims.map((claim) => claim.status),
    );
  });
});

describe("the scope ladder", () => {
  it("nests three rungs, each a strict superset of the previous", async () => {
    const ids = await seedLadder();

    const stale = await selectIds("stale");
    const all = await selectIds("all");
    const everything = await selectIds("all_including_confirmed");

    // Exact SETS, not counts: a count passes while selecting the wrong
    // claims, which is the failure the itemisation exists to prevent.
    expect(stale).toEqual([ids.staleClaim, ids.autoConfirmed, ids.queued]);
    expect(all).toEqual([
      ids.staleClaim,
      ids.currentClaim,
      ids.autoConfirmed,
      ids.queued,
    ]);
    expect(everything).toEqual([
      ids.staleClaim,
      ids.currentClaim,
      ids.autoConfirmed,
      ids.confirmed,
      ids.queued,
    ]);
    // The nesting itself, asserted directly rather than inferred from the
    // three lists above.
    expect(all).toEqual(expect.arrayContaining(stale));
    expect(everything).toEqual(expect.arrayContaining(all));
    expect(stale.length).toBeLessThan(all.length);
    expect(all.length).toBeLessThan(everything.length);
  });

  it("keeps a human-confirmed claim off the lower two rungs and on the top one", async () => {
    const ids = await seedLadder();

    expect(await selectIds("stale")).not.toContain(ids.confirmed);
    expect(await selectIds("all")).not.toContain(ids.confirmed);
    expect(await selectIds("all_including_confirmed")).toContain(ids.confirmed);
    // Rung-definitional, so counted rather than listed per claim.
    expect((await breakdownFor("all")).human_confirmed).toBe(1);
    expect(
      (await breakdownFor("all_including_confirmed")).human_confirmed,
    ).toBe(0);
  });

  it("treats an absent calibration vintage as legacy, hence stale", async () => {
    const ids = await seedLadder();
    const register = await readRegister();
    const unstamped = register.claims.find(
      (claim) => claim.id === ids.staleClaim,
    );

    expect(unstamped?.calibration_prompt_version).toBeUndefined();
    expect(await selectIds("stale")).toContain(ids.staleClaim);
  });

  it("shrinks the stale rung as claims are re-verified under the current version", async () => {
    const ids = await seedLadder();
    const before = await selectIds("stale");

    await stampVintage(ids.staleClaim, await currentPromptVersion());
    const after = await selectIds("stale");

    // The behaviour the UI must render as progress, not as a defect.
    expect(after.length).toBeLessThan(before.length);
    expect(after).not.toContain(ids.staleClaim);
    expect(before).toContain(ids.staleClaim);
    expect((await breakdownFor("stale")).vintage_current).toBe(2);
    // …and the wider rungs are unmoved by a vintage change.
    expect(await selectIds("all")).toContain(ids.staleClaim);
  });

  it("counts the terminal and legacy groups instead of dropping them", async () => {
    const ids = await seedLadder();

    const breakdown = await breakdownFor("stale");
    expect(breakdown.discarded).toBe(1);
    expect(breakdown.legacy_unrouted).toBe(1);
    expect(breakdown.vintage_current).toBe(1);
    expect(breakdown.human_confirmed).toBe(1);
    expect(breakdown.open_in_workbench).toBe(0);
    // A `captured` claim is neither selected nor excluded: the sweep was
    // never going to touch it, and padding the report with claims that were
    // never in scope is its own kind of unreconcilable count.
    expect(await selectIds("all_including_confirmed")).not.toContain(
      ids.captured,
    );
  });

  it("moves nothing and appends no bracket event when a rung selects nothing", async () => {
    await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "captured",
    });
    const before = await readRegister();

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      scope: "stale",
    });

    expect(result).toEqual({ moved: [], excluded: [] });
    const after = await readRegister();
    expect(after.project_events.length).toBe(before.project_events.length);
    expect(bracketEvents(after)).toHaveLength(0);
  });

  it("hands the sweep's claims to the run through pickUnfinishedClaims", async () => {
    await seedLadder();

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      scope: "all_including_confirmed",
    });

    // The composition IS the resumability (D-08, ROADMAP must-not): the
    // sweep sets status, and the run's own work set — recomputed from the
    // register at every start — picks it up. Nothing here enumerates a
    // list that a crash could strand.
    const unfinished = pickUnfinishedClaims(await readRegister()).map(
      (claim) => claim.id,
    );
    expect(result.moved.length).toBeGreaterThan(0);
    expect(unfinished).toEqual(expect.arrayContaining(result.moved));
  });
});

describe("the claim the reviewer is working on (RERUN-04)", () => {
  it("removes the excluded id from the sweep and reports it as open in the workbench", async () => {
    const ids = await seedLadder();

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      scope: "all",
      excludeClaimIds: [ids.autoConfirmed],
    });

    expect(result.moved).not.toContain(ids.autoConfirmed);
    expect(result.excluded).toContainEqual({
      claimId: ids.autoConfirmed,
      reason: "open_in_workbench",
    });
    const register = await readRegister();
    expect(
      register.claims.find((claim) => claim.id === ids.autoConfirmed)?.status,
    ).toBe("auto_confirmed");
    // The bracket describes what happened, so the excluded claim is not in
    // it either.
    expect(
      bracketEvents(register)[0].reverification_run?.claim_ids,
    ).not.toContain(ids.autoConfirmed);
    expect(verifyChain(register).ok).toBe(true);
  });

  it("reports a doubly-excludable id exactly once, under the displayed group", async () => {
    const ids = await seedLadder();

    // This claim qualifies for TWO exclusion reasons on the stale rung:
    // it is human-confirmed AND the reviewer has it open. It must appear
    // once, and under the group the confirmation actually renders.
    const result = await requestClaimRecheck({
      projectId: PROJECT,
      scope: "stale",
      excludeClaimIds: [ids.confirmed],
    });

    const appearances = result.excluded.filter(
      (exclusion) => exclusion.claimId === ids.confirmed,
    );
    expect(appearances).toHaveLength(1);
    expect(appearances[0].reason).toBe("open_in_workbench");
  });

  it("lets one raced claim cost one claim, not the whole sweep", async () => {
    const total = 40;
    const claimIds: string[] = [];
    for (let index = 1; index <= total; index += 1) {
      claimIds.push(
        await addClaimWalkedTo({
          projectId: PROJECT,
          claimNumber: index,
          sourceId,
          status: "prechecked",
        }),
      );
    }
    // One claim is drawn into manual review between the use-case's read and
    // its transaction. Simulated the way the single-claim case is: a store
    // whose read returns the pre-race register while the transaction sees
    // the post-race one.
    const raced = claimIds[17];
    const store = RegisterStore.forProject(PROJECT);
    const staleRegister = await store.read();
    await store.transaction((tx) => {
      tx.transitionClaim(raced, {
        to: "auto_confirmed",
        actor: "system:precheck",
        reason: "Vorprüfung durchgehend positiv.",
      });
      // Parked WITHOUT a routing reason, so the widened gate refuses it and
      // the in-transaction re-derivation finds it no longer selectable.
      tx.transitionClaim(raced, {
        to: "pending_adjudication",
        actor: "system:spot_check",
        reason: "Ohne maschinellen Einordnungsvermerk geparkt.",
      });
    });
    const racingStore = Object.create(store) as RegisterStore;
    racingStore.read = async () => staleRegister;
    vi.spyOn(RegisterStore, "forProject").mockReturnValue(racingStore);

    const result = await requestClaimRecheck({
      projectId: PROJECT,
      scope: "all",
    });
    vi.restoreAllMocks();

    expect(result.moved).toHaveLength(total - 1);
    expect(result.moved).not.toContain(raced);
    expect(result.excluded).toContainEqual({ claimId: raced, reason: "raced" });
    const register = await readRegister();
    // The ids describe what happened, not what was asked for.
    expect(
      bracketEvents(register)[0].reverification_run?.claim_ids,
    ).toHaveLength(total - 1);
    expect(register.claims.find((claim) => claim.id === raced)?.status).toBe(
      "pending_adjudication",
    );
    expect(verifyChain(register).ok).toBe(true);
  });
});

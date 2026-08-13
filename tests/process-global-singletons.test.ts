import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * One process, one instance — proven against a SECOND module instance.
 *
 * Next compiles route handlers and server components/actions into separate
 * module graphs, so a module-scoped `let singleton` becomes two variables in
 * one process. That is not hypothetical: it is why the project event stream
 * went silent. The SSE route's `getGlobalJobRunner()` returned a runner no
 * run had ever been submitted to, so no progress event ever reached the
 * client, while server actions and page renders agreed among themselves on
 * the other instance — the page updated on a manual reload or on any action
 * that revalidated it, and never on its own.
 *
 * `vi.resetModules()` reproduces exactly that: the next import evaluates a
 * fresh module instance the way the second bundle does. Every process-global
 * below must survive it, or it is not process-global.
 */

afterEach(() => {
  vi.resetModules();
});

/** Evaluates `load` against two independent module instances. */
async function acrossModuleInstances<T>(load: () => Promise<T>): Promise<{
  first: T;
  second: T;
}> {
  const first = await load();
  vi.resetModules();
  const second = await load();
  return { first, second };
}

describe("process-global singletons", () => {
  it("hands the job runner to both instances — the run one starts, the other observes", async () => {
    const { first, second } = await acrossModuleInstances(async () =>
      (await import("@/lib/pipeline/runs/job-runner")).getGlobalJobRunner(),
    );
    expect(second).toBe(first);
  });

  it("hands the auto-chain to both instances", async () => {
    const { first, second } = await acrossModuleInstances(async () =>
      (await import("@/lib/pipeline/runs/auto-chain")).getGlobalAutoChain(),
    );
    expect(second).toBe(first);
  });

  it("keeps ONE CLI concurrency gate — two would double the subscription's quota", async () => {
    const { first, second } = await acrossModuleInstances(async () =>
      (
        await import("@/lib/adapters/runtime/concurrency-gate")
      ).getGlobalConcurrencyGate(),
    );
    expect(second).toBe(first);
  });

  it("shows a login probe taken in one instance to the other", async () => {
    const probe = {
      stage: "login" as const,
      ok: true,
      checkedAt: "2026-08-13T12:00:00.000Z",
    };
    const first = await import("@/lib/adapters/health/cache");
    first.setCachedLoginProbe("claude", probe as never);
    vi.resetModules();
    const second = await import("@/lib/adapters/health/cache");

    // The probe costs real quota, so a second instance re-probing instead of
    // reading this is a bill, not just a staleness bug.
    expect(second.getCachedLoginProbe("claude")).toEqual(probe);
  });
});

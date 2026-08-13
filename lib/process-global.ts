/**
 * One instance per PROCESS, not per module instance.
 *
 * A `let singleton` at module scope is process-global only if the module is
 * evaluated once — and under Next it is not. Route handlers and server
 * components/actions are compiled into separate module graphs, so the same
 * file is evaluated twice in one process and each copy gets its own
 * variable. The two halves of the application then disagree in silence.
 *
 * That is the bug this exists to prevent, and it is not theoretical: the
 * project event stream (`app/api/projects/[id]/events/stream`) called
 * `getGlobalJobRunner()` from the route-handler graph and got a runner no
 * run had ever been submitted to. It attached to it correctly and streamed
 * nothing, forever. The workbench then updated only on a manual reload or on
 * a server action's `revalidatePath` — the two paths that re-render from the
 * register — and never from the live stream.
 *
 * Anchoring the instance on `globalThis` is what makes "process-global"
 * actually mean the process: every module instance resolves the same object,
 * because `globalThis` is the one thing they provably share.
 *
 * Deliberately survives a dev hot reload as well. The runner owns in-flight
 * runs and the gate owns the subscription's remaining quota; dropping either
 * mid-run to pick up an edited module would abort real work and double a
 * concurrency limit that exists to stay inside an account's terms. Stale code
 * until the next restart is the cheaper of the two failures.
 */

const REGISTRY_KEY = "__trustmebro_process_globals__";

type Registry = Map<string, unknown>;

function registry(): Registry {
  const host = globalThis as Record<string, unknown>;
  let store = host[REGISTRY_KEY] as Registry | undefined;
  if (store === undefined) {
    store = new Map<string, unknown>();
    host[REGISTRY_KEY] = store;
  }
  return store;
}

/**
 * The process-wide instance under `key`, created on first use.
 *
 * `key` is a plain string rather than the factory's identity on purpose: two
 * module instances hold two different `create` functions, and keying on those
 * would hand each of them its own instance — precisely the bug.
 */
export function processGlobal<T>(key: string, create: () => T): T {
  const store = registry();
  if (!store.has(key)) {
    store.set(key, create());
  }
  return store.get(key) as T;
}

/**
 * Drops the instance under `key`, so the next `processGlobal` call builds a
 * fresh one. For the `__reset…ForTests` helpers only — nothing in the running
 * application may discard a runner mid-run.
 */
export function resetProcessGlobal(key: string): void {
  registry().delete(key);
}

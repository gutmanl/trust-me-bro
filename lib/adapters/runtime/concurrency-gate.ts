import { loadAdapterConfig } from "../../identity";
import type { ConcurrencyGate } from "../core/contracts";

/**
 * Counting semaphore over promises: at most `capacity` tasks run at once,
 * waiters resume in FIFO order, and a slot is freed on both resolution and
 * rejection. Mirrors the module-state style of the register's in-process
 * lock tail — no external dependency.
 */
export function createConcurrencyGate(capacity: number): ConcurrencyGate {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < capacity) {
        active += 1;
        resolve();
        return;
      }
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });

  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

let globalGate: ConcurrencyGate | undefined;

/**
 * The global CLI gate of the epic: one gate across all projects and jobs in
 * this process, sized once from the adapter config — parallel verification
 * runs cannot multiply concurrent child processes beyond the configured cap
 * (protecting the user's subscription quota).
 */
export function getGlobalConcurrencyGate(): ConcurrencyGate {
  globalGate ??= createConcurrencyGate(loadAdapterConfig().maxConcurrency);
  return globalGate;
}

export function __resetGlobalConcurrencyGateForTests(): void {
  globalGate = undefined;
}

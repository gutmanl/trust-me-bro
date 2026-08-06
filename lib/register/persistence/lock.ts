import path from "node:path";

import lockfile from "proper-lockfile";

/**
 * Serializes all mutations of one project directory.
 *
 * Two tiers: an in-process promise chain per directory makes same-process
 * transactions (parallel route handlers, the job runner) wait cheaply, and
 * proper-lockfile — mkdir-based and therefore atomic on NTFS as on POSIX —
 * remains the correctness backstop across processes (web app vs. a
 * concurrently running CLI, stale locks of crashed processes).
 */
const inProcessTail = new Map<string, Promise<unknown>>();

async function withFileLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(projectDir, {
    lockfilePath: path.join(projectDir, "claims.json.lock"),
    realpath: false,
    retries: { retries: 30, minTimeout: 20, maxTimeout: 200 },
    stale: 30_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function withProjectLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(projectDir);
  const tail = inProcessTail.get(key) ?? Promise.resolve();
  const run = tail
    // A failed predecessor must not poison the queue for followers.
    .catch(() => undefined)
    .then(() => withFileLock(key, fn));
  inProcessTail.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

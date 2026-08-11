/**
 * Races a promise against a wall-clock deadline. On timeout the returned
 * promise rejects with `onTimeout()`; the timer is always cleared (so it
 * cannot keep the process alive) and unref'd (so a still-pending `work` never
 * holds the event loop open on the timer's account).
 *
 * `work` itself keeps running after a timeout — JavaScript cannot cancel a
 * promise — but its result is ignored. Shared by the three unbounded awaits
 * that could each, unguarded, hang a run forever: the job runner's per-item
 * cap, the SSRF DNS lookup, and PDF text extraction.
 */
export function raceTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

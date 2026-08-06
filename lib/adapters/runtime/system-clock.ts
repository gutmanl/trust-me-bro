import type { Clock } from "../core/contracts";

/** Real time source; ISO-8601 UTC, matching the register's IsoDateTime. */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

import type { Judgment } from "../../register";
import type { AdapterError } from "../core/errors";
import type { JobIO, JobKind } from "../core/jobs";

/**
 * What the orchestrator resolves per job kind: attribution outputs are
 * stamped with backend/model/at into a register-ready Judgment; the other
 * kinds pass through the backend's validated output unchanged.
 */
export type StampedOutput<K extends JobKind> = K extends "attribution"
  ? Judgment
  : JobIO[K]["output"];

/**
 * Terminal outcome of one orchestrated job run (TMB-19): `ok` merges,
 * `paused` surfaces a resumable rate-limit stop (never an escalation), and
 * `exhausted` is the caller's signal to escalate the affected claim to
 * adjudication via the ratified existence_checked → pending_adjudication edge —
 * never to drop it silently.
 */
export type RunOutcome<K extends JobKind> =
  | {
      readonly status: "ok";
      readonly output: StampedOutput<K>;
      readonly model: string;
      readonly attempts: number;
    }
  | {
      readonly status: "paused";
      readonly reason: string;
      readonly retryAfterMs?: number;
      readonly attempts: number;
    }
  | {
      readonly status: "exhausted";
      readonly attempts: number;
      readonly lastError: AdapterError;
    };

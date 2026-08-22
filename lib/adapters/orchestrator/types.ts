import type { AdapterError } from "../core/errors";
import type { JobIO, JobKind } from "../core/jobs";
import type { AttributionOutput } from "../schema/attribution";

/**
 * What the orchestrator resolves per job kind: an attribution output is
 * stamped with backend/model/at, the other kinds pass the backend's validated
 * output through unchanged.
 *
 * The orchestrator stamps PROVENANCE and stops there. Turning a stamped
 * attribution output into the register's judgment shape — which since the
 * two-layer contract means JOINING three prose fields into the one persisted
 * string — is the PIPELINE's job, at `verification/stage2`. That split is
 * what keeps the adapter layer free of any opinion about how a reasoning is
 * assembled for storage.
 *
 * Because `AttributionOutput` is itself an alternation while two prompt
 * vintages are live, the intersection distributes over both arms — which is
 * exactly what lets the pipeline's join accept either.
 */
export type StampedOutput<K extends JobKind> = K extends "attribution"
  ? AttributionOutput & {
      readonly backend: string;
      readonly model: string;
      readonly at: string;
    }
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

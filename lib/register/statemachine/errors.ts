import type { ClaimStatus } from "../schema/enums";

/** The requested (from, to, actor-kind) edge does not exist in the table. */
export class InvalidTransitionError extends Error {
  constructor(
    claimId: string,
    from: ClaimStatus | null,
    to: ClaimStatus,
    detail?: string,
  ) {
    super(
      `invalid transition ${from ?? "<creation>"} → ${to} for claim ${claimId}${
        detail ? ` (${detail})` : ""
      }`,
    );
    this.name = "InvalidTransitionError";
  }
}

/** The edge exists but its gate condition is not met by the claim state. */
export class GateRejectedError extends Error {
  constructor(
    claimId: string,
    from: ClaimStatus | null,
    to: ClaimStatus,
    reason: string,
  ) {
    super(
      `gate rejected ${from ?? "<creation>"} → ${to} for claim ${claimId}: ${reason}`,
    );
    this.name = "GateRejectedError";
  }
}

/** A human adjudication edge was taken without (or with an ill-formed)
 * decision object. */
export class DecisionRequiredError extends Error {
  constructor(claimId: string, to: ClaimStatus, detail: string) {
    super(
      `transition to ${to} for claim ${claimId} requires a decision: ${detail}`,
    );
    this.name = "DecisionRequiredError";
  }
}

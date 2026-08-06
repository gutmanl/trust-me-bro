import type { ZodError } from "zod";

import type { ChainVerificationError } from "../chain/verify";

/** The project's claims.json is missing, unparseable or schema-invalid. */
export class CorruptRegisterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CorruptRegisterError";
  }
}

/** A mutation produced a register that violates the field schema; nothing
 * was written. */
export class RegisterValidationError extends Error {
  constructor(readonly zodError: ZodError) {
    super(
      `mutation result violates the field schema: ${zodError.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "RegisterValidationError";
  }
}

/** A mutation produced a register whose data is referentially inconsistent
 * (duplicate ids, dangling source references); nothing was written. */
export class RegisterIntegrityError extends Error {
  constructor(readonly problems: string[]) {
    super(`mutation result is inconsistent: ${problems.join("; ")}`);
    this.name = "RegisterIntegrityError";
  }
}

/** A mutation produced a register whose hash chain does not verify; nothing
 * was written. */
export class ChainIntegrityError extends Error {
  constructor(readonly errors: ChainVerificationError[]) {
    super(`mutation result breaks the hash chain: ${JSON.stringify(errors)}`);
    this.name = "ChainIntegrityError";
  }
}

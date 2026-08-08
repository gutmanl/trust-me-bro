/**
 * Error taxonomy of the identity module (TMB-47), mirroring the per-layer
 * error files of lib/pipeline and lib/adapters.
 */

/**
 * Neither the environment nor the stored configuration file supplies an
 * actor kuerzel. The web layer gates on this state (proxy.ts redirects to
 * /setup); reaching this error from domain code means the gate was bypassed.
 */
export class IdentityNotConfiguredError extends Error {
  constructor() {
    super(
      "TrustMeBro is not configured: no actor kuerzel found — " +
        "complete the first-run setup (/setup) or set TMB_ACTOR_KUERZEL.",
    );
    this.name = "IdentityNotConfiguredError";
  }
}

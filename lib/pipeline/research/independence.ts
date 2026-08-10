import type { ClaimsRegister } from "../../register";
import { knownModelFamilyOf } from "../projects";
import { researchBackendOf } from "./provenance";

/**
 * Whether briefing and verification come from the same model family.
 *
 * The decision recorded on TMB-55 is to allow this rather than block it: a
 * hard rule would exclude exactly the user the feature exists for, someone
 * with a single CLI. It is an admissible mode of operation, not a
 * misconfiguration — but it is not independent either, so it is made
 * visible instead of silently permitted.
 *
 * The comparison MUST run over the model family, not the backend id:
 * `claude` and `anthropic-api` are different ids of the same family
 * `anthropic`, and an id comparison would miss precisely that case.
 *
 * Computed here, in the pipeline, because the family lookup lives here and
 * `lib/register/projection/**` may not import it — that would invert the
 * layering (lib/register depends only on lib/identity). The projection
 * receives the finished flag as an optional parameter instead.
 */
export interface BriefingIndependence {
  /** The briefing was produced by this application, not imported. */
  selfResearched: boolean;
  /** Research backend and primary verification backend share a family. */
  sharedModelFamily: boolean;
  /** The research backend's id, when self-researched. */
  researchBackend?: string;
  /** The shared family name, when there is one. */
  modelFamily?: string;
}

export function getBriefingIndependence(
  register: ClaimsRegister,
): BriefingIndependence {
  const researchBackend = researchBackendOf(
    register.project.briefing_import?.tool,
  );
  if (researchBackend === undefined) {
    // Imported from elsewhere: the application does not know what
    // researched it and must not pretend otherwise.
    return { selfResearched: false, sharedModelFamily: false };
  }
  // Both ids come out of the project file, so neither is known to be a
  // backend this installation supports — a bundle can name one it does not.
  const researchFamily = knownModelFamilyOf(researchBackend);
  const primaryFamily = knownModelFamilyOf(
    register.config.backends.primary.cli,
  );
  const shared =
    researchFamily !== undefined && researchFamily === primaryFamily;
  return {
    selfResearched: true,
    sharedModelFamily: shared,
    researchBackend,
    ...(shared ? { modelFamily: researchFamily } : {}),
  };
}

/**
 * The render context for a project's briefing.md. Every pipeline call site
 * that regenerates the projection goes through this, so the notice cannot
 * appear in one artifact and be missing from another.
 */
export function briefingRenderContext(register: ClaimsRegister): {
  sharedModelFamily?: boolean;
} {
  const independence = getBriefingIndependence(register);
  return independence.sharedModelFamily ? { sharedModelFamily: true } : {};
}

import { toPlainCsl } from "../../register";
import type { ClaimsRegister } from "../../register";
import { requireProjectStore } from "../projects";

/**
 * derived/references.csl.json (TMB-41, F4): the source register as plain
 * CSL-JSON — a filter operation, not a translation. Stripping the `custom`
 * object is the single documented mapping; everything else passes through
 * verbatim, so the output validates against the CSL-JSON data schema and
 * imports into Zotero/citeproc directly.
 */
export function buildReferencesCsl(
  register: ClaimsRegister,
): Record<string, unknown>[] {
  return register.sources.map(toPlainCsl);
}

/** Standalone download of the CSL projection (also part of the bundle). */
export async function getReferencesCsl(
  projectId: string,
): Promise<Record<string, unknown>[]> {
  return buildReferencesCsl(await requireProjectStore(projectId).read());
}

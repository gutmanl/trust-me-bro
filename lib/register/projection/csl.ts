import type { Source } from "../schema/source";

/**
 * F4: a source without the workshop's `custom` extension is a plain CSL-JSON
 * item. The export to reference managers (Zotero, citeproc) is exactly this
 * filter operation, not a translation — which is why it lives in the register
 * core next to the other pure projections (moved here from the pipeline layer
 * with the export epic TMB-6, whose references.csl.json derivation is its
 * second consumer).
 */
export function toPlainCsl(source: Source): Record<string, unknown> {
  const plain: Record<string, unknown> = { ...source };
  delete plain.custom;
  return plain;
}

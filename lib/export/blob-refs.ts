import type { ClaimsRegister } from "../register";

/**
 * Every blob path a register references: the frozen briefing original plus
 * each source snapshot and its optional extracted full text. Register-driven
 * by design (no directory walk): a blob the register does not reference is
 * not part of the project's evidentiary record, and a referenced-but-missing
 * blob must surface as an integrity finding, not be silently skipped.
 */
export function collectBlobPaths(register: ClaimsRegister): string[] {
  const paths: string[] = [];
  if (register.project.briefing_import) {
    paths.push(register.project.briefing_import.blob_path);
  }
  for (const source of register.sources) {
    const snapshot = source.custom.snapshot;
    if (snapshot) {
      paths.push(snapshot.blob_path);
      if (snapshot.text_blob_path) {
        paths.push(snapshot.text_blob_path);
      }
    }
  }
  return paths;
}

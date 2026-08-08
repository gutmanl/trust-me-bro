import type { ClaimsRegister } from "../register";

/**
 * Every blob path a register references: the frozen briefing original plus
 * each source snapshot — current AND superseded revisions (TMB-44: a
 * revision makes old blobs historical, never unreachable, so export and
 * verification must carry them) — and their optional extracted full texts.
 * Register-driven by design (no directory walk): a blob the register does
 * not reference is not part of the project's evidentiary record, and a
 * referenced-but-missing blob must surface as an integrity finding, not be
 * silently skipped.
 */
export function collectBlobPaths(register: ClaimsRegister): string[] {
  const paths: string[] = [];
  if (register.project.briefing_import) {
    paths.push(register.project.briefing_import.blob_path);
  }
  for (const source of register.sources) {
    for (const snapshot of [
      source.custom.snapshot,
      ...(source.custom.previous_snapshots ?? []),
    ]) {
      if (snapshot) {
        paths.push(snapshot.blob_path);
        if (snapshot.text_blob_path) {
          paths.push(snapshot.text_blob_path);
        }
      }
    }
  }
  return paths;
}

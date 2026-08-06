import path from "node:path";

import { writeFileAtomic } from "../../register/persistence/atomic-write";
import type { TraceSink } from "../core/contracts";
import { TraceEnvelope } from "../trace/envelope";

/**
 * Persists trace envelopes as ONE IMMUTABLE JSON FILE PER ADAPTER CALL under
 * `<projectDir>/traces/` (ratified TMB-20 decision): each file is written
 * exactly once via the register's atomic-write helper — the deliberate,
 * documented exception to "raw fs writes only in atomic-write.ts", enforced
 * as such by the architecture guards. No append, no update path: the log is
 * append-only by construction, and the traces/ directory travels with the
 * project into the export bundle.
 *
 * File names sort chronologically and avoid NTFS-hostile characters
 * (ISO colons/dots are stripped): `<compact started_at>--<trace_id>.json`.
 */
export const fileTraceSink: TraceSink = {
  async write(projectDir, envelope) {
    const validated = TraceEnvelope.parse(envelope);
    const compactStart = validated.started_at.replace(/[-:.]/g, "");
    writeFileAtomic(
      path.join(
        projectDir,
        "traces",
        `${compactStart}--${validated.trace_id}.json`,
      ),
      `${JSON.stringify(validated, null, 2)}\n`,
    );
  },
};

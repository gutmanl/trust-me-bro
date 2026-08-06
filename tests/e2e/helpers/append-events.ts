/**
 * E2E helper: appends N project events to an existing project as a separate
 * OS process. Used by multiprocess.e2e.test.ts to prove that the file lock
 * serializes writers ACROSS processes, not just within one.
 * Usage: tsx append-events.ts <projectDir> <count> <label>
 */
import { RegisterStore } from "../../../lib/register";

const [projectDir, countArg, label] = process.argv.slice(2);
const count = Number(countArg);
if (!projectDir || !Number.isInteger(count) || count < 1 || !label) {
  console.error("usage: append-events.ts <projectDir> <count> <label>");
  process.exit(2);
}

async function main(): Promise<void> {
  const store = RegisterStore.atDirectory(projectDir);
  let appended = 0;
  for (let index = 0; index < count; index += 1) {
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "batch_run_started",
        reason: `Prozess ${label}, Lauf ${index}.`,
        actor: "system:extraction",
      });
    });
    appended += 1;
  }
  console.log(`${label}: appended ${appended}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

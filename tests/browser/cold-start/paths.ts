/**
 * Locations the cold-start suite owns.
 *
 * The suite deliberately sets NEITHER `TMB_WORKSPACE` nor `TMB_CONFIG_PATH`,
 * and redirects `HOME` instead. That is the configuration a real first start
 * has: the README documents the defaults (`~/.trustmebro/config.json`, the
 * workspace under `~/.trustmebro/workspace`), and setting the variables would
 * have flipped the wizard into its read-only "provided by the environment"
 * branch — testing the one path an evaluator never takes, and skipping the
 * default-path resolution entirely.
 *
 * Separate from the seeded browser suite's workspace: that one is populated
 * before the first navigation, and this suite's whole subject is what the
 * application does when nothing exists yet.
 */
import os from "node:os";
import path from "node:path";

/** Stands in for the evaluator's home directory. */
export const COLD_HOME = path.join(os.tmpdir(), "tmb-cold-home");

/** Where the application puts things when nothing points it elsewhere. */
export const COLD_CONFIG = path.join(COLD_HOME, ".trustmebro", "config.json");
export const COLD_WORKSPACE = path.join(COLD_HOME, ".trustmebro", "workspace");

/**
 * An empty directory used as the server's entire `PATH`.
 *
 * Without it this suite asserts something different depending on who runs
 * it: a developer working on this repository through Claude Code has the
 * `claude` CLI installed, CI has neither CLI, and the backend diagnosis —
 * along with the project form's default backend, which is derived from it —
 * therefore differs between the two. "No agent CLI installed" is the
 * premise of the whole suite, so it has to be arranged rather than assumed.
 *
 * Deliberately OUTSIDE the stand-in home: global setup wipes that directory,
 * and Playwright starts the web server BEFORE global setup runs, so a PATH
 * living inside it would be deleted out from under the running server.
 */
export const COLD_PATH_DIR = path.join(os.tmpdir(), "tmb-cold-path");

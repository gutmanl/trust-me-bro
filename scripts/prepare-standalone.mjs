import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Stages the standalone build for packaging (TMB-48). Next's standalone
 * output deliberately omits .next/static (documented manual copy step), and
 * the runtime data files (prompt templates, rubric rules) are resolved from
 * the working directory at runtime — both are copied into the standalone
 * directory here so the tarball is fully self-contained.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const standaloneDir = path.join(repoRoot, ".next", "standalone");

if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
  console.error(
    "No standalone server found. Run the build via `npm run package:build` " +
      "(next build with TMB_BUILD_TARGET=package).",
  );
  process.exit(1);
}

const copies = [
  // Static assets: standalone never copies these itself.
  [
    path.join(repoRoot, ".next", "static"),
    path.join(standaloneDir, ".next", "static"),
  ],
  // Runtime data files, resolved from cwd by load.ts / rubric-rules.ts.
  [
    path.join(repoRoot, "lib", "adapters", "prompts"),
    path.join(standaloneDir, "lib", "adapters", "prompts"),
  ],
  [
    path.join(repoRoot, "lib", "pipeline", "verification", "rules"),
    path.join(standaloneDir, "lib", "pipeline", "verification", "rules"),
  ],
];
// public/ does not exist today; copy defensively if it appears.
const publicDir = path.join(repoRoot, "public");
if (fs.existsSync(publicDir)) {
  copies.push([publicDir, path.join(standaloneDir, "public")]);
}

for (const [from, to] of copies) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(
    `staged ${path.relative(repoRoot, from)} -> ${path.relative(repoRoot, to)}`,
  );
}

/**
 * S-05, second guard: Next's tracing is a heuristic, so the staged tree is
 * pruned again by an explicit rule. `next.config.ts` excludes the same set
 * from the trace; this step is what makes the guarantee testable, and it is
 * the only place that can refuse to build outright.
 *
 * Two kinds of finding are treated differently. Build leftovers are pruned
 * quietly — they are only bloat. Anything that carries PROJECT DATA fails
 * the build instead: publishing a user's briefings, frozen source documents
 * or audit trail is not recoverable after the fact, so it must not be
 * possible to do it by accident.
 */
const PRUNED_DIRS = new Set(["coverage", "tests", "__fixtures__", ".git"]);
// TypeScript sources (including .d.ts) never run: the standalone server is
// the compiled output under .next/. Shipping them only inflated the tarball.
//
// Archives are the case that actually bit: `npm pack` leaves its tarball in
// the repository root, Next's tracing copies it into the staged tree, and
// the NEXT pack then embeds the previous one — measured at +24 MB, doubling
// with every round. Nothing in an archive is needed at runtime.
const PRUNED_FILE = /\.tsx?$|\.tsbuildinfo$|\.(tgz|tar|tar\.gz|zip)$/;
// A .tmb bundle is an exported project: same data as a workspace directory,
// same refusal.
const PROJECT_DATA_FILE = /\.tmb$/;
const PROJECT_DATA_DIRS = new Set(["workspace"]);

function refuse(full, what) {
  console.error(
    `Refusing to package: ${what} found at ${path.relative(repoRoot, full)}. ` +
      "Move it outside the repository before packing — project data must " +
      "never be published inside the tarball.",
  );
  process.exit(1);
}

let prunedCount = 0;

function prune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PROJECT_DATA_DIRS.has(entry.name)) {
        refuse(full, "a workspace directory");
      }
      if (PRUNED_DIRS.has(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
        prunedCount += 1;
        continue;
      }
      prune(full);
    } else if (PROJECT_DATA_FILE.test(entry.name)) {
      refuse(full, "an exported project bundle");
    } else if (PRUNED_FILE.test(entry.name)) {
      fs.rmSync(full, { force: true });
      prunedCount += 1;
    }
  }
}

prune(standaloneDir);
console.log(`pruned ${prunedCount} non-shipping entries from .next/standalone`);

console.log("Standalone package staged. Create the tarball with `npm pack`.");

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
 * A `workspace/` directory here means real project data — briefings, frozen
 * source documents, the audit trail — was about to be published inside the
 * tarball. That is never recoverable after the fact, so it fails the build
 * rather than being pruned quietly.
 */
const PRUNED_DIRS = new Set(["coverage", "tests", "__fixtures__", ".git"]);
// TypeScript sources (including .d.ts) never run: the standalone server is
// the compiled output under .next/. Shipping them only inflated the tarball.
const PRUNED_FILE = /\.tsx?$|\.tsbuildinfo$/;

let prunedCount = 0;

function prune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "workspace") {
        console.error(
          `Refusing to package: project data found at ${path.relative(repoRoot, full)}. ` +
            "Move the workspace directory outside the repository before packing.",
        );
        process.exit(1);
      }
      if (PRUNED_DIRS.has(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
        prunedCount += 1;
        continue;
      }
      prune(full);
    } else if (PRUNED_FILE.test(entry.name)) {
      fs.rmSync(full, { force: true });
      prunedCount += 1;
    }
  }
}

prune(standaloneDir);
console.log(`pruned ${prunedCount} non-shipping entries from .next/standalone`);

console.log("Standalone package staged. Create the tarball with `npm pack`.");

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

console.log("Standalone package staged. Create the tarball with `npm pack`.");

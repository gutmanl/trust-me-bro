/**
 * Architecture guard tests. These deliberately duplicate rules that ESLint
 * and code review also enforce: they fail loudly when a future change —
 * human or LLM-generated — erodes a structural invariant, even if lint
 * config or barrel files are edited along the way. Do not weaken them to
 * make a change pass; change the design consciously instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as adaptersPublic from "../lib/adapters";
import * as pipelinePublic from "../lib/pipeline";
import * as registerPublic from "../lib/register";
import { TRANSITIONS } from "../lib/register/statemachine/transitions";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sourceFiles(dir: string): string[] {
  const absolute = path.join(repoRoot, dir);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  return fs
    .readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(dir, name));
}

function read(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

describe("public surface of lib/register", () => {
  it("exposes the store but never the chain minter or the raw engine", () => {
    const surface = registerPublic as Record<string, unknown>;
    expect(surface.RegisterStore).toBeDefined();
    expect(surface.verifyChain).toBeDefined();
    expect(surface.renderBriefing).toBeDefined();
    expect(surface.createBlobStore).toBeDefined();
    expect(surface.countClaimsByStatus).toBeDefined();
    expect(surface.lastActivityAt).toBeDefined();
    // Chain links and status changes must only be producible inside a
    // RegisterStore transaction (single-writer invariant).
    expect(surface.ChainAppender).toBeUndefined();
    expect(surface.applyTransition).toBeUndefined();
    expect(surface.createClaim).toBeUndefined();
    expect(surface.withProjectLock).toBeUndefined();
    expect(surface.writeFileAtomic).toBeUndefined();
  });
});

describe("public surface of lib/adapters", () => {
  it("exposes the orchestrator, backends and errors but never the internals", () => {
    const surface = adaptersPublic as Record<string, unknown>;
    expect(surface.Orchestrator).toBeDefined();
    expect(surface.createProjectOrchestrator).toBeDefined();
    expect(surface.resolveConfiguredBackends).toBeDefined();
    expect(surface.createClaudeBackend).toBeDefined();
    expect(surface.createCodexBackend).toBeDefined();
    expect(surface.createMockBackend).toBeDefined();
    expect(surface.renderPromptForJob).toBeDefined();
    expect(surface.AdapterRateLimitError).toBeDefined();
    // Internals stay internal: prompt loading/interpolation, the raw spawn
    // site, the output validator and the trace writer are reachable only
    // through the orchestrator/backend path.
    expect(surface.substitute).toBeUndefined();
    expect(surface.loadPromptTemplate).toBeUndefined();
    expect(surface.nodeProcessRunner).toBeUndefined();
    expect(surface.validateJobOutput).toBeUndefined();
  });
});

describe("public surface of lib/pipeline", () => {
  it("exposes the use-cases the web layer calls", () => {
    const surface = pipelinePublic as Record<string, unknown>;
    expect(surface.createProject).toBeDefined();
    expect(surface.listProjects).toBeDefined();
    expect(surface.getProjectSummary).toBeDefined();
    expect(surface.readProject).toBeDefined();
    expect(surface.slugify).toBeDefined();
    expect(surface.mintProjectId).toBeDefined();
  });
});

describe("module boundaries", () => {
  const domainFiles = [...sourceFiles("lib"), ...sourceFiles("cli")];

  it("finds domain sources to scan (guard against silent renames)", () => {
    expect(domainFiles.length).toBeGreaterThan(20);
  });

  it("keeps the domain core free of app/ imports", () => {
    for (const file of domainFiles) {
      expect(read(file), file).not.toMatch(/from\s+["'][^"']*\bapp\//);
    }
  });

  it("confines process.env access to lib/identity", () => {
    for (const file of domainFiles) {
      if (file.startsWith(path.join("lib", "identity"))) {
        continue;
      }
      expect(read(file), file).not.toContain("process.env");
    }
  });

  it("keeps chain and projection modules free of filesystem access (pure)", () => {
    const pureDirs = [
      path.join("lib", "register", "chain"),
      path.join("lib", "register", "projection"),
    ];
    for (const file of domainFiles) {
      if (pureDirs.some((dir) => file.startsWith(dir))) {
        expect(read(file), file).not.toMatch(/["']node:fs["']/);
      }
    }
  });

  it("allows raw file writes only inside the atomic-write helper", () => {
    const allowed = path.join(
      "lib",
      "register",
      "persistence",
      "atomic-write.ts",
    );
    for (const file of domainFiles) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /fs\.(writeFileSync|appendFileSync|createWriteStream)\(/,
      );
    }
  });

  it("confines child-process spawning to the adapter process runner", () => {
    const allowed = path.join(
      "lib",
      "adapters",
      "runtime",
      "node-process-runner.ts",
    );
    for (const file of domainFiles) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(/["']node:child_process["']/);
    }
  });

  it("keeps the adapter layer off the register's write internals", () => {
    // The trace sink's atomic-write deep import is the single ratified
    // exception (TMB-20): reusing the one sanctioned raw-write site instead
    // of duplicating it. Everything else in lib/adapters may only use the
    // register's public schema surface.
    const allowed = path.join("lib", "adapters", "runtime", "trace-sink.ts");
    for (const file of sourceFiles(path.join("lib", "adapters"))) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /register\/(persistence|statemachine|chain)\//,
      );
    }
  });
});

describe("status model transition table", () => {
  it("matches the ratified edge set exactly (change requires touching both places)", () => {
    const edges = TRANSITIONS.map((def) => ({
      from: def.from,
      to: def.to,
      actorKind: def.actorKind,
      decision: def.decision ?? null,
    }));
    expect(edges).toEqual([
      { from: null, to: "erfasst", actorKind: "system", decision: null },
      {
        from: null,
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
      {
        from: "erfasst",
        to: "existenzgeprueft",
        actorKind: "system",
        decision: null,
      },
      {
        from: "erfasst",
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
      {
        from: "existenzgeprueft",
        to: "vorgeprueft",
        actorKind: "system",
        decision: null,
      },
      // Ratified with TMB-19: adapter-failure escalation instead of a claim
      // stuck in existenzgeprueft (see transitions.ts for the rationale).
      {
        from: "existenzgeprueft",
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
      {
        from: "vorgeprueft",
        to: "automatisch_bestaetigt",
        actorKind: "system",
        decision: null,
      },
      {
        from: "vorgeprueft",
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
      {
        from: "automatisch_bestaetigt",
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
      {
        from: "zur_adjudikation",
        to: "bestaetigt",
        actorKind: "human",
        decision: "category_null",
      },
      {
        from: "zur_adjudikation",
        to: "beanstandet",
        actorKind: "human",
        decision: "category_required",
      },
      {
        from: "beanstandet",
        to: "ueberarbeitet",
        actorKind: "system",
        decision: null,
      },
      {
        from: "beanstandet",
        to: "ueberarbeitet",
        actorKind: "human",
        decision: null,
      },
      {
        from: "beanstandet",
        to: "verworfen",
        actorKind: "human",
        decision: "optional",
      },
      {
        from: "ueberarbeitet",
        to: "erfasst",
        actorKind: "system",
        decision: null,
      },
      {
        from: "ueberarbeitet",
        to: "existenzgeprueft",
        actorKind: "system",
        decision: null,
      },
      {
        from: "ueberarbeitet",
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
    ]);
  });

  it("keeps bestaetigt and verworfen terminal and verworfen unreachable from adjudication", () => {
    expect(TRANSITIONS.filter((def) => def.from === "bestaetigt")).toHaveLength(
      0,
    );
    expect(TRANSITIONS.filter((def) => def.from === "verworfen")).toHaveLength(
      0,
    );
    expect(
      TRANSITIONS.filter(
        (def) => def.from === "zur_adjudikation" && def.to === "verworfen",
      ),
    ).toHaveLength(0);
  });
});

describe("committed artifacts", () => {
  it("keeps the generated JSON Schema at the repo root", () => {
    expect(
      fs.existsSync(path.join(repoRoot, "schema", "claims.schema.json")),
    ).toBe(true);
  });
});

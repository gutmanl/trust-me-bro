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
import * as exportPublic from "../lib/export";
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
    // Exposed so the pipeline can CLASSIFY why a claim was routed to
    // adjudication without re-implementing the heuristic; admission itself
    // still happens only inside the creation gate.
    expect(surface.isAtomicClaimText).toBeDefined();
    // Same escape-hatch pattern for TMB-4: the verification pipeline decides
    // WHICH edge to take / WHICH relation to persist via these predicates;
    // the transition gates remain the authority at commit time.
    expect(surface.evaluateAutoConfirmation).toBeDefined();
    expect(surface.resolveEvidenceRelation).toBeDefined();
    expect(surface.latestJudgmentPerBackend).toBeDefined();
    // TMB-5: the repair pipeline decides the re-entry edge with the same
    // predicate the gate re-checks at commit time.
    expect(surface.allExistenceChecksPassed).toBeDefined();
    // TMB-5: anchor resolution/evidence numbering single-sourced for the
    // markdown projection AND the review UI.
    expect(surface.buildBriefingViewModel).toBeDefined();
    expect(surface.formatLocator).toBeDefined();
    // TMB-6: pure read-side helpers for the export bundle — the F4 filter
    // projection, content hashing and the chain tip for the manifest. The
    // ChainAppender itself stays internal (assertion below).
    expect(surface.toPlainCsl).toBeDefined();
    expect(surface.sha256Hex).toBeDefined();
    expect(surface.sha256FromBlobPath).toBeDefined();
    expect(surface.latestChainLink).toBeDefined();
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

describe("public surface of lib/export", () => {
  it("exposes the bundle core but never the fflate internals", () => {
    const surface = exportPublic as Record<string, unknown>;
    expect(surface.zipBundle).toBeDefined();
    expect(surface.unzipBundle).toBeDefined();
    expect(surface.buildManifest).toBeDefined();
    expect(surface.serializeManifest).toBeDefined();
    expect(surface.Manifest).toBeDefined();
    expect(surface.collectBlobPaths).toBeDefined();
    expect(surface.verifyBundleFiles).toBeDefined();
    expect(surface.describeBundleProblem).toBeDefined();
    expect(surface.BundleFormatError).toBeDefined();
    // The zip library never leaks past the confined wrapper.
    expect(surface.zipSync).toBeUndefined();
    expect(surface.unzipSync).toBeUndefined();
    expect(surface.strToU8).toBeUndefined();
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
    expect(surface.importBriefing).toBeDefined();
    expect(surface.getBriefing).toBeDefined();
    expect(surface.captureSource).toBeDefined();
    expect(surface.freezeSourceSet).toBeDefined();
    expect(surface.isSourceSetFrozen).toBeDefined();
    expect(surface.formatCitation).toBeDefined();
    expect(surface.toPlainCsl).toBeDefined();
    expect(surface.startExtraction).toBeDefined();
    expect(surface.getExtractionState).toBeDefined();
    expect(surface.getExtractionRun).toBeDefined();
    expect(surface.startVerification).toBeDefined();
    expect(surface.getVerificationState).toBeDefined();
    expect(surface.getVerificationRun).toBeDefined();
    // TMB-5: adjudication, repair, history and snapshot use-cases.
    expect(surface.getBriefingViewModel).toBeDefined();
    expect(surface.buildAdjudicationQueue).toBeDefined();
    expect(surface.buildEvidenceDisplayMap).toBeDefined();
    expect(surface.buildTimeline).toBeDefined();
    expect(surface.decideClaim).toBeDefined();
    expect(surface.proposeRepair).toBeDefined();
    expect(surface.applyRepair).toBeDefined();
    expect(surface.discardClaim).toBeDefined();
    expect(surface.getProjectBlob).toBeDefined();
    expect(surface.getChainVerification).toBeDefined();
    // TMB-41: derived export accessors; the pure builders stay internal.
    expect(surface.getReferencesCsl).toBeDefined();
    expect(surface.getProvDocument).toBeDefined();
    expect(surface.getTracesAggregate).toBeDefined();
    expect(surface.buildReferencesCsl).toBeUndefined();
    expect(surface.buildProvDocument).toBeUndefined();
    expect(surface.buildTracesAggregate).toBeUndefined();
    // TMB-39: the bundle download use-case; assembly stays internal.
    expect(surface.exportProjectBundle).toBeDefined();
    expect(surface.buildExportFilename).toBeUndefined();
    // TMB-40: bundle import (verify in memory, then materialize).
    expect(surface.importProjectBundle).toBeDefined();
    // Repair internals stay internal: the re-entry rule and cycle count are
    // reachable only through applyRepair.
    expect(surface.decideReEntry).toBeUndefined();
    expect(surface.countRepairCycles).toBeUndefined();
    // Verification internals stay internal: stage checkers, rubric rules,
    // aggregation and the sample draw are reachable only through the run.
    expect(surface.pickUnfinishedClaims).toBeUndefined();
    expect(surface.checkClaimExistence).toBeUndefined();
    expect(surface.runAttributionAndRubric).toBeUndefined();
    expect(surface.aggregateSupportDegree).toBeUndefined();
    expect(surface.loadRubricRuleSet).toBeUndefined();
    expect(surface.evaluateMechanicalRubric).toBeUndefined();
    expect(surface.drawSample).toBeUndefined();
    // Network access stays behind the fetcher port; the production fetcher
    // is wired internally, not part of the public surface.
    expect(surface.nodeHttpFetcher).toBeUndefined();
    // Runs start only through the use-cases, never by driving the runner
    // or the orchestrator wiring directly from the web layer.
    expect(surface.getGlobalJobRunner).toBeUndefined();
    expect(surface.createJobRunner).toBeUndefined();
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
      // Shared normal form of TMB-24's extraction and TMB-4's stage 1 —
      // trustworthy exactly because it stays pure.
      path.join("lib", "pipeline", "text"),
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

  it("confines network access to the pipeline's http fetcher", () => {
    const allowed = [
      // The one production implementation …
      path.join("lib", "pipeline", "sources", "node-http-fetcher.ts"),
      // … its port declaration (interface method named fetch) …
      path.join("lib", "pipeline", "sources", "fetch-port.ts"),
    ];
    for (const file of domainFiles) {
      // … and test doubles implementing the port.
      if (allowed.includes(file) || file.includes("__fixtures__")) {
        continue;
      }
      // Bare global fetch(...) only; calls through the HttpFetcher port
      // (fetcher.fetch(...)) are exactly the sanctioned indirection.
      expect(read(file), file).not.toMatch(/(?<![.\w])fetch\(/);
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

  it("confines the fflate dependency to the bundle core's zip wrapper", () => {
    // Same pattern as the network/child-process confinement: the ZIP format
    // has exactly one implementation site (TMB-6).
    const allowed = path.join("lib", "export", "zip.ts");
    for (const file of domainFiles) {
      if (file === allowed) {
        continue;
      }
      expect(read(file), file).not.toMatch(/["']fflate["']/);
    }
  });

  it("keeps the bundle core (lib/export) off the use-case and adapter layers", () => {
    // lib/export is domain core beside lib/register: usable by the CLI
    // without pulling in lib/pipeline (job runner, orchestrator, Next.js
    // concerns) or lib/adapters. It may only use the register's public
    // barrel — never its write internals, with ONE ratified exception
    // mirroring the trace sink (TMB-20): the bundle materializer reuses the
    // sanctioned atomic-write site instead of duplicating it (TMB-40).
    const allowedAtomicWrite = path.join("lib", "export", "write-bundle.ts");
    for (const file of sourceFiles(path.join("lib", "export"))) {
      const content = read(file);
      expect(content, file).not.toMatch(/from\s+["'][^"']*\bpipeline\//);
      expect(content, file).not.toMatch(/from\s+["'][^"']*\badapters\//);
      if (file === allowedAtomicWrite) {
        expect(content, file).not.toMatch(
          /from\s+["'][^"']*register\/(statemachine|chain)\//,
        );
        continue;
      }
      expect(content, file).not.toMatch(
        /from\s+["'][^"']*register\/(persistence|statemachine|chain)\//,
      );
    }
  });

  it("keeps the CLI on the domain core (register + bundle core only)", () => {
    // The standalone CLI works without the web application: lib/register
    // and lib/export are its whole world — never lib/pipeline (job runner,
    // orchestration, Next.js concerns), lib/adapters or app/. Ratified with
    // TMB-42, previously an undocumented convention.
    for (const file of sourceFiles("cli")) {
      const content = read(file);
      for (const match of content.matchAll(
        /from\s+["']\.\.\/lib\/([a-z-]+)/g,
      )) {
        expect(
          ["register", "export"].includes(match[1]),
          `${file} imports ../lib/${match[1]} — the CLI may only use lib/register and lib/export`,
        ).toBe(true);
      }
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

describe("web-layer boundary", () => {
  /** All app/ sources incl. .tsx (sourceFiles only collects .ts). */
  function appSourceFiles(): string[] {
    const absolute = path.join(repoRoot, "app");
    return fs
      .readdirSync(absolute, { recursive: true, encoding: "utf8" })
      .filter(
        (name) =>
          (name.endsWith(".ts") || name.endsWith(".tsx")) &&
          !name.endsWith(".test.ts"),
      )
      .map((name) => path.join("app", name));
  }

  it("keeps runtime imports on the pipeline barrel (pinned deep imports)", () => {
    // Pure, node:fs-free modules that CLIENT components must deep-import
    // because the barrel transitively pulls node:fs. Every other runtime
    // import from lib/ goes through @/lib/pipeline; type-only imports are
    // erased at build time and free (label maps import types from
    // @/lib/register).
    const allowedRuntime = new Set([
      "@/lib/pipeline",
      "@/lib/pipeline/adjudication/effort-timer",
      "@/lib/pipeline/adjudication/queue",
      "@/lib/pipeline/ids",
    ]);
    const files = appSourceFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = read(file);
      for (const match of content.matchAll(
        /import\s+(type\s+)?[^;]*?from\s+["'](@\/lib\/[^"']+)["']/g,
      )) {
        if (match[1] !== undefined) {
          continue; // type-only import
        }
        expect(
          allowedRuntime.has(match[2]),
          `${file} imports ${match[2]} at runtime — use the @/lib/pipeline barrel or pin a new pure deep import here`,
        ).toBe(true);
      }
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

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
    // TMB-45: metrics as a pure register projection; countRepairCycles
    // relocated here from the repair pipeline (shared by re-entry and
    // metrics, pure history derivation).
    expect(surface.computeProjectMetrics).toBeDefined();
    expect(surface.countRepairCycles).toBeDefined();
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
    // TMB-49: the preflight facade; probe mechanics and the login-probe
    // cache stay internal.
    expect(surface.checkCliHealth).toBeDefined();
    expect(surface.runCliLoginProbe).toBeDefined();
    expect(surface.probeLogin).toBeUndefined();
    expect(surface.probePresenceAndVersion).toBeUndefined();
    expect(surface.setCachedLoginProbe).toBeUndefined();
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
    expect(surface.bundleText).toBeDefined();
    expect(surface.buildManifest).toBeDefined();
    expect(surface.serializeManifest).toBeDefined();
    expect(surface.Manifest).toBeDefined();
    expect(surface.MANIFEST_PATH).toBeDefined();
    expect(surface.MANIFEST_VERSION).toBeDefined();
    expect(surface.collectBlobPaths).toBeDefined();
    expect(surface.verifyBundleFiles).toBeDefined();
    expect(surface.describeBundleProblem).toBeDefined();
    expect(surface.BundleFormatError).toBeDefined();
    expect(surface.assertSafeRelativePath).toBeDefined();
    expect(surface.writeBundleToDirectory).toBeDefined();
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
    // TMB-44: source revision on a frozen set; the shared document
    // acquisition helper stays internal.
    expect(surface.reviseSource).toBeDefined();
    expect(surface.acquireDocument).toBeUndefined();
    // TMB-43: warm runs — creation and relevance check; the population
    // selection and state derivation stay internal.
    expect(surface.createWarmRunProject).toBeDefined();
    expect(surface.startRelevanceCheck).toBeDefined();
    expect(surface.getRelevanceState).toBeDefined();
    expect(surface.getRelevanceRun).toBeDefined();
    expect(surface.pendingRelevancePopulation).toBeUndefined();
    expect(surface.deriveRelevanceState).toBeUndefined();
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
    // TMB-45: metrics accessor and CSV serialization.
    expect(surface.getProjectMetrics).toBeDefined();
    expect(surface.metricsToCsv).toBeDefined();
    // TMB-47: first-run setup use-cases; identity internals stay behind
    // lib/identity (the pipeline barrel never re-exports them).
    expect(surface.isSetupComplete).toBeDefined();
    expect(surface.completeFirstRunSetup).toBeDefined();
    expect(surface.writeIdentityConfig).toBeUndefined();
    expect(surface.isIdentityConfigured).toBeUndefined();
    // TMB-49: backend preflight accessors; probe mechanics and the run
    // precondition seam stay internal.
    expect(surface.getBackendsHealth).toBeDefined();
    expect(surface.runLoginProbe).toBeDefined();
    expect(surface.probeBackendUsable).toBeUndefined();
    expect(surface.withoutSecondaryBackend).toBeUndefined();
    // TMB-46: settings use-case; diff formatter and backends builder stay
    // internal.
    expect(surface.updateProjectConfig).toBeDefined();
    expect(surface.describeConfigChanges).toBeUndefined();
    expect(surface.buildBackendsConfig).toBeUndefined();
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
    // TMB-50: cooperative run control is a use-case, the runner stays
    // internal.
    expect(surface.pauseRun).toBeDefined();
    expect(surface.resumeRun).toBeDefined();
    expect(surface.cancelRun).toBeDefined();
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

  it("allows raw file writes only inside the sanctioned write sites", () => {
    const allowed = [
      path.join("lib", "register", "persistence", "atomic-write.ts"),
      // TMB-47: identity's config-file writer is the SECOND sanctioned
      // site. It cannot reuse the register's atomic-write helper because
      // lib/register depends on lib/identity — the import would invert the
      // layering, so the few lines are deliberately duplicated there.
      path.join("lib", "identity", "config-file.ts"),
    ];
    for (const file of domainFiles) {
      if (allowed.includes(file)) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /fs\.(writeFileSync|appendFileSync|createWriteStream)\(/,
      );
    }
  });

  it("confines workspace/project path resolution to its sanctioned callers", () => {
    // TMB-47 acceptance: outside lib/identity no module resolves the
    // workspace root or project paths on its own. The two read-side
    // authorities (store lookup, project listing) and the import target
    // resolution are the pinned exceptions; everything else receives
    // directories from them.
    const allowed = [
      path.join("lib", "register", "persistence", "store.ts"),
      path.join("lib", "pipeline", "projects.ts"),
      path.join("lib", "pipeline", "export", "import-bundle.ts"),
      path.join("lib", "pipeline", "setup.ts"),
    ];
    for (const file of domainFiles) {
      if (
        file.startsWith(path.join("lib", "identity")) ||
        allowed.includes(file)
      ) {
        continue;
      }
      expect(read(file), file).not.toMatch(
        /getWorkspaceRoot\(|resolveProjectDir\(/,
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
    // The standalone CLI works without the web application: the PUBLIC
    // barrels of lib/register and lib/export are its whole world — never
    // lib/pipeline (job runner, orchestration, Next.js concerns),
    // lib/adapters, app/, or register sub-barrels (lib/register/chain
    // exposes the ChainAppender the top-level barrel deliberately hides).
    // Ratified with TMB-42, previously an undocumented convention.
    for (const file of sourceFiles("cli")) {
      const content = read(file);
      for (const match of content.matchAll(
        /from\s+["'](\.\.\/lib\/[^"']+)["']/g,
      )) {
        expect(
          ["../lib/register", "../lib/export"].includes(match[1]),
          `${file} imports ${match[1]} — the CLI may only use the public barrels ../lib/register and ../lib/export`,
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
      // Ratified with TMB-7: warm-run adoption creates claims directly in
      // their settled origin status (gate: provenance.origin_project_id).
      { from: null, to: "bestaetigt", actorKind: "system", decision: null },
      {
        from: null,
        to: "automatisch_bestaetigt",
        actorKind: "system",
        decision: null,
      },
      { from: null, to: "verworfen", actorKind: "system", decision: null },
      // Ratified with TMB-43: negative relevance of an adopted claim.
      {
        from: "bestaetigt",
        to: "zur_adjudikation",
        actorKind: "system",
        decision: null,
      },
      // Ratified with TMB-44: source revision reopens settled claims.
      {
        from: "existenzgeprueft",
        to: "nachpruefung_erforderlich",
        actorKind: "system",
        decision: null,
      },
      {
        from: "vorgeprueft",
        to: "nachpruefung_erforderlich",
        actorKind: "system",
        decision: null,
      },
      {
        from: "automatisch_bestaetigt",
        to: "nachpruefung_erforderlich",
        actorKind: "system",
        decision: null,
      },
      {
        from: "bestaetigt",
        to: "nachpruefung_erforderlich",
        actorKind: "system",
        decision: null,
      },
      {
        from: "nachpruefung_erforderlich",
        to: "erfasst",
        actorKind: "system",
        decision: null,
      },
    ]);
  });

  it("keeps verworfen outgoing-terminal and bestaetigt reopenable only by TMB-7's system edges", () => {
    // Since TMB-7 bestaetigt is settled, not eternal: exactly two
    // narrowly-scoped system edges reopen it (source revision → Nachprüfung,
    // negative warm-run relevance → adjudication). verworfen stays fully
    // terminal, and a discard is still never directly reachable from
    // adjudication (repair is offered first).
    expect(
      TRANSITIONS.filter((def) => def.from === "bestaetigt").map((def) => ({
        to: def.to,
        actorKind: def.actorKind,
      })),
    ).toEqual([
      { to: "zur_adjudikation", actorKind: "system" },
      { to: "nachpruefung_erforderlich", actorKind: "system" },
    ]);
    expect(TRANSITIONS.filter((def) => def.from === "verworfen")).toHaveLength(
      0,
    );
    expect(
      TRANSITIONS.filter(
        (def) => def.from === "zur_adjudikation" && def.to === "verworfen",
      ),
    ).toHaveLength(0);
  });

  it("has no duplicate (from, to, actorKind) triple (findTransition first-match trap)", () => {
    const seen = new Set<string>();
    for (const def of TRANSITIONS) {
      const key = `${def.from}→${def.to}:${def.actorKind}`;
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe("committed artifacts", () => {
  it("keeps the generated JSON Schema at the repo root", () => {
    expect(
      fs.existsSync(path.join(repoRoot, "schema", "claims.schema.json")),
    ).toBe(true);
  });
});

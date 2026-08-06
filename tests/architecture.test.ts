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
    // Chain links and status changes must only be producible inside a
    // RegisterStore transaction (single-writer invariant).
    expect(surface.ChainAppender).toBeUndefined();
    expect(surface.applyTransition).toBeUndefined();
    expect(surface.createClaim).toBeUndefined();
    expect(surface.withProjectLock).toBeUndefined();
    expect(surface.writeFileAtomic).toBeUndefined();
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

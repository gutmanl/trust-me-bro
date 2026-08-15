import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getBlob } from "../app/api/projects/[id]/blobs/[...path]/route";
import { GET as getDerived } from "../app/api/projects/[id]/export/derived/[name]/route";
import { GET as getExport } from "../app/api/projects/[id]/export/route";
import { GET as getMetrics } from "../app/api/projects/[id]/metrics/route";
import { runVerify } from "../cli/verify";
import {
  BriefingAlreadyImportedError,
  completeFirstRunSetup,
  createProject,
  exportProjectBundle,
  importBriefing,
  importProjectBundle,
  InvalidBriefingInputError,
  InvalidBundleError,
  InvalidIdentityInputError,
  InvalidProjectInputError,
  isSetupComplete,
  ProjectAlreadyExistsError,
  readProject,
} from "../lib/pipeline";
import type { BackendCli } from "../lib/pipeline/projects";

/**
 * First contact: an evaluator who has never seen the tool, working from the
 * README alone. Every scenario here is a plausible first-session move — a
 * typo'd id, the wrong file in an upload field, a briefing pasted twice, an
 * URL probed by hand — and the pinned behavior is the same everywhere:
 * a German, actionable refusal (or a 404) and no half-written state on
 * disk. Anything that instead surfaces as a framework crash page or an
 * English errno is a bug, several of which this suite was written against.
 */

let workspace: string;
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-first-contact-"));
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  workspace = scratch();
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "eval");
  vi.stubEnv("TMB_CONFIG_PATH", path.join(scratch(), "config.json"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function createMockProject(id: string): Promise<void> {
  await createProject({
    id,
    research_question: "Verbessert Werkzeug X die Verlässlichkeit?",
    primaryCli: "mock",
  });
}

describe("the setup wizard meets real names", () => {
  it.each(["Jörg", "L G", "lg!", "Ärger", "-beginnt-falsch"])(
    "rejects handle %j in German and leaves the installation unconfigured",
    (handle) => {
      vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
      expect(() => completeFirstRunSetup({ actorHandle: handle })).toThrow(
        InvalidIdentityInputError,
      );
      expect(() => completeFirstRunSetup({ actorHandle: handle })).toThrow(
        /Kleinbuchstaben/,
      );
      // Nothing persisted: the setup gate stays engaged.
      expect(isSetupComplete()).toBe(false);
    },
  );

  it("accepts a plain lowercase handle and creates the workspace", () => {
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    completeFirstRunSetup({ actorHandle: "jm" });
    expect(isSetupComplete()).toBe(true);
    expect(fs.existsSync(workspace)).toBe(true);
  });
});

describe("creating the first project", () => {
  it("rejects an uppercase or spaced project id with the expected format", async () => {
    for (const id of ["MeinProjekt", "mein projekt", "Projekt-1"]) {
      await expect(
        createProject({
          id,
          research_question: "Wirkt X?",
          primaryCli: "mock",
        }),
      ).rejects.toThrow(InvalidProjectInputError);
    }
    await expect(
      createProject({
        id: "MeinProjekt",
        research_question: "Wirkt X?",
        primaryCli: "mock",
      }),
    ).rejects.toThrow(/proj_beispiel/);
  });

  it("rejects an empty research question", async () => {
    await expect(
      createProject({
        id: "proj_leer",
        research_question: "   ",
        primaryCli: "mock",
      }),
    ).rejects.toThrow(/Recherchefrage/);
  });

  it("rejects the same model family as primary and secondary (divergence rule)", async () => {
    await expect(
      createProject({
        id: "proj_doppelt",
        research_question: "Wirkt X?",
        primaryCli: "claude",
        secondaryCli: "claude",
      }),
    ).rejects.toThrow(/Modellfamilie/);
  });

  it("rejects a backend id it does not know", async () => {
    await expect(
      createProject({
        id: "proj_fremd",
        research_question: "Wirkt X?",
        primaryCli: "gemini" as BackendCli,
      }),
    ).rejects.toThrow(/Unbekanntes Backend/);
  });

  it("refuses to create the same project twice", async () => {
    await createMockProject("proj_einmal");
    await expect(createMockProject("proj_einmal")).rejects.toThrow(
      ProjectAlreadyExistsError,
    );
  });
});

describe("importing the briefing", () => {
  beforeEach(async () => {
    await createMockProject("proj_briefing");
  });

  it("rejects an empty or whitespace-only briefing", async () => {
    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: " \n ",
        tool: "t",
      }),
    ).rejects.toThrow(InvalidBriefingInputError);
  });

  it("requires the generating tool to be named", async () => {
    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: "Text.",
        tool: "",
      }),
    ).rejects.toThrow(/Werkzeug/);
  });

  it("refuses a second import — the frozen original is immutable", async () => {
    await importBriefing({
      projectId: "proj_briefing",
      content: "# Briefing\n\nBehauptung A [1].",
      tool: "deep-research-tool",
    });
    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: "Ganz anderer Text.",
        tool: "deep-research-tool",
      }),
    ).rejects.toThrow(BriefingAlreadyImportedError);
    // The first import survives unchanged.
    const register = await readProject("proj_briefing");
    expect(register.project.briefing_import?.tool).toBe("deep-research-tool");
  });

  it("refuses the reserved in-app research prefix as a tool name", async () => {
    await expect(
      importBriefing({
        projectId: "proj_briefing",
        content: "Text.",
        tool: "trustmebro-research/v9",
      }),
    ).rejects.toThrow(/reserviert/);
  });
});

describe("the wrong file lands in the bundle import", () => {
  it("rejects a text file renamed to .tmb and leaves no directory behind", async () => {
    await expect(
      importProjectBundle({
        bytes: Buffer.from("Das ist gar kein ZIP-Archiv."),
        targetDirectoryName: "proj_import",
      }),
    ).rejects.toThrow(InvalidBundleError);
    expect(fs.existsSync(path.join(workspace, "proj_import"))).toBe(false);
  });

  it("rejects an invalid target directory name in German", async () => {
    await expect(
      importProjectBundle({
        bytes: Buffer.from("egal"),
        targetDirectoryName: "Mein Import",
      }),
    ).rejects.toThrow(/Verzeichnisname/);
  });

  it("refuses to import over an existing project", async () => {
    await createMockProject("proj_da");
    const bundle = await exportProjectBundle("proj_da", { includeBlobs: true });
    await expect(
      importProjectBundle({
        bytes: Buffer.from(bundle.bytes),
        targetDirectoryName: "proj_da",
      }),
    ).rejects.toThrow(ProjectAlreadyExistsError);
  });
});

describe("the full evaluator round-trip: export, re-import, independent verify", () => {
  beforeEach(async () => {
    await createMockProject("proj_rund");
    await importBriefing({
      projectId: "proj_rund",
      content: "# Briefing\n\nBehauptung A [1].\n",
      tool: "deep-research-tool",
    });
  });

  it("re-imports its own export under a new name and both verify clean", async () => {
    const bundle = await exportProjectBundle("proj_rund", {
      includeBlobs: true,
    });
    const bundlePath = path.join(scratch(), bundle.filename);
    fs.writeFileSync(bundlePath, Buffer.from(bundle.bytes));

    // The recipient's independent check, straight on the downloaded file.
    const bundleReport = runVerify(bundlePath);
    expect(bundleReport.messages.join("\n")).toContain("manifest ok");
    expect(bundleReport.ok).toBe(true);

    const imported = await importProjectBundle({
      bytes: Buffer.from(bundle.bytes),
      targetDirectoryName: "proj_kopie",
    });
    expect(imported.innerProjectId).toBe("proj_rund");

    const directoryReport = runVerify(path.join(workspace, "proj_kopie"));
    expect(directoryReport.messages.join("\n")).toContain("blob integrity ok");
    expect(directoryReport.ok).toBe(true);

    // The workspace name is routing identity; the chain-bound id survives.
    const register = await readProject("proj_kopie");
    expect(register.project.id).toBe("proj_rund");
  });

  it("names the unverifiable blobs after a lean-bundle import instead of passing them", async () => {
    const lean = await exportProjectBundle("proj_rund", {
      includeBlobs: false,
    });
    const leanPath = path.join(scratch(), lean.filename);
    fs.writeFileSync(leanPath, Buffer.from(lean.bytes));

    // The lean bundle itself is honest about what it can prove …
    const bundleReport = runVerify(leanPath);
    expect(bundleReport.ok).toBe(true);
    expect(bundleReport.messages.join("\n")).toContain("lean bundle");

    // … and a directory materialized from it must not silently pass blob
    // checks it cannot run (ratified: an integrity tool fails what it
    // cannot verify, with the lean-import hint).
    await importProjectBundle({
      bytes: Buffer.from(lean.bytes),
      targetDirectoryName: "proj_schlank",
    });
    const directoryReport = runVerify(path.join(workspace, "proj_schlank"));
    expect(directoryReport.ok).toBe(false);
    expect(directoryReport.messages.join("\n")).toContain(
      "lean import without blobs?",
    );
  });
});

describe("probing the HTTP API by hand", () => {
  function params<T extends Record<string, unknown>>(value: T) {
    return { params: Promise.resolve(value) };
  }

  it("answers 404, not a crash, for an unknown project on every GET route", async () => {
    const request = new Request("http://127.0.0.1/api/egal");
    const responses = await Promise.all([
      getMetrics(request, params({ id: "proj_fehlt" })),
      getExport(request, params({ id: "proj_fehlt" })),
      getDerived(request, params({ id: "proj_fehlt", name: "traces.json" })),
      getBlob(request, params({ id: "proj_fehlt", path: ["blobs", "x"] })),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });

  it("answers 404 for traversal-shaped project ids instead of touching the path", async () => {
    const request = new Request("http://127.0.0.1/api/egal");
    for (const id of ["../außerhalb", "..", "UPPER", ".versteckt"]) {
      const response = await getMetrics(request, params({ id }));
      expect(response.status).toBe(404);
    }
  });

  it("answers 404 for a derived file it does not offer", async () => {
    await createMockProject("proj_api");
    const response = await getDerived(new Request("http://127.0.0.1/api/x"), {
      params: Promise.resolve({ id: "proj_api", name: "secrets.json" }),
    });
    expect(response.status).toBe(404);
  });

  it("answers 404 for a traversal-shaped blob path inside a real project", async () => {
    await createMockProject("proj_blob");
    const response = await getBlob(new Request("http://127.0.0.1/api/x"), {
      params: Promise.resolve({
        id: "proj_blob",
        path: ["..", "..", "config.json"],
      }),
    });
    expect(response.status).toBe(404);
  });

  it("serves the metrics of a real project as JSON and CSV downloads", async () => {
    await createMockProject("proj_metrik");
    const json = await getMetrics(
      new Request("http://127.0.0.1/api/projects/proj_metrik/metrics"),
      params({ id: "proj_metrik" }),
    );
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toContain("application/json");

    const csv = await getMetrics(
      new Request(
        "http://127.0.0.1/api/projects/proj_metrik/metrics?format=csv",
      ),
      params({ id: "proj_metrik" }),
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bundleText, unzipBundle, zipBundle } from "../../export";
import { RegisterStore, verifyChain } from "../../register";
import { importBriefing } from "../briefing";
import {
  InvalidBundleError,
  InvalidProjectInputError,
  ProjectAlreadyExistsError,
} from "../errors";
import { createProject, getProjectSummary } from "../projects";
import { captureSource, freezeSourceSet } from "../sources/capture";
import { fakeFetcher } from "../sources/__fixtures__/fake-fetcher";
import { exportProjectBundle } from "./build-export";
import { importProjectBundle } from "./import-bundle";

const PROJECT = "proj_export";

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-import-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId: PROJECT,
    content: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
    tool: "deep-research-x",
  });
  await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "peer_reviewed_publication",
      manual: { title: "Studie", authors: "Studie, A." },
      upload: {
        content: Buffer.from(
          "median review time dropped from 42 to 19 minutes",
        ),
        filename: "studie.txt",
      },
    },
    { fetcher: fakeFetcher({}) },
  );
  await freezeSourceSet(PROJECT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("importProjectBundle (TMB-40)", () => {
  it("roundtrips byte-identically and continues the chain from the last link", async () => {
    const bundle = await exportProjectBundle(PROJECT, { includeBlobs: true });
    const result = await importProjectBundle({
      bytes: Buffer.from(bundle.bytes),
      targetDirectoryName: "projekt-kopie",
    });
    expect(result).toEqual({
      directoryName: "projekt-kopie",
      innerProjectId: PROJECT,
    });

    // Byte-identical claims.json (canonical acceptance criterion).
    const original = fs.readFileSync(
      path.join(workspace, PROJECT, "claims.json"),
    );
    const imported = fs.readFileSync(
      path.join(workspace, "projekt-kopie", "claims.json"),
    );
    expect(Buffer.compare(imported, original)).toBe(0);

    // The projection is re-rendered from the imported blob + register.
    expect(
      fs.existsSync(path.join(workspace, "projekt-kopie", "briefing.md")),
    ).toBe(true);

    // Routing id is the directory name; the chain-bound id becomes origin.
    const summary = await getProjectSummary("projekt-kopie");
    expect(summary.id).toBe("projekt-kopie");
    expect(summary.origin_id).toBe(PROJECT);

    // Writable: an ordinary transaction appends the next chain link.
    const store = RegisterStore.forProject("projekt-kopie");
    const before = await store.read();
    const lastSeq = Math.max(
      ...before.project_events.map((event) => event.seq),
      ...before.claims.flatMap((claim) =>
        claim.history.map((entry) => entry.seq),
      ),
    );
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "source_set_revised",
        reason: "Bestandsrevision nach Import (Test).",
        actor: "human:lg",
      });
    });
    const after = await store.read();
    expect(after.project_events.at(-1)?.seq).toBe(lastSeq + 1);
    expect(verifyChain(after).ok).toBe(true);
  });

  it("keeps the independence notice on the re-rendered briefing (same model family)", async () => {
    // A briefing the app researched itself with the same family as the
    // primary verification backend (claude → family "anthropic") must carry
    // the "Hinweis zur Unabhängigkeit" on every artifact, including the one
    // re-rendered after import — the bundle's own briefing.md is discarded.
    const SELF = "proj_self_research";
    await createProject({
      id: SELF,
      research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
      primaryCli: "claude",
    });
    await importBriefing({
      projectId: SELF,
      content: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
      tool: "trustmebro-research/claude",
    });
    await captureSource(
      {
        projectId: SELF,
        kind: "upload",
        sourceType: "peer_reviewed_publication",
        manual: { title: "Studie", authors: "Studie, A." },
        upload: {
          content: Buffer.from("median review time dropped"),
          filename: "studie.txt",
        },
      },
      { fetcher: fakeFetcher({}) },
    );
    await freezeSourceSet(SELF);

    const bundle = await exportProjectBundle(SELF, { includeBlobs: true });
    await importProjectBundle({
      bytes: Buffer.from(bundle.bytes),
      targetDirectoryName: "self-kopie",
    });

    const briefing = fs.readFileSync(
      path.join(workspace, "self-kopie", "briefing.md"),
      "utf8",
    );
    expect(briefing).toContain("Hinweis zur Unabhängigkeit");
  });

  it("imports a lean bundle; the briefing projection stays absent", async () => {
    const bundle = await exportProjectBundle(PROJECT, { includeBlobs: false });
    await importProjectBundle({
      bytes: Buffer.from(bundle.bytes),
      targetDirectoryName: "projekt-schlank",
    });
    const dir = path.join(workspace, "projekt-schlank");
    expect(fs.existsSync(path.join(dir, "claims.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "blobs"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "briefing.md"))).toBe(false);
    expect((await RegisterStore.atDirectory(dir).verify()).ok).toBe(true);
  });

  it("rejects a name collision without touching the existing project", async () => {
    const bundle = await exportProjectBundle(PROJECT, { includeBlobs: true });
    await expect(
      importProjectBundle({
        bytes: Buffer.from(bundle.bytes),
        targetDirectoryName: PROJECT,
      }),
    ).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
  });

  it("rejects an invalid workspace name", async () => {
    const bundle = await exportProjectBundle(PROJECT, { includeBlobs: true });
    await expect(
      importProjectBundle({
        bytes: Buffer.from(bundle.bytes),
        targetDirectoryName: "Projekt Kopie",
      }),
    ).rejects.toBeInstanceOf(InvalidProjectInputError);
  });

  it("aborts on a tampered bundle with a diagnosis and writes nothing", async () => {
    const bundle = await exportProjectBundle(PROJECT, { includeBlobs: true });
    const files = unzipBundle(bundle.bytes);
    const claims = bundleText.decode(files["claims.json"]);
    files["claims.json"] = bundleText.encode(
      // Silent edit of the research question, manifest left as-is.
      claims.replace("Reviewzeit", "Bearbeitungszeit"),
    );
    const tampered = zipBundle(files, "2026-08-08T12:00:00Z");

    await expect(
      importProjectBundle({
        bytes: Buffer.from(tampered),
        targetDirectoryName: "projekt-manipuliert",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "InvalidBundleError",
        message: expect.stringContaining("Prüfsumme"),
      }),
    );
    expect(fs.existsSync(path.join(workspace, "projekt-manipuliert"))).toBe(
      false,
    );
  });

  it("rejects bytes that are no bundle", async () => {
    await expect(
      importProjectBundle({
        bytes: Buffer.from("kein zip"),
        targetDirectoryName: "projekt-kaputt",
      }),
    ).rejects.toBeInstanceOf(InvalidBundleError);
    expect(fs.existsSync(path.join(workspace, "projekt-kaputt"))).toBe(false);
  });
});

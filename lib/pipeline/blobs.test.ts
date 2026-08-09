import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../register";
import { UnknownBlobError, UnknownProjectError } from "./errors";
import { blobContentType, getProjectBlob } from "./blobs";
import { createProject } from "./projects";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-blobs-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("blobContentType", () => {
  it("maps known extensions and falls back to opaque bytes", () => {
    expect(blobContentType("blobs/ab/x.pdf")).toBe("application/pdf");
    expect(blobContentType("blobs/ab/x.html")).toBe("text/html; charset=utf-8");
    expect(blobContentType("blobs/ab/x.htm")).toBe("text/html; charset=utf-8");
    expect(blobContentType("blobs/ab/x.md")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(blobContentType("blobs/ab/x.txt")).toBe("text/plain; charset=utf-8");
    expect(blobContentType("blobs/ab/x.bin")).toBe("application/octet-stream");
  });
});

describe("getProjectBlob", () => {
  const PROJECT_ID = "proj_blobs";

  async function projectWithBlob(): Promise<string> {
    await createProject({
      id: PROJECT_ID,
      research_question: "Frage?",
      primaryCli: "claude",
    });
    const blob = RegisterStore.forProject(PROJECT_ID)
      .blobs()
      .put("Eingefrorener Inhalt.", "txt");
    return blob.blobPath;
  }

  it("serves an existing blob with its content type", async () => {
    const blobPath = await projectWithBlob();
    const blob = await getProjectBlob(PROJECT_ID, blobPath);
    expect(blob.buffer.toString("utf8")).toBe("Eingefrorener Inhalt.");
    expect(blob.contentType).toBe("text/plain; charset=utf-8");
  });

  it("maps missing blobs and malformed paths to UnknownBlobError", async () => {
    await projectWithBlob();
    await expect(
      getProjectBlob(
        PROJECT_ID,
        `blobs/aa/${"a".repeat(64)}.txt`, // valid shape, no such content
      ),
    ).rejects.toThrow(UnknownBlobError);
    await expect(
      getProjectBlob(PROJECT_ID, "../../claims.json"), // traversal shape
    ).rejects.toThrow(UnknownBlobError);
  });

  it("rejects unknown projects", async () => {
    await expect(
      getProjectBlob("proj_gibt-es-nicht", "blobs/aa/x.txt"),
    ).rejects.toThrow(UnknownProjectError);
  });
});

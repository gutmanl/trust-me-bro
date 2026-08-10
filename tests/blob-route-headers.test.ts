import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../app/api/projects/[id]/blobs/[...path]/route";
import { RegisterStore } from "../lib/register";
import type { ProjectConfig } from "../lib/register";

/**
 * S-03: the blob route used to return stored bytes with nothing but
 * content-type and cache-control, so a captured HTML snapshot executed its
 * scripts as same-origin content of the application. These tests pin the
 * headers that close that, and — just as importantly — pin that non-HTML
 * blobs still render inline, because the source viewer depends on it.
 *
 * app/** is outside the coverage gate; this test is here for correctness,
 * not for the ratio.
 */

const PROJECT = "proj_blobheaders";

const config: ProjectConfig = {
  rubric_version: "se-evidence-rubric-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};

let workspace: string;
let htmlPath: string;
let pdfPath: string;
let textPath: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-blobroute-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  const store = RegisterStore.forProject(PROJECT);
  await store.create({
    id: PROJECT,
    research_question: "Wirkt X?",
    config,
    actor: "human:lg",
  });
  const blobs = store.blobs();
  htmlPath = blobs.put(
    "<html><body><script>alert(1)</script></body></html>",
    "html",
  ).blobPath;
  pdfPath = blobs.put("PDF-Bytes", "pdf").blobPath;
  textPath = blobs.put("Nur Text", "txt").blobPath;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function request(blobPath: string) {
  return GET(new Request(`http://127.0.0.1/api/projects/${PROJECT}/blobs`), {
    params: Promise.resolve({ id: PROJECT, path: blobPath.split("/") }),
  });
}

describe("blob route security headers (S-03)", () => {
  it("serves a frozen HTML snapshot as inert, non-rendering evidence", async () => {
    const response = await request(htmlPath);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // Not sniffed into something executable.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Neutralised even if rendered anyway: no scripts, no origin, no
    // outbound requests.
    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    // Kept out of the rendering path in the first place.
    expect(response.headers.get("content-disposition")).toBe("attachment");
    // The bytes themselves are untouched — it is still evidence.
    expect(await response.text()).toContain("<script>alert(1)</script>");
  });

  it("serves an unmapped extension as opaque bytes, still with nosniff", async () => {
    // blobContentType only maps pdf/html/htm/md/txt; everything else is
    // application/octet-stream. That is already inert, so it is not forced
    // to attachment — but nosniff still matters, because sniffing is
    // exactly how an octet-stream would become executable.
    const store = RegisterStore.forProject(PROJECT);
    const other = store
      .blobs()
      .put("<svg xmlns='http://www.w3.org/2000/svg'/>", "svg");
    const response = await request(other.blobPath);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves a PDF blob renderable inline, as the source viewer needs", async () => {
    const response = await request(pdfPath);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    // Hardened, but not forced into a download and not sandboxed away.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("leaves a text blob renderable inline", async () => {
    const response = await request(textPath);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("still answers 404 for an unknown blob", async () => {
    const response = await request("blobs/aa/" + "0".repeat(64) + ".pdf");
    expect(response.status).toBe(404);
  });
});

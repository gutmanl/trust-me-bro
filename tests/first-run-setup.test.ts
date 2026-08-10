import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { completeSetupAction } from "../app/setup/actions";

/**
 * C1 regression (final-review fix wave): `app/setup/actions.ts` used to call
 * `setUnpaywallEmail` BEFORE `completeFirstRunSetup`. On a genuine first
 * run — no config file, no TMB_ACTOR_HANDLE — that reaches
 * `lib/identity/index.ts`'s `existing?.actorHandle ?? loadIdentityConfig()
 * .actorHandle`, which throws `IdentityNotConfiguredError` (not a
 * `PipelineError`), so `runPipelineAction` rethrows it and the action
 * crashes with an English framework error instead of completing setup.
 * Every other test in the suite stubs `TMB_ACTOR_HANDLE`, which is exactly
 * why this was missed — this test deliberately leaves both unstubbed.
 */

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-first-run-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("completeSetupAction: genuine first run with an Unpaywall address (C1)", () => {
  it("completes setup instead of crashing, and preserves both fields on disk", async () => {
    const dir = scratch();
    const configPath = path.join(dir, "config.json");
    const workspace = path.join(dir, "workspace");
    // Genuine first run: nothing stubs the actor handle away, and no config
    // file exists yet at configPath.
    vi.stubEnv("TMB_ACTOR_HANDLE", undefined);
    vi.stubEnv("TMB_CONFIG_PATH", configPath);
    vi.stubEnv("TMB_WORKSPACE", workspace);
    vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);

    const formData = new FormData();
    formData.set("actor_handle", "lg");
    formData.set("unpaywall_email", "lg@example.org");

    // A successful completion redirects (Next's redirect() throws a
    // NEXT_REDIRECT-digest error to signal navigation — that is success
    // here, not a crash). The pre-fix code instead threw
    // IdentityNotConfiguredError, whose digest is undefined.
    let digest: string | undefined;
    try {
      await completeSetupAction({ error: null }, formData);
      throw new Error("expected completeSetupAction to redirect");
    } catch (error) {
      digest = (error as { digest?: string }).digest;
      if (digest === undefined) {
        // Not a redirect — surface the real error for a clear test failure.
        throw error;
      }
    }
    expect(digest).toMatch(/^NEXT_REDIRECT/);

    expect(fs.existsSync(workspace)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk.actor_handle).toBe("lg");
    // The latent second bug: writeIdentityConfig used to write only
    // actorHandle/workspaceRoot, clobbering the just-written unpaywall_email.
    expect(onDisk.unpaywall_email).toBe("lg@example.org");
  });
});

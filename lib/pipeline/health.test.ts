import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendHealth } from "../adapters";
import { RegisterStore } from "../register";
import type { ProjectConfig } from "../register";
import {
  getBackendsHealth,
  probeBackendUsable,
  runLoginProbe,
  withoutSecondaryBackend,
} from "./health";

const PROJECT = "proj_health";

function health(cli: string, usable: boolean): BackendHealth {
  return {
    cli,
    usable,
    stages: [
      {
        stage: "on_path",
        status: usable ? "ok" : "failed",
        detail: usable ? `${cli} gefunden.` : `${cli} nicht gefunden.`,
        ...(usable ? {} : { hint: `${cli} installieren.` }),
      },
      { stage: "version_ok", status: "unknown", detail: "-" },
      { stage: "login_ok", status: "unknown", detail: "-" },
    ],
  };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-health-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function createTestProject(
  configOverrides: Partial<ProjectConfig> = {},
): Promise<void> {
  await RegisterStore.forProject(PROJECT).create({
    id: PROJECT,
    research_question: "Frage?",
    config: {
      rubric_version: "se-evidenz-rubrik-v1",
      adjudication_sample_rate: 0,
      backends: {
        primary: { cli: "claude", model_family: "anthropic" },
        secondary: { cli: "codex", model_family: "openai" },
      },
      ...configOverrides,
    },
    actor: "human:lg",
  });
}

describe("getBackendsHealth", () => {
  it("checks both configured backends", async () => {
    await createTestProject();
    const result = await getBackendsHealth(PROJECT, {
      check: async (cli) => health(cli, cli === "claude"),
    });
    expect(result.primary.cli).toBe("claude");
    expect(result.primary.usable).toBe(true);
    expect(result.secondary?.cli).toBe("codex");
    expect(result.secondary?.usable).toBe(false);
  });

  it("omits the secondary when none is configured", async () => {
    await createTestProject({
      backends: { primary: { cli: "claude", model_family: "anthropic" } },
    });
    const result = await getBackendsHealth(PROJECT, {
      check: async (cli) => health(cli, true),
    });
    expect(result.secondary).toBeUndefined();
  });
});

describe("runLoginProbe", () => {
  it("probes the requested backend", async () => {
    await createTestProject();
    const probed: string[] = [];
    const result = await runLoginProbe(PROJECT, "secondary", {
      probe: async (cli) => {
        probed.push(cli);
        return health(cli, true);
      },
    });
    expect(probed).toEqual(["codex"]);
    expect(result.cli).toBe("codex");
  });

  it("reports an unconfigured secondary instead of probing", async () => {
    await createTestProject({
      backends: { primary: { cli: "claude", model_family: "anthropic" } },
    });
    const result = await runLoginProbe(PROJECT, "secondary", {
      probe: async () => {
        throw new Error("must not probe");
      },
    });
    expect(result.usable).toBe(false);
    expect(result.stages[0].detail).toContain("Kein sekundäres Backend");
  });
});

describe("probeBackendUsable", () => {
  it("passes a usable backend through", async () => {
    await expect(
      probeBackendUsable("claude", async (cli) => health(cli, true)),
    ).resolves.toEqual({ usable: true });
  });

  it("surfaces the first failed stage's hint", async () => {
    await expect(
      probeBackendUsable("claude", async (cli) => health(cli, false)),
    ).resolves.toEqual({ usable: false, hint: "claude installieren." });
  });
});

describe("withoutSecondaryBackend", () => {
  it("drops only the secondary backend, keeping the rest of the config", async () => {
    await createTestProject();
    const config = (await RegisterStore.forProject(PROJECT).read()).config;
    const effective = withoutSecondaryBackend(config);
    expect(effective.backends.secondary).toBeUndefined();
    expect(effective.backends.primary).toEqual(config.backends.primary);
    expect(effective.rubric_version).toBe(config.rubric_version);
    // The stored project config is untouched (per-run degradation only).
    expect(config.backends.secondary?.cli).toBe("codex");
  });
});

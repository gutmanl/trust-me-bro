import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendHealth } from "../adapters";
import { RegisterStore } from "../register";
import type { ProjectConfig } from "../register";
import {
  getBackendsHealth,
  getInstallationBackendsHealth,
  probeBackendUsable,
  runInstallationLoginProbe,
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
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
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
      rubric_version: "se-evidence-rubric-v1",
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

describe("getInstallationBackendsHealth (TMB-54, D7)", () => {
  it("diagnoses every selectable backend without any project", async () => {
    // The point of the use-case: no project is created here, and none
    // exists. getBackendsHealth cannot answer this question at all, which
    // is why "create a project to find out you cannot use it" was the
    // status quo.
    const probed: string[] = [];
    const result = await getInstallationBackendsHealth({
      check: async (cli) => {
        probed.push(cli);
        return health(cli, cli !== "codex");
      },
    });
    expect(probed).toEqual(["claude", "codex", "mock"]);
    expect(result.map((backend) => backend.cli)).toEqual([
      "claude",
      "codex",
      "mock",
    ]);
    expect(result.map((backend) => backend.usable)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("includes the API spike backend only while its gate is open", async () => {
    vi.stubEnv("TMB_ENABLE_API_BACKEND", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const withSpike = await getInstallationBackendsHealth({
      check: async (cli) => health(cli, true),
    });
    expect(withSpike.map((backend) => backend.cli)).toContain("anthropic-api");

    vi.stubEnv("TMB_ENABLE_API_BACKEND", undefined);
    const withoutSpike = await getInstallationBackendsHealth({
      check: async (cli) => health(cli, true),
    });
    expect(withoutSpike.map((backend) => backend.cli)).not.toContain(
      "anthropic-api",
    );
  });
});

describe("runInstallationLoginProbe (TMB-54)", () => {
  it("probes one CLI by id, without a project's role assignment", async () => {
    const result = await runInstallationLoginProbe("claude", {
      probe: async (cli) => health(cli, true),
    });
    expect(result.cli).toBe("claude");
    expect(result.usable).toBe(true);
  });
});

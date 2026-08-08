import { beforeEach, describe, expect, it } from "vitest";

import type { Backend, ProcessRunner } from "../core/contracts";
import {
  AdapterProcessError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  AdapterValidationError,
} from "../core/errors";
import { z } from "zod";
import {
  __resetLoginProbeCacheForTests,
  checkCliHealth,
  runCliLoginProbe,
} from "./index";
import {
  buildBackendHealth,
  probeLogin,
  probePresenceAndVersion,
} from "./probe";
import { CLI_PROBE_SPECS } from "./specs";

function fakeRunner(result: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): ProcessRunner {
  return {
    run: async () => ({
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
    }),
  };
}

function fakeBackend(behavior: () => Promise<{ model: string }>): Backend {
  return {
    id: "claude",
    invoke: async () => {
      const { model } = await behavior();
      return {
        output: {
          relation_type: "stuetzt",
          confidence: 0.9,
          reasoning: "ok",
        },
        model,
      } as never;
    },
  };
}

beforeEach(() => {
  __resetLoginProbeCacheForTests();
});

describe("probePresenceAndVersion", () => {
  const spec = CLI_PROBE_SPECS.claude;

  it("maps a spawn failure to stage-1 failed with the install hint", async () => {
    const { onPath, version } = await probePresenceAndVersion(
      spec,
      fakeRunner({ exitCode: null, stderr: "spawn failed: ENOENT" }),
    );
    expect(onPath.status).toBe("failed");
    expect(onPath.hint).toContain("installieren");
    expect(version.status).toBe("unknown");
  });

  it("maps a timeout to stage-1 failed", async () => {
    const { onPath } = await probePresenceAndVersion(
      spec,
      fakeRunner({ exitCode: null, timedOut: true }),
    );
    expect(onPath.status).toBe("failed");
    expect(onPath.detail).toContain("Timeout");
  });

  it("accepts a compatible version", async () => {
    const { onPath, version } = await probePresenceAndVersion(
      spec,
      fakeRunner({ exitCode: 0, stdout: "2.1.223 (Claude Code)" }),
    );
    expect(onPath.status).toBe("ok");
    expect(version.status).toBe("ok");
    expect(version.detail).toContain("2.1.223");
  });

  it("fails a version below the known-good minimum, with a hint", async () => {
    const { version } = await probePresenceAndVersion(
      spec,
      fakeRunner({ exitCode: 0, stdout: "1.0.17" }),
    );
    expect(version.status).toBe("failed");
    expect(version.hint).toContain("aktualisieren");
  });

  it("degrades an unparsable version to unknown instead of blocking", async () => {
    const { version } = await probePresenceAndVersion(
      spec,
      fakeRunner({ exitCode: 0, stdout: "Claude Code (dev build)" }),
    );
    expect(version.status).toBe("unknown");
  });

  it("fails stage 2 when --version exits nonzero", async () => {
    const { onPath, version } = await probePresenceAndVersion(
      spec,
      fakeRunner({ exitCode: 1, stderr: "unknown flag" }),
    );
    expect(onPath.status).toBe("ok");
    expect(version.status).toBe("failed");
  });
});

describe("probeLogin", () => {
  const spec = CLI_PROBE_SPECS.claude;

  it("reports ok with the served model on a successful minimal call", async () => {
    const result = await probeLogin(
      spec,
      fakeBackend(async () => ({ model: "claude-sonnet-5" })),
    );
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("claude-sonnet-5");
    expect(result.checkedAt).toBeDefined();
  });

  it("treats schema-deviant output as a working login", async () => {
    const backend: Backend = {
      id: "claude",
      invoke: async () => {
        throw new AdapterValidationError(
          "claude",
          "attribution",
          z.string().safeParse(1).error!,
        );
      },
    };
    const result = await probeLogin(spec, backend);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("Probeschema");
  });

  it("reports a rate limit distinctly from a broken login", async () => {
    const backend: Backend = {
      id: "claude",
      invoke: async () => {
        throw new AdapterRateLimitError("claude", "attribution", "429");
      },
    };
    const result = await probeLogin(spec, backend);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("Rate-Limit");
    expect(result.hint).not.toContain("anmelden");
  });

  it("maps process failures to the login hint", async () => {
    const backend: Backend = {
      id: "claude",
      invoke: async () => {
        throw new AdapterProcessError(
          "claude",
          "attribution",
          1,
          "login required",
        );
      },
    };
    const result = await probeLogin(spec, backend);
    expect(result.status).toBe("failed");
    expect(result.hint).toBe(spec.loginHint);
  });

  it("maps timeouts to the login hint", async () => {
    const backend: Backend = {
      id: "claude",
      invoke: async () => {
        throw new AdapterTimeoutError("claude", "attribution", 5);
      },
    };
    const result = await probeLogin(spec, backend);
    expect(result.status).toBe("failed");
    expect(result.hint).toBe(spec.loginHint);
  });

  it("rethrows programming errors", async () => {
    const backend: Backend = {
      id: "claude",
      invoke: async () => {
        throw new TypeError("bug");
      },
    };
    await expect(probeLogin(spec, backend)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("checkCliHealth / runCliLoginProbe", () => {
  it("reports an unknown cli as not usable with a config hint", async () => {
    const health = await checkCliHealth("gemini");
    expect(health.usable).toBe(false);
    expect(health.stages[0].status).toBe("failed");
    expect(health.stages[0].hint).toContain("claude, codex");
  });

  it("marks stage 3 as unknown until the login probe ran", async () => {
    const health = await checkCliHealth("claude", {
      runner: fakeRunner({ exitCode: 0, stdout: "2.1.223" }),
    });
    expect(health.usable).toBe(true);
    expect(health.stages[2].status).toBe("unknown");
  });

  it("caches the login probe result for later health checks", async () => {
    const probed = await runCliLoginProbe("claude", {
      runner: fakeRunner({ exitCode: 0, stdout: "2.1.223" }),
      backend: fakeBackend(async () => ({ model: "claude-sonnet-5" })),
    });
    expect(probed.stages[2].status).toBe("ok");

    const later = await checkCliHealth("claude", {
      runner: fakeRunner({ exitCode: 0, stdout: "2.1.223" }),
    });
    expect(later.stages[2].status).toBe("ok");
    expect(later.stages[2].checkedAt).toBeDefined();
  });

  it("usable requires stage 1 ok and stage 2 not failed", () => {
    const ok = {
      stage: "on_path" as const,
      status: "ok" as const,
      detail: "",
    };
    expect(
      buildBackendHealth(
        "claude",
        ok,
        { stage: "version_ok", status: "unknown", detail: "" },
        undefined,
      ).usable,
    ).toBe(true);
    expect(
      buildBackendHealth(
        "claude",
        ok,
        { stage: "version_ok", status: "failed", detail: "" },
        undefined,
      ).usable,
    ).toBe(false);
  });
});

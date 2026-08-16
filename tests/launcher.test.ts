import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_START_PORT,
  INSTANCE_LOCK_FILE,
  clearInstanceLock,
  findFreePort,
  isNodeVersionSupported,
  parseStartPort,
  readInstanceLock,
  writeInstanceLock,
} from "../bin/launcher-lib.mjs";

/**
 * The launcher's port and version logic is release-critical and
 * cross-platform-sensitive; these cover the two pieces that can be tested
 * without spawning the real standalone server.
 */

describe("isNodeVersionSupported", () => {
  it.each(["20.9.0", "20.10.3", "21.0.0", "22.23.2", "20.9.1"])(
    "accepts %s",
    (version) => {
      expect(isNodeVersionSupported(version)).toBe(true);
    },
  );

  it.each(["20.8.9", "18.19.0", "20.0.0", "19.99.0"])(
    "rejects %s",
    (version) => {
      expect(isNodeVersionSupported(version)).toBe(false);
    },
  );

  it("fails closed on an unparseable version", () => {
    expect(isNodeVersionSupported("nonsense")).toBe(false);
    expect(isNodeVersionSupported("")).toBe(false);
  });

  it("honours a custom minimum", () => {
    expect(isNodeVersionSupported("22.5.0", [22, 6])).toBe(false);
    expect(isNodeVersionSupported("22.6.0", [22, 6])).toBe(true);
  });
});

describe("parseStartPort", () => {
  it("falls back to the default when the variable is unset or blank", () => {
    expect(parseStartPort(undefined)).toBe(DEFAULT_START_PORT);
    expect(parseStartPort("")).toBe(DEFAULT_START_PORT);
    expect(parseStartPort("   ")).toBe(DEFAULT_START_PORT);
  });

  it("accepts a plain port number, tolerating surrounding whitespace", () => {
    expect(parseStartPort("8080")).toBe(8080);
    expect(parseStartPort(" 4173 ")).toBe(4173);
  });

  it.each(["abc", "70000", "0", "-1", "4173.5", "8080abc"])(
    "rejects %j with a message that names the variable",
    (raw) => {
      // The raw Node error ("options.port should be >= 0 and < 65536")
      // never mentions TMB_PORT — the launcher's own message must.
      expect(() => parseStartPort(raw)).toThrow(/TMB_PORT/);
      expect(() => parseStartPort(raw)).toThrow(/1 und 65535/);
    },
  );

  it("names an alternate variable when the value came from PORT", () => {
    expect(() => parseStartPort("nope", "PORT")).toThrow(/^PORT=/);
  });
});

describe("findFreePort", () => {
  let occupied: net.Server | undefined;

  afterEach(async () => {
    if (occupied) {
      await new Promise<void>((resolve) => occupied?.close(() => resolve()));
      occupied = undefined;
    }
  });

  it("returns a free port at the start when one is available", async () => {
    // Grab an OS-assigned free port, release it, then ask for it back.
    const probe = net.createServer();
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () =>
        resolve((probe.address() as AddressInfo).port),
      );
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const chosen = await findFreePort(freePort);
    expect(chosen).toBe(freePort);
  });

  it("skips an occupied port and returns the next free one", async () => {
    occupied = net.createServer();
    const port = await new Promise<number>((resolve) => {
      occupied?.listen(0, "127.0.0.1", () =>
        resolve((occupied?.address() as AddressInfo).port),
      );
    });

    const chosen = await findFreePort(port);
    expect(chosen).toBeGreaterThan(port);
  });

  it("rejects in German instead of walking past the end of the port range", async () => {
    occupied = net.createServer();
    await new Promise<void>((resolve) => {
      occupied?.listen(65535, "127.0.0.1", () => resolve());
      occupied?.once("error", () => resolve()); // already taken elsewhere: fine
    });
    // 65535 is occupied (by us or by someone else — either way), so the
    // walk reaches the end of the port range. It must reject with the
    // launcher's own message, not a raw English Node range error.
    await expect(findFreePort(65535)).rejects.toThrow(/Kein freier Port/);
  });

  it("rejects an invalid start port instead of crashing the probe", async () => {
    await expect(findFreePort(Number.NaN)).rejects.toThrow(/ungültig/);
    await expect(findFreePort(0)).rejects.toThrow(/ungültig/);
  });

  it("rejects when no port is free within the attempt budget", async () => {
    occupied = net.createServer();
    const port = await new Promise<number>((resolve) => {
      occupied?.listen(0, "127.0.0.1", () =>
        resolve((occupied?.address() as AddressInfo).port),
      );
    });
    // One occupied port, budget of zero further attempts → no room to move.
    await expect(findFreePort(port, 0)).rejects.toThrow(/Kein freier Port/);
  });
});

describe("the instance lock (one server per workspace)", () => {
  /**
   * The launcher used to skip an occupied port and start a second server
   * against the same workspace. That is silent by construction — a
   * double-clicked shortcut just gets the next port — and it quietly breaks
   * the promise the interface makes in two places ("Pro Projekt kann nur ein
   * Lauf gleichzeitig laufen"), because the run gate is an in-memory
   * registry and therefore per process. The register itself survives it; the
   * user pays in doubled agent-CLI quota.
   */
  const workspaces: string[] = [];

  function workspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-lock-"));
    workspaces.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of workspaces.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no running instance for a workspace nobody has served", () => {
    expect(readInstanceLock(workspace(), fs)).toBeNull();
  });

  it("reports a live foreign instance with the port it is serving on", () => {
    const dir = workspace();
    // A pid that is alive and is not us: the test runner's own parent.
    fs.writeFileSync(
      path.join(dir, INSTANCE_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, port: 4173 }),
    );
    expect(readInstanceLock(dir, fs)).toMatchObject({
      pid: process.ppid,
      port: 4173,
    });
  });

  it("ignores its own lock, so a restart in one process is not a conflict", () => {
    const dir = workspace();
    writeInstanceLock(dir, 4173, fs);
    expect(readInstanceLock(dir, fs)).toBeNull();
  });

  it("treats a lock whose process is gone as absent rather than blocking", () => {
    // A crash or a power cut leaves a lock behind. Refusing to start until
    // someone deletes a file by hand would be a worse failure than the one
    // being prevented.
    const dir = workspace();
    fs.writeFileSync(
      path.join(dir, INSTANCE_LOCK_FILE),
      JSON.stringify({ pid: 2_147_483_646, port: 4173 }),
    );
    expect(readInstanceLock(dir, fs)).toBeNull();
  });

  it.each([
    ["not JSON at all", "{{{"],
    ["JSON without a pid", JSON.stringify({ port: 4173 })],
    ["JSON without a port", JSON.stringify({ pid: 1 })],
    ["a non-integer port", JSON.stringify({ pid: 1, port: "4173" })],
  ])("treats %s as absent instead of throwing", (_label, contents) => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, INSTANCE_LOCK_FILE), contents);
    expect(readInstanceLock(dir, fs)).toBeNull();
  });

  it("creates the workspace directory when writing the lock", () => {
    // First run on a fresh installation: the workspace root does not exist
    // yet when the launcher claims it.
    const dir = path.join(workspace(), "nested", "workspace");
    writeInstanceLock(dir, 4200, fs);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, INSTANCE_LOCK_FILE), "utf8")),
    ).toMatchObject({ pid: process.pid, port: 4200 });
  });

  it("clears only its own lock, never one a newer instance wrote", () => {
    const dir = workspace();
    writeInstanceLock(dir, 4173, fs);
    clearInstanceLock(dir, fs);
    expect(fs.existsSync(path.join(dir, INSTANCE_LOCK_FILE))).toBe(false);

    fs.writeFileSync(
      path.join(dir, INSTANCE_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, port: 9999 }),
    );
    clearInstanceLock(dir, fs);
    expect(fs.existsSync(path.join(dir, INSTANCE_LOCK_FILE))).toBe(true);
  });

  it("survives being asked to clear a lock that is not there", () => {
    expect(() => clearInstanceLock(workspace(), fs)).not.toThrow();
  });
});

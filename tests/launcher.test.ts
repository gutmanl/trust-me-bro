import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_START_PORT,
  findFreePort,
  isNodeVersionSupported,
  parseStartPort,
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

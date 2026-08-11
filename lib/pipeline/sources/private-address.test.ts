import { describe, expect, it } from "vitest";

import { BlockedAddressError } from "../errors";
import {
  assertAllowedUrl,
  isBlockedAddress,
  type HostResolver,
} from "./private-address";

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254", // cloud-metadata endpoint
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ])("blocks the non-public IPv4 %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"])(
    "allows the public IPv4 %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each([
    "::1", // loopback
    "::", // unspecified
    "fc00::1", // unique-local
    "fd12:3456::1", // unique-local
    "fe80::1", // link-local
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::127.0.0.1", // IPv4-compatible loopback (Node: ::7f00:1)
    "::169.254.169.254", // IPv4-compatible metadata endpoint
    "::10.0.0.1", // IPv4-compatible private
    "::7f00:1", // the same as ::127.0.0.1 in Node's hex-group spelling
  ])("blocks the non-public IPv6 %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows the public IPv6 %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it("fails closed on anything that is not an IP literal", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("assertAllowedUrl", () => {
  const never: HostResolver = () => {
    throw new Error("resolver must not run for a literal IP");
  };
  const resolvesTo =
    (...addresses: string[]): HostResolver =>
    async () =>
      addresses;

  it("passes a literal public IP without resolving", async () => {
    await expect(
      assertAllowedUrl("http://93.184.216.34/x", never),
    ).resolves.toBeUndefined();
  });

  it("blocks a literal loopback IP without resolving", async () => {
    await expect(
      assertAllowedUrl("http://127.0.0.1:8080/x", never),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks a bracketed literal IPv6 loopback", async () => {
    await expect(
      assertAllowedUrl("http://[::1]/x", never),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks a bracketed IPv4-compatible IPv6 loopback", async () => {
    // Node normalizes [::127.0.0.1] to [::7f00:1]; the guard must still see
    // through it to the embedded loopback address.
    await expect(
      assertAllowedUrl("http://[::127.0.0.1]/x", never),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks the cloud-metadata address by name resolution", async () => {
    await expect(
      assertAllowedUrl(
        "http://metadata.internal/x",
        resolvesTo("169.254.169.254"),
      ),
    ).rejects.toThrow(/nicht öffentliche Adresse/);
  });

  it("allows a name that resolves only to public addresses", async () => {
    await expect(
      assertAllowedUrl("https://example.org/x", resolvesTo("93.184.216.34")),
    ).resolves.toBeUndefined();
  });

  it("blocks a name that resolves to a mix of public and private", async () => {
    // A rebinding-style answer with one good and one bad address is refused.
    await expect(
      assertAllowedUrl(
        "https://evil.test/x",
        resolvesTo("8.8.8.8", "10.0.0.1"),
      ),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks a name that resolves to nothing", async () => {
    await expect(
      assertAllowedUrl("https://empty.test/x", resolvesTo()),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(
      assertAllowedUrl("file:///etc/passwd", never),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("rejects a string that is not a URL", async () => {
    await expect(assertAllowedUrl("not a url", never)).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });
});

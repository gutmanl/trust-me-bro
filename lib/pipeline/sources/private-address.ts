import { isIP } from "node:net";

import { BlockedAddressError } from "../errors";

/**
 * SSRF address filtering (S-06). Source and reference URLs come out of
 * briefings — untrusted material — and are fetched by the server, so a URL
 * pointing at a non-public address would make the server reach hosts only it
 * can see (its own loopback services, the cloud-metadata endpoint, the LAN).
 * This module classifies a resolved IP and guards a URL before it is
 * fetched.
 *
 * The classification is pure and exhaustively unit-tested; the DNS resolver
 * is injected (the production one, using node:dns, lives in the sanctioned
 * network module node-http-fetcher.ts), so this file stays free of network
 * access and the architecture guard over it holds.
 *
 * Scope, stated honestly: the check resolves the host and refuses a
 * disallowed address on every hop, but does not pin the resolved IP into the
 * connection. A hostile authoritative DNS server that answers with a public
 * address for the check and a private one for the immediately following
 * connect (DNS rebinding) is therefore not closed. Closing it needs a custom
 * connection dispatcher; for a loopback-bound single-user tool the residual
 * window is out of scope, and the far more likely vector — a URL that simply
 * names a private address or a host that resolves to one — is closed.
 */

/** A host-name resolver: every address the name resolves to. Injected so the
 * classification can be tested without touching the network. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

function ipv4Blocked(a: number, b: number): boolean {
  // 0.0.0.0/8 this-network · 10/8 private · 100.64/10 CGNAT ·
  // 127/8 loopback · 169.254/16 link-local (incl. 169.254.169.254 metadata) ·
  // 172.16/12 private · 192.168/16 private · 224/4 multicast ·
  // 240/4 reserved (incl. 255.255.255.255 broadcast).
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Parses an IPv6 literal to its 16 bytes, expanding "::" and an embedded
 * IPv4 tail; null for anything malformed. */
function ipv6Bytes(ip: string): number[] | null {
  const [head, tail, ...extra] = ip.split("::");
  if (extra.length > 0) {
    return null; // more than one "::" is illegal
  }
  const parseGroups = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const bytes: number[] = [];
    for (const group of part.split(":")) {
      const embeddedV4 = group.includes(".");
      if (embeddedV4) {
        if (isIP(group) !== 4) {
          return null;
        }
        for (const octet of group.split(".")) {
          bytes.push(Number(octet));
        }
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) {
        return null;
      }
      const value = parseInt(group, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };
  const headBytes = parseGroups(head);
  const tailBytes = tail === undefined ? [] : parseGroups(tail);
  if (headBytes === null || tailBytes === null) {
    return null;
  }
  const gap = 16 - headBytes.length - tailBytes.length;
  if (tail === undefined) {
    return headBytes.length === 16 ? headBytes : null;
  }
  if (gap < 0) {
    return null;
  }
  return [...headBytes, ...Array<number>(gap).fill(0), ...tailBytes];
}

/**
 * Whether an IP literal is a non-public address that must not be fetched.
 * Anything it cannot parse is treated as blocked — the guard fails closed.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    return ipv4Blocked(a, b);
  }
  if (kind === 6) {
    const bytes = ipv6Bytes(ip);
    if (bytes === null) {
      return true;
    }
    // High 96 bits zero: both the IPv4-mapped form (::ffff:a.b.c.d) and the
    // deprecated IPv4-compatible form (::a.b.c.d — which is how Node
    // normalizes e.g. [::127.0.0.1] to [::7f00:1]) embed an IPv4 address in
    // the low 32 bits. Classify by that address, so ::ffff:127.0.0.1,
    // ::127.0.0.1, and :: / ::1 (which are 0.0.0.0 / 0.0.0.1, blocked as
    // 0.0.0.0/8) are all caught. The more exotic embeddings (6to4 2002::/16,
    // NAT64 64:ff9b::/96) are out of scope, as documented above.
    if (bytes.slice(0, 10).every((byte) => byte === 0)) {
      const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
      const compatible = bytes[10] === 0 && bytes[11] === 0;
      if (mapped || compatible) {
        return ipv4Blocked(bytes[12], bytes[13]);
      }
    }
    return (
      (bytes[0] & 0xfe) === 0xfc || // fc00::/7 unique-local
      (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || // fe80::/10 link-local
      bytes[0] === 0xff // ff00::/8 multicast
    );
  }
  return true; // not a valid IP literal: fail closed
}

/** Strips the brackets a URL keeps around an IPv6 host. */
function unwrapHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Throws BlockedAddressError unless the URL is an http(s) URL whose target is
 * a public address. A literal-IP host is classified directly; a name is
 * resolved and refused if ANY of its addresses is non-public (a resolver
 * that returns both a public and a private address is still refused). Called
 * before the initial request and before every redirect hop.
 */
export async function assertAllowedUrl(
  rawUrl: string,
  resolve: HostResolver,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedAddressError(
      `Abruf abgebrochen: "${rawUrl}" ist keine URL.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddressError(
      `Abruf abgebrochen: nur http(s) wird abgerufen, nicht "${url.protocol}".`,
    );
  }
  const host = unwrapHost(url.hostname);
  const refuse = (): never => {
    throw new BlockedAddressError(
      `Abruf abgebrochen: "${url.hostname}" verweist auf eine nicht ` +
        "öffentliche Adresse (lokal, privat oder link-local) und wird zum " +
        "Schutz nicht abgerufen.",
    );
  };

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      refuse();
    }
    return;
  }
  const addresses = await resolve(host);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    refuse();
  }
}

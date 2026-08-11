import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { BlockedAddressError, ResourceLimitExceededError } from "../errors";
import {
  createNodeHttpFetcher,
  MAX_REDIRECTS,
  nodeHttpFetcher,
} from "./node-http-fetcher";

// The resource-limit tests fetch a real loopback server, which the SSRF
// guard would (correctly) refuse. They exercise size/redirect/time bounds,
// not the address policy, so they run against a fetcher with a permissive
// check; the address policy has its own end-to-end test below and its unit
// tests in private-address.test.ts.
const localFetcher = createNodeHttpFetcher({ checkUrl: async () => {} });

/**
 * S-06: sources are fetched from addresses that come out of a briefing, so
 * what comes back cannot be trusted to be a reasonable size or to stop
 * redirecting. Tested against a real loopback server rather than a mocked
 * global fetch — the limits live in how the response body is consumed, and
 * a mock would be asserting the mock.
 */

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function serve(
  handler: http.RequestListener,
): Promise<{ url: string; port: number }> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port };
}

describe("nodeHttpFetcher resource limits (S-06)", () => {
  it("fetches an ordinary response unchanged", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("PDF-Bytes");
    });
    const result = await localFetcher.fetch(url);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/pdf");
    expect(result.body.toString()).toBe("PDF-Bytes");
  });

  it("refuses a response whose declared Content-Length is over the cap", async () => {
    // Refused before a single byte is read: the server here never actually
    // sends the gigabyte it claims.
    const { url } = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(1024 * 1024 * 1024),
      });
      response.end("kurz");
    });
    await expect(localFetcher.fetch(url)).rejects.toBeInstanceOf(
      ResourceLimitExceededError,
    );
    await expect(localFetcher.fetch(url)).rejects.toThrow(/Größengrenze/);
  });

  it("stops a body that keeps growing past the cap without declaring a length", async () => {
    // The case Content-Length cannot catch: chunked, or simply lying. The
    // stream is measured as it arrives and cancelled when it goes over.
    let stopped = false;
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/pdf" });
      const pump = () => {
        if (stopped || response.writableEnded) {
          return;
        }
        if (response.write(chunk)) {
          setImmediate(pump);
        } else {
          response.once("drain", pump);
        }
      };
      response.on("close", () => {
        stopped = true;
      });
      pump();
    });
    await expect(localFetcher.fetch(url)).rejects.toBeInstanceOf(
      ResourceLimitExceededError,
    );
    stopped = true;
  }, 60_000);

  it("follows redirects but refuses an unbounded chain", async () => {
    const { url } = await serve((request, response) => {
      const hop =
        Number(new URL(request.url ?? "/", "http://x").pathname.slice(1)) || 0;
      response.writeHead(302, { location: `/${hop + 1}` });
      response.end();
    });
    await expect(localFetcher.fetch(`${url}/0`)).rejects.toThrow(
      new RegExp(`mehr als ${MAX_REDIRECTS} Weiterleitungen`),
    );
  });

  it("follows a redirect chain that terminates, including a relative Location", async () => {
    const { url } = await serve((request, response) => {
      if (request.url === "/start") {
        // Relative Location headers are legal and common.
        response.writeHead(302, { location: "/ziel" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("angekommen");
    });
    const result = await localFetcher.fetch(`${url}/start`);
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe("angekommen");
  });

  it("applies the timeout across the whole redirect chain, not per hop", async () => {
    // Each hop is fast, but the chain never ends; without one signal for
    // the whole call a slow chain could outlast the budget indefinitely.
    const { url } = await serve((_request, response) => {
      setTimeout(() => {
        response.writeHead(302, { location: "/weiter" });
        response.end();
      }, 40);
    });
    await expect(
      localFetcher.fetch(`${url}/start`, { timeoutMs: 150 }),
    ).rejects.toThrow();
  });

  it("does not accumulate connections across a long redirect chain", async () => {
    // With redirect: "manual" the intermediate bodies are never read. They
    // are cancelled instead, so a chain of large redirect responses neither
    // pulls their bytes nor holds their sockets open — bytes that no size
    // cap would ever see.
    const chunk = "x".repeat(50_000);
    const { url } = await serve((request, response) => {
      const hop = Number((request.url ?? "/0").slice(1)) || 0;
      if (hop < 9) {
        response.writeHead(302, { location: `/${hop + 1}` });
        response.end(chunk);
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ziel");
    });
    for (let i = 0; i < 15; i += 1) {
      const result = await localFetcher.fetch(`${url}/0`);
      expect(result.body.toString()).toBe("ziel");
    }
  }, 30_000);

  it("still parses Retry-After for the rate-limit path", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(429, { "retry-after": "2" });
      response.end();
    });
    const result = await localFetcher.fetch(url);
    expect(result.status).toBe(429);
    expect(result.retryAfterMs).toBe(2000);
  });
});

describe("nodeHttpFetcher SSRF guard (S-06)", () => {
  it("refuses a loopback address before opening a connection", async () => {
    // The production fetcher, with the real address guard: a literal
    // loopback IP is classified without DNS and never dialled. Port 1 would
    // refuse the connection anyway — the point is it fails with the address
    // error, not a connection error.
    await expect(
      nodeHttpFetcher.fetch("http://127.0.0.1:1/secret"),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("re-checks the address on every redirect hop", async () => {
    // The guard is consulted for the target of each redirect, not only the
    // initial URL — a redirect to a private address is caught on its hop.
    const checked: string[] = [];
    const fetcher = createNodeHttpFetcher({
      checkUrl: async (url) => {
        checked.push(url);
      },
    });
    const { url } = await serve((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/ziel" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ziel");
    });
    await fetcher.fetch(`${url}/start`);
    expect(checked).toEqual([`${url}/start`, `${url}/ziel`]);
  });
});

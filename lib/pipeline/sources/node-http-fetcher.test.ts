import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ResourceLimitExceededError } from "../errors";
import { MAX_REDIRECTS, nodeHttpFetcher } from "./node-http-fetcher";

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
    const result = await nodeHttpFetcher.fetch(url);
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
    await expect(nodeHttpFetcher.fetch(url)).rejects.toBeInstanceOf(
      ResourceLimitExceededError,
    );
    await expect(nodeHttpFetcher.fetch(url)).rejects.toThrow(/Größengrenze/);
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
    await expect(nodeHttpFetcher.fetch(url)).rejects.toBeInstanceOf(
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
    await expect(nodeHttpFetcher.fetch(`${url}/0`)).rejects.toThrow(
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
    const result = await nodeHttpFetcher.fetch(`${url}/start`);
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
      nodeHttpFetcher.fetch(`${url}/start`, { timeoutMs: 150 }),
    ).rejects.toThrow();
  });

  it("still parses Retry-After for the rate-limit path", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(429, { "retry-after": "2" });
      response.end();
    });
    const result = await nodeHttpFetcher.fetch(url);
    expect(result.status).toBe(429);
    expect(result.retryAfterMs).toBe(2000);
  });
});

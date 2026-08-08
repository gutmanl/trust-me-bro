import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { nodeFetchHttpPort } from "./node-fetch-http-port";

let server: http.Server | undefined;

function listen(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1/messages`,
        close: () =>
          new Promise((done) => {
            server!.close(() => done());
            server!.closeAllConnections();
          }),
      });
    });
  });
}

afterEach(async () => {
  await new Promise<void>((done) => {
    if (!server) {
      done();
      return;
    }
    server.closeAllConnections();
    server.close(() => done());
    server = undefined;
  });
});

describe("nodeFetchHttpPort", () => {
  it("POSTs headers and body and captures status and response body", async () => {
    let seen: { method?: string; header?: string; body?: string } = {};
    const { url } = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        seen = {
          method: request.method,
          header: request.headers["x-api-key"] as string,
          body,
        };
        response.writeHead(429, { "content-type": "application/json" });
        response.end('{"type":"error"}');
      });
    });

    const result = await nodeFetchHttpPort.request({
      url,
      headers: { "x-api-key": "sk-test" },
      body: '{"hello":true}',
      timeoutMs: 5_000,
    });

    expect(seen).toEqual({
      method: "POST",
      header: "sk-test",
      body: '{"hello":true}',
    });
    expect(result.status).toBe(429);
    expect(result.body).toBe('{"type":"error"}');
    expect(result.timedOut).toBe(false);
  });

  it("resolves with timedOut when the server never answers", async () => {
    const { url } = await listen(() => {
      // Never respond; the abort controller must fire.
    });
    const result = await nodeFetchHttpPort.request({
      url,
      headers: {},
      body: "{}",
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
  });

  it("resolves instead of throwing when the connection is refused", async () => {
    const { url, close } = await listen((_request, response) => response.end());
    await close();
    server = undefined;

    const result = await nodeFetchHttpPort.request({
      url,
      headers: {},
      body: "{}",
      timeoutMs: 2_000,
    });
    expect(result.status).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.body).toContain("request failed");
  });
});

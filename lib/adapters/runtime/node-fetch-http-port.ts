import type {
  HttpPort,
  HttpRequestOptions,
  HttpResponseResult,
} from "../core/contracts";

/**
 * The one place in the adapter layer that performs HTTP requests (TMB-51),
 * mirroring node-process-runner's contract: the port never rejects — a
 * timeout resolves with timedOut, a network failure resolves with a null
 * status and the error message as body. The architecture guard allowlists
 * exactly this file for bare fetch within lib/adapters.
 */
export const nodeFetchHttpPort: HttpPort = { request: runHttpRequest };

async function runHttpRequest(
  options: HttpRequestOptions,
): Promise<HttpResponseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: { ...options.headers },
      body: options.body,
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body, timedOut: false };
  } catch (error) {
    if (controller.signal.aborted) {
      return { status: null, body: "", timedOut: true };
    }
    return {
      status: null,
      body: `request failed: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

import { describe, expect, it } from "vitest";

import type { Orchestrator } from "../../../adapters";
import { deriveCitationMeta } from "./derive-candidate";

const RAW = "Meyer, A. (2025). Effects of AI Assistants | IEEE TSE";

function deps(orchestrator: Orchestrator, backendUsable = true) {
  return {
    orchestrator,
    backendId: "claude",
    backendUsable,
    timeoutMs: 1000,
    projectDir: "/tmp/nowhere",
  };
}

const okParse = (references: unknown[]) =>
  ({
    run: async () => ({ status: "ok", output: { references } }),
  }) as unknown as Orchestrator;

describe("deriveCitationMeta", () => {
  it("uses the single LLM-parsed reference, omitting absent fields", async () => {
    const meta = await deriveCitationMeta(
      RAW,
      deps(okParse([{ raw_text: RAW, authors: ["Anna Meyer"] }])),
    );
    expect(meta).toEqual({ authors: ["Anna Meyer"] });
  });

  it("falls back to the cleaned title when the backend is unusable", async () => {
    const meta = await deriveCitationMeta(
      RAW,
      deps(okParse([]), /* backendUsable */ false),
    );
    expect(meta.title).toBe("Meyer, A. (2025). Effects of AI Assistants");
    expect(meta.authors).toEqual([]);
  });

  it("falls back on an ambiguous parse (zero or several references)", async () => {
    expect((await deriveCitationMeta(RAW, deps(okParse([])))).title).toContain(
      "Effects of AI Assistants",
    );
    expect(
      (
        await deriveCitationMeta(
          RAW,
          deps(
            okParse([
              { raw_text: "a", authors: [] },
              { raw_text: "b", authors: [] },
            ]),
          ),
        )
      ).title,
    ).toContain("Effects of AI Assistants");
  });

  it("falls back on a paused/exhausted/throwing adapter", async () => {
    const paused = {
      run: async () => ({ status: "paused", reason: "Rate-Limit" }),
    } as unknown as Orchestrator;
    expect((await deriveCitationMeta(RAW, deps(paused))).authors).toEqual([]);
    const throwing = {
      run: async () => {
        throw new Error("Adapter kaputt.");
      },
    } as unknown as Orchestrator;
    expect((await deriveCitationMeta(RAW, deps(throwing))).authors).toEqual([]);
  });

  it("carries title and year through when the parse has them", async () => {
    const meta = await deriveCitationMeta(
      RAW,
      deps(
        okParse([
          { raw_text: RAW, title: "Effects", authors: ["Meyer"], year: 2025 },
        ]),
      ),
    );
    expect(meta).toEqual({ title: "Effects", authors: ["Meyer"], year: 2025 });
  });
});

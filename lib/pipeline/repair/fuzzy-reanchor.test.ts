import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import { importBriefing } from "../briefing";
import { createProject } from "../projects";
import { runFuzzyReanchorSweep } from "./fuzzy-reanchor";

const PROJECT = "proj_fuzzy-reanchor";
const BRIEFING = [
  "Einleitung ohne besonderen Bezug zu irgendetwas.",
  "Die mediane Review-Zeit sank von 42 auf 19 Minuten (n = 120).",
  "Fazit: die Ergebnisse tragen.",
].join("\n\n");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-fuzzy-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Werden Anker automatisch repariert?",
    primaryCli: "claude",
  });
  await importBriefing({ projectId: PROJECT, content: BRIEFING, tool: "test" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function addClaim(
  id: string,
  anchorQuote: string,
  anchor = "p0",
): Promise<void> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.addClaim({
      claim: {
        id,
        text: `Die Reviewzeit sank messbar (${id}).`,
        claim_type: "quantitative_finding",
        briefing_anchor: anchor,
        anchor_quote: anchorQuote,
        provenance: {
          tool: "test",
          model: "test",
          extracted_at: new Date().toISOString(),
          search_path: "Test",
        },
        evidence: [],
      },
      actor: "system:extraction",
      reason: "Testclaim erzeugt.",
    });
  });
}

describe("runFuzzyReanchorSweep", () => {
  it("re-anchors a near-verbatim quote as an audited system event", async () => {
    // Lightly reworded vs the briefing's "Die mediane Review-Zeit sank von
    // 42 auf 19 Minuten (n = 120)". "mittlere" is what makes it inexact:
    // the normal form is hyphen-insensitive, so a quote differing only in
    // "Reviewzeit" vs "Review-Zeit" resolves exactly and never reaches the
    // fuzzy sweep at all.
    await addClaim(
      "clm_0001",
      "die mittlere Reviewzeit sank von 42 auf 19 Minuten",
    );
    const summary = await runFuzzyReanchorSweep(PROJECT);
    expect(summary).toEqual({ repaired: 1, stillUnresolved: 0 });

    const register = await RegisterStore.forProject(PROJECT).read();
    const claim = register.claims.find((entry) => entry.id === "clm_0001");
    expect(claim?.briefing_anchor).toBe("p2");
    const event = register.project_events.find(
      (entry) => entry.event === "claim_anchor_revised",
    );
    expect(event?.actor).toBe("system:anchor_repair");
    expect(event?.reason).toContain("Näherungs-Neuverankerung");
  });

  it("leaves verbatim-resolvable and hopeless quotes alone", async () => {
    // Verbatim in p3 — the view resolves it quote-first, nothing to do.
    await addClaim("clm_0002", "die Ergebnisse tragen");
    // Nowhere near any paragraph — stays for the human.
    await addClaim("clm_0003", "Yaks tragen schwere Lasten im Hochgebirge");
    const summary = await runFuzzyReanchorSweep(PROJECT);
    expect(summary).toEqual({ repaired: 0, stillUnresolved: 1 });
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.claims.find((entry) => entry.id === "clm_0002")?.briefing_anchor,
    ).toBe("p0");
    expect(
      register.claims.find((entry) => entry.id === "clm_0003")?.briefing_anchor,
    ).toBe("p0");
  });

  it("is a no-op without a briefing", async () => {
    const bare = "proj_fuzzy-ohne-briefing";
    await createProject({
      id: bare,
      research_question: "Ohne Briefing?",
      primaryCli: "claude",
    });
    expect(await runFuzzyReanchorSweep(bare)).toEqual({
      repaired: 0,
      stillUnresolved: 0,
    });
  });
});

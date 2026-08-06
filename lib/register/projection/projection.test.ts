import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegisterStore } from "../persistence/store";
import type { ClaimsRegister } from "../schema/register";
import exampleProject from "../schema/__fixtures__/example-project.json";
import { renderBriefing } from "./render-briefing";

const BRIEFING = [
  "LLM-gestützte Code-Reviews verändern den Reviewprozess grundlegend.",
  "Studien zeigen, dass die mediane Reviewzeit um etwa 55 % sinkt.",
  "Langfristige Effekte sind noch nicht ausreichend untersucht.",
].join("\n\n");

function baseRegister(): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  register.claims[0].briefing_anchor = "p2";
  return register;
}

describe("renderBriefing determinism", () => {
  it("renders byte-identically for identical inputs", () => {
    expect(renderBriefing(BRIEFING, baseRegister())).toBe(
      renderBriefing(BRIEFING, baseRegister()),
    );
  });

  it("is independent of claims array order", () => {
    const register = baseRegister();
    const second = structuredClone(register.claims[0]);
    second.id = "clm_0002";
    second.briefing_anchor = "p1";
    second.evidence = second.evidence.map((evidence) => ({
      ...evidence,
      id: "ev_0002",
    }));
    register.claims.push(second);

    const shuffled = structuredClone(register);
    shuffled.claims.reverse();

    expect(renderBriefing(BRIEFING, register)).toBe(
      renderBriefing(BRIEFING, shuffled),
    );
  });

  it("normalizes CRLF input and never emits carriage returns", () => {
    const crlf = BRIEFING.replaceAll("\n", "\r\n");
    const output = renderBriefing(crlf, baseRegister());
    expect(output).not.toContain("\r");
    expect(output).toBe(renderBriefing(BRIEFING, baseRegister()));
  });

  it("matches the committed golden file", async () => {
    await expect(renderBriefing(BRIEFING, baseRegister())).toMatchFileSnapshot(
      "./__fixtures__/briefing-golden.md",
    );
  });
});

describe("status annotations", () => {
  it("marks the confirmation path of adjudicated vs automatic claims", () => {
    const adjudicated = renderBriefing(BRIEFING, baseRegister());
    expect(adjudicated).toContain("bestätigt (adjudiziert)");

    const automatic = baseRegister();
    automatic.claims[0].status = "automatisch_bestaetigt";
    expect(renderBriefing(BRIEFING, automatic)).toContain(
      "automatisch bestätigt (stichprobenweise nachprüfbar)",
    );
  });

  it("visibly flags claims that are not confirmed", () => {
    const register = baseRegister();
    register.claims[0].status = "beanstandet";
    const output = renderBriefing(BRIEFING, register);
    expect(output).toContain("⚠");
    expect(output).toContain("NICHT BESTÄTIGT – Status: beanstandet");
  });

  it("reports the briefing as verified only without open adjudications", () => {
    const open = baseRegister();
    open.claims[0].status = "zur_adjudikation";
    expect(renderBriefing(BRIEFING, open)).toContain(
      "IN PRÜFUNG – 1 Claim(s) zur Adjudikation offen",
    );
    expect(renderBriefing(BRIEFING, baseRegister())).toContain(
      "GEPRÜFT – kein Claim zur Adjudikation offen",
    );
  });
});

describe("anchors and evidence numbering", () => {
  it("places claim annotations at their anchor paragraph", () => {
    const output = renderBriefing(BRIEFING, baseRegister());
    const paragraphPos = output.indexOf("mediane Reviewzeit um etwa 55");
    const annotationPos = output.indexOf("**clm_0001**");
    expect(paragraphPos).toBeGreaterThan(-1);
    expect(annotationPos).toBeGreaterThan(paragraphPos);
  });

  it("lists claims with unresolvable anchors instead of dropping them", () => {
    const register = baseRegister();
    register.claims[0].briefing_anchor = "p99";
    const output = renderBriefing(BRIEFING, register);
    expect(output).toContain("Nicht zuordenbare Claims");
    expect(output).toContain("Anker: p99");
  });

  it("numbers inline evidence and cross-references the Belege section", () => {
    const output = renderBriefing(BRIEFING, baseRegister());
    expect(output).toContain("Belege [1]");
    expect(output).toContain("1. src_meyer2025, S. 6, Abschn. 4.2 · stuetzt");
  });
});

describe("RegisterStore.renderBriefingFile", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-projection-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("regenerates briefing.md from blob and register", async () => {
    const store = RegisterStore.atDirectory(projectDir);
    await store.create({
      id: "proj_projection-test",
      research_question: "Wird die Projektion regeneriert?",
      config: {
        rubric_version: "se-evidenz-rubrik-v1",
        adjudication_sample_rate: 0.1,
        backends: { primary: { cli: "claude", model_family: "anthropic" } },
      },
      actor: "human:lg",
      at: "2026-08-06T08:00:00Z",
    });
    const blob = store.blobs().put(BRIEFING, "md");
    // Attach the briefing import via a raw file edit is not possible through
    // the capability surface (import flow is a later epic), so write the
    // project field through a fresh create-like path: read, patch, re-write
    // via the transaction-free test seam — here we simply re-create the file
    // with the briefing_import set, keeping the chain intact.
    const register = await store.read();
    register.project.briefing_import = {
      imported_at: "2026-08-06T08:01:00Z",
      sha256: blob.sha256,
      blob_path: blob.blobPath,
      tool: "deep-research-x",
    };
    fs.writeFileSync(
      store.claimsPath,
      `${JSON.stringify(register, null, 2)}\n`,
    );

    const first = await store.renderBriefingFile();
    const briefingPath = path.join(projectDir, "briefing.md");
    expect(fs.readFileSync(briefingPath, "utf8")).toBe(first);

    fs.rmSync(briefingPath);
    const second = await store.renderBriefingFile();
    expect(second).toBe(first);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../register";
import { getBriefing, importBriefing } from "./briefing";
import {
  discardBriefingDraft,
  getBriefingDraft,
  publishBriefingRevision,
  saveBriefingDraft,
} from "./briefing-revision";
import {
  BriefingRevisionPreconditionError,
  InvalidBriefingInputError,
  RunActiveError,
} from "./errors";
import { createProject } from "./projects";
import { getGlobalJobRunner } from "./runs/job-runner";
import { exportProjectBundle } from "./export/build-export";
import { unzipBundle } from "../export";

const PROJECT = "proj_briefing_revision";

const V1 = [
  "Para eins: LLM-gestützte Code-Reviews verändern den Prozess.",
  "Para zwei: Die mediane Reviewzeit sinkt um 55 %.",
].join("\n\n");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-briefing-rev-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("briefing draft round trip", () => {
  it("saves, reads and clears a draft, atomically stored under the project dir", async () => {
    expect(await getBriefingDraft(PROJECT)).toBeNull();

    const saved = await saveBriefingDraft(PROJECT, "Entwurfstext.");
    expect(saved.text).toBe("Entwurfstext.");
    expect(saved.based_on_revision).toBe(0); // no briefing yet
    expect(typeof saved.saved_at).toBe("string");

    const store = RegisterStore.forProject(PROJECT);
    const draftPath = path.join(store.projectDir, "briefing.draft.json");
    expect(fs.existsSync(draftPath)).toBe(true);

    const read = await getBriefingDraft(PROJECT);
    expect(read).toEqual(saved);

    // Overwriting replaces, not appends.
    const resaved = await saveBriefingDraft(PROJECT, "Neuer Entwurfstext.");
    expect((await getBriefingDraft(PROJECT))?.text).toBe("Neuer Entwurfstext.");
    expect(resaved.text).toBe("Neuer Entwurfstext.");

    await discardBriefingDraft(PROJECT);
    expect(fs.existsSync(draftPath)).toBe(false);
    expect(await getBriefingDraft(PROJECT)).toBeNull();

    // Discarding again is a harmless no-op.
    await expect(discardBriefingDraft(PROJECT)).resolves.toBeUndefined();
  });

  it("treats a corrupt draft file as no draft (never crashes)", async () => {
    await saveBriefingDraft(PROJECT, "Entwurfstext.");
    const store = RegisterStore.forProject(PROJECT);
    const draftPath = path.join(store.projectDir, "briefing.draft.json");
    fs.writeFileSync(draftPath, "{ this is not valid json");

    expect(await getBriefingDraft(PROJECT)).toBeNull();
  });

  it("based_on_revision reflects the current briefing revision once one exists", async () => {
    await importBriefing({ projectId: PROJECT, content: V1, tool: "you.com" });
    const saved = await saveBriefingDraft(PROJECT, "Entwurf nach Import.");
    expect(saved.based_on_revision).toBe(1);
  });

  it("does not appear in the export bundle's file list", async () => {
    await importBriefing({ projectId: PROJECT, content: V1, tool: "you.com" });
    await saveBriefingDraft(PROJECT, "Nicht veröffentlichter Entwurf.");
    const { bytes } = await exportProjectBundle(PROJECT, {
      includeBlobs: true,
    });
    const files = unzipBundle(bytes);
    expect(Object.keys(files)).not.toContain("briefing.draft.json");
  });
});

describe("publishBriefingRevision — no prior briefing (initial import)", () => {
  it("delegates to importBriefing, using the draft's text when text is omitted", async () => {
    await saveBriefingDraft(PROJECT, V1);
    const result = await publishBriefingRevision(PROJECT, {
      tool: "you.com Research",
    });
    expect(result.tool).toBe("you.com Research");
    expect(result.revision).toBeUndefined();

    const briefing = await getBriefing(PROJECT);
    expect(briefing?.text).toBe(V1);

    // The draft is cleared once its text became the import.
    expect(await getBriefingDraft(PROJECT)).toBeNull();
  });

  it("accepts explicit text overriding an unrelated draft", async () => {
    await saveBriefingDraft(PROJECT, "Anderer Entwurf.");
    const result = await publishBriefingRevision(PROJECT, {
      text: V1,
      tool: "deep-research-x",
    });
    expect((await getBriefing(PROJECT))?.text).toBe(V1);
    expect(result.tool).toBe("deep-research-x");
  });

  it("requires a tool name and rejects when missing", async () => {
    await expect(
      publishBriefingRevision(PROJECT, { text: V1 }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);
    await expect(
      publishBriefingRevision(PROJECT, { text: V1, tool: "  " }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);
  });

  it("rejects empty text (no draft, no explicit text)", async () => {
    await expect(
      publishBriefingRevision(PROJECT, { tool: "x" }),
    ).rejects.toBeInstanceOf(BriefingRevisionPreconditionError);
    await expect(
      publishBriefingRevision(PROJECT, { text: "   ", tool: "x" }),
    ).rejects.toBeInstanceOf(BriefingRevisionPreconditionError);
  });
});

describe("publishBriefingRevision — revision of an existing briefing", () => {
  async function addQuotedClaim(
    anchor: string,
    quote: string,
  ): Promise<string> {
    const claimId = `clm_${anchor}`;
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.addClaim({
        claim: {
          id: claimId,
          text: "Die mediane Reviewzeit sinkt um 55 %.",
          claim_type: "quantitative_finding",
          briefing_anchor: anchor,
          anchor_quote: quote,
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
    return claimId;
  }

  it("rotates the briefing, re-anchors a moved claim silently, and keeps the chain valid", async () => {
    await importBriefing({ projectId: PROJECT, content: V1, tool: "you.com" });
    const claimId = await addQuotedClaim(
      "p2",
      "Die mediane Reviewzeit sinkt um 55 %.",
    );

    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();
    const oldSha = before.project.briefing_import?.sha256;

    const V2 = [
      "Para eins: LLM-gestützte Code-Reviews verändern den Prozess.",
      "Neuer Absatz dazwischen, vorher gab es den nicht.",
      "Para zwei: Die mediane Reviewzeit sinkt um 55 %.",
    ].join("\n\n");

    const result = await publishBriefingRevision(PROJECT, { text: V2 });

    expect(result.tool).toBe("you.com"); // kept verbatim from the prior import
    expect(result.revision).toBe(2);
    expect(result.sha256).not.toBe(oldSha);

    const after = await store.read();
    expect(after.project.previous_briefings).toHaveLength(1);
    expect(after.project.previous_briefings?.[0].sha256).toBe(oldSha);
    expect(
      store.blobs().readText(after.project.briefing_import!.blob_path),
    ).toBe(V2);

    // Silent re-anchor: the claim moved from p2 to p3 with no event.
    const claim = after.claims.find((candidate) => candidate.id === claimId);
    expect(claim?.briefing_anchor).toBe("p3");
    expect(claim?.anchor_quote).toBe("Die mediane Reviewzeit sinkt um 55 %.");

    const events = after.project_events.map((event) => event.event);
    expect(events).toEqual([
      "project_created",
      "briefing_imported",
      "briefing_revised",
    ]);
    expect(events).not.toContain("claim_anchor_revised");

    // briefing.md was re-rendered against the new text.
    expect(fs.existsSync(path.join(store.projectDir, "briefing.md"))).toBe(
      true,
    );

    expect((await store.verify()).ok).toBe(true);
  });

  it("leaves a claim's stale anchor untouched when its quote is gone entirely", async () => {
    await importBriefing({ projectId: PROJECT, content: V1, tool: "you.com" });
    const claimId = await addQuotedClaim(
      "p2",
      "Ein Satz, der gleich verschwindet.",
    );

    await publishBriefingRevision(PROJECT, {
      text: [
        "Para eins: LLM-gestützte Code-Reviews verändern den Prozess.",
        "Komplett neuer zweiter Absatz ohne den alten Satz.",
      ].join("\n\n"),
    });

    const after = await RegisterStore.forProject(PROJECT).read();
    const claim = after.claims.find((candidate) => candidate.id === claimId);
    expect(claim?.briefing_anchor).toBe("p2"); // unchanged/stale
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });

  it("is a checksum no-op for identical text and still clears the draft", async () => {
    await importBriefing({ projectId: PROJECT, content: V1, tool: "you.com" });
    await saveBriefingDraft(PROJECT, V1);
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();

    const result = await publishBriefingRevision(PROJECT, { text: V1 });

    expect(result).toEqual(before.project.briefing_import);
    const after = await store.read();
    expect(after).toEqual(before);
    expect(after.project_events.map((event) => event.event)).toEqual([
      "project_created",
      "briefing_imported",
    ]);
    expect(await getBriefingDraft(PROJECT)).toBeNull();
  });

  it("refuses to publish while a run is active for the project", async () => {
    await importBriefing({ projectId: PROJECT, content: V1, tool: "you.com" });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = getGlobalJobRunner().submit(
      PROJECT,
      [0],
      () => "item",
      () => blocked.then(() => "done"),
    );
    try {
      await expect(
        publishBriefingRevision(PROJECT, { text: "Anderer Text." }),
      ).rejects.toBeInstanceOf(RunActiveError);
    } finally {
      release();
      await handle.done;
    }
    // Once the run ends, publishing succeeds.
    await expect(
      publishBriefingRevision(PROJECT, { text: "Anderer Text." }),
    ).resolves.toBeDefined();
  });
});

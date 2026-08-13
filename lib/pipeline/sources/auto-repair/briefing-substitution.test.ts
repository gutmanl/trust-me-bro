import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../../register";
import { importBriefing } from "../../briefing";
import { createProject } from "../../projects";
import {
  runBriefingSubstitution,
  substituteIdentifierOccurrences,
} from "./briefing-substitution";

const OLD_ITEM = {
  id: "src_falsch",
  type: "article-journal",
  title: "Falsches Paper",
  DOI: "10.9999/halluziniert.123",
  URL: "https://doi.org/10.9999/halluziniert.123",
};
const NEW_ITEM = {
  id: "src_falsch",
  type: "article-journal",
  title: "Effects of AI Assistants on Code Review Duration",
  author: [{ family: "Meyer", given: "A." }],
  issued: { "date-parts": [[2025]] },
  "container-title": "IEEE TSE",
  DOI: "10.1109/TSE.2025.3489012",
};

describe("substituteIdentifierOccurrences", () => {
  it("replaces inline DOI/URL strings and the footnote bibliography", () => {
    const text = [
      "Die Reviewzeit sank deutlich (doi:10.9999/halluziniert.123).[^1]",
      "",
      "Weitere Absätze bleiben unberührt.",
      "",
      "[^1]: Falsches Paper. https://doi.org/10.9999/halluziniert.123",
    ].join("\n");
    const result = substituteIdentifierOccurrences(text, OLD_ITEM, NEW_ITEM);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("10.9999/halluziniert.123");
    expect(result.text).toContain("10.1109/TSE.2025.3489012");
    // The footnote line was rebuilt from the corrected core.
    expect(result.text).toContain("[^1]: Meyer (2025), IEEE TSE");
    expect(result.text).toContain("Weitere Absätze bleiben unberührt.");
  });

  it("changes nothing when the old identifier does not occur", () => {
    const text = "Ein Briefing ohne die alte Kennung.";
    const result = substituteIdentifierOccurrences(text, OLD_ITEM, NEW_ITEM);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(text);
  });

  it("changes nothing when the corrected core has no identifier to offer", () => {
    const result = substituteIdentifierOccurrences(
      "Siehe https://doi.org/10.9999/halluziniert.123.",
      OLD_ITEM,
      { id: "src_falsch", type: "document", title: "Nur ein Upload" },
    );
    expect(result.changed).toBe(false);
  });

  it("replaces a plain URL with the corrected DOI link when no new URL exists", () => {
    const result = substituteIdentifierOccurrences(
      "Siehe https://alt.example.org/bericht.",
      {
        id: "src_falsch",
        type: "webpage",
        title: "Alt",
        URL: "https://alt.example.org/bericht",
      },
      NEW_ITEM,
    );
    expect(result.changed).toBe(true);
    expect(result.text).toBe("Siehe https://doi.org/10.1109/TSE.2025.3489012.");
  });

  it("keeps a doi.org URL intact when the corrected identity has no DOI", () => {
    // Regression: the bare DOI is a substring of its doi.org URL form. A
    // correction to a DOI-less identity replaces the DOI with a full URL —
    // applied shortest-first that would nest one URL inside the other.
    const result = substituteIdentifierOccurrences(
      "Siehe https://doi.org/10.9999/halluziniert.123 " +
        "(doi:10.9999/halluziniert.123).",
      OLD_ITEM,
      {
        id: "src_falsch",
        type: "article",
        title: "Neu",
        URL: "https://arxiv.org/abs/2402.99999",
      },
    );
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("https://doi.org/https://");
    expect(result.text).not.toContain("10.9999/halluziniert.123");
    expect(result.text).toContain("https://arxiv.org/abs/2402.99999");
  });

  it("replaces an arXiv id when both identities carry one", () => {
    const result = substituteIdentifierOccurrences(
      "Siehe arXiv 2401.12345 (https://arxiv.org/abs/2401.12345).",
      {
        id: "src_falsch",
        type: "article",
        title: "Alt",
        URL: "https://arxiv.org/abs/2401.12345",
      },
      {
        id: "src_falsch",
        type: "article",
        title: "Neu",
        URL: "https://arxiv.org/abs/2402.99999",
      },
    );
    expect(result.changed).toBe(true);
    expect(result.text).toContain("https://arxiv.org/abs/2402.99999");
    expect(result.text).not.toContain("2401.12345");
  });
});

describe("runBriefingSubstitution", () => {
  const PROJECT = "proj_briefing-substitution";
  let workspace: string;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-subst-"));
    vi.stubEnv("TMB_WORKSPACE", workspace);
    vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
    await createProject({
      id: PROJECT,
      research_question: "Wird das Briefing nachgezogen?",
      primaryCli: "claude",
    });
    await importBriefing({
      projectId: PROJECT,
      content:
        "Die Reviewzeit sank (https://doi.org/10.9999/halluziniert.123).",
      tool: "test",
    });
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.recordIdentityCorrection({
        source_id: "src_falsch",
        previous_item: OLD_ITEM,
        new_item: NEW_ITEM,
        snapshot_revision: { from: 1, to: 2 },
        recheck_claim_ids: [],
        actor: "system:source_correction",
        reason: "Quellenkennung korrigiert (Test).",
      });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("publishes the substituted text as an audited system revision", async () => {
    const result = await runBriefingSubstitution(PROJECT, "src_falsch");
    expect(result.published).toBe(true);
    const store = RegisterStore.forProject(PROJECT);
    const register = await store.read();
    const briefing = register.project.briefing_import;
    expect(briefing?.revision).toBe(2);
    const text = store.blobs().readText(briefing?.blob_path as string);
    expect(text).toContain("10.1109/TSE.2025.3489012");
    expect(text).not.toContain("10.9999/halluziniert.123");
    const event = register.project_events.find(
      (candidate) => candidate.event === "briefing_revised",
    );
    expect(event?.actor).toBe("system:auto_repair");
    expect(event?.reason).toContain("Mechanische Textanpassung");
  });

  it("skips while an unpublished draft exists", async () => {
    const store = RegisterStore.forProject(PROJECT);
    store.saveDraft("Ein halb fertiger Entwurf.", 1);
    const result = await runBriefingSubstitution(PROJECT, "src_falsch");
    expect(result.published).toBe(false);
    expect(
      (await store.read()).project.briefing_import?.revision,
    ).toBeUndefined();
    // The draft survives untouched.
    expect(store.readDraft()?.text).toBe("Ein halb fertiger Entwurf.");
  });

  it("does nothing for a source without a correction event", async () => {
    expect(await runBriefingSubstitution(PROJECT, "src_unbekannt")).toEqual({
      published: false,
    });
  });

  it("is a no-op for a project without a briefing", async () => {
    const bare = "proj_subst-ohne-briefing";
    await createProject({
      id: bare,
      research_question: "Ohne Briefing?",
      primaryCli: "claude",
    });
    expect(await runBriefingSubstitution(bare, "src_falsch")).toEqual({
      published: false,
    });
  });

  it("publishes nothing when the corrected identity leaves the text unchanged", async () => {
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.recordIdentityCorrection({
        source_id: "src_anders",
        previous_item: { title: "Nie zitiert", DOI: "10.5555/nie" },
        new_item: NEW_ITEM,
        snapshot_revision: { from: 1, to: 2 },
        recheck_claim_ids: [],
        actor: "system:source_correction",
        reason: "Quellenkennung korrigiert (Test).",
      });
    });
    expect(await runBriefingSubstitution(PROJECT, "src_anders")).toEqual({
      published: false,
    });
  });
});

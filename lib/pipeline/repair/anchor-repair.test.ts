import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import { decideClaim } from "../adjudication/decide";
import { importBriefing } from "../briefing";
import {
  discardBriefingDraft,
  getBriefingDraft,
  saveBriefingDraft,
} from "../briefing-revision";
import { AnchorPreconditionError } from "../errors";
import { createProject } from "../projects";
import { repairBriefingPassage, repairClaimAnchor } from "./anchor-repair";

const PROJECT = "proj_anchor_repair";

const P1 = "Absatz eins: LLM-gestützte Code-Reviews verändern den Prozess.";
const P2 = "Absatz zwei: Die mediane Reviewzeit sinkt um 55 %.";
const P3 = "Absatz drei: Die Fehlerrate bleibt unverändert.";
const BRIEFING = [P1, P2, P3].join("\n\n");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-anchor-repair-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  await importBriefing({
    projectId: PROJECT,
    content: BRIEFING,
    tool: "you.com",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** A claim with an explicit anchor/quote pair. Evidence-less by design, so
 * the creation gate lands it in `pending_adjudication` — the tests below
 * move individual claims on from there where a different status matters. */
async function addClaim(options: {
  id: string;
  anchor: string;
  quote?: string;
  text?: string;
}): Promise<string> {
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.addClaim({
      claim: {
        id: options.id,
        text: options.text ?? "Die mediane Reviewzeit sinkt um 55 %.",
        claim_type: "quantitative_finding",
        briefing_anchor: options.anchor,
        ...(options.quote !== undefined ? { anchor_quote: options.quote } : {}),
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
  return options.id;
}

describe("repairClaimAnchor", () => {
  it("re-points a drifted claim, records the audited event and keeps the chain valid", async () => {
    const claimId = await addClaim({
      id: "clm_drifted",
      anchor: "p1",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });

    await repairClaimAnchor(PROJECT, claimId, {
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });

    const store = RegisterStore.forProject(PROJECT);
    const after = await store.read();
    const claim = after.claims.find((candidate) => candidate.id === claimId);
    expect(claim?.briefing_anchor).toBe("p2");
    expect(claim?.anchor_quote).toBe("Die mediane Reviewzeit sinkt um 55 %.");
    // An anchor correction is not a verification outcome: the status and the
    // claim's own history are untouched.
    expect(claim?.status).toBe("pending_adjudication");
    expect(claim?.history).toHaveLength(1);

    const event = after.project_events.at(-1);
    expect(event?.event).toBe("claim_anchor_revised");
    expect(event?.anchor_change).toEqual({
      claim_id: claimId,
      previous_anchor: "p1",
      new_anchor: "p2",
      previous_quote: "Die mediane Reviewzeit sinkt um 55 %.",
      new_quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    expect(event?.actor).toContain("lg");
    expect(event?.reason).toContain("Arbeitsbereich");

    expect((await store.verify()).ok).toBe(true);
  });

  it("works for a claim in any status, e.g. one already settled as confirmed", async () => {
    const claimId = await addClaim({
      id: "clm_settled",
      anchor: "p1",
      quote: "Die Fehlerrate bleibt unverändert.",
    });
    await decideClaim(PROJECT, claimId, { categories: [], durationS: 4 });

    await repairClaimAnchor(PROJECT, claimId, {
      anchor: "p3",
      quote: "Die Fehlerrate bleibt unverändert.",
    });

    const after = await RegisterStore.forProject(PROJECT).read();
    const claim = after.claims.find((candidate) => candidate.id === claimId);
    expect(claim?.briefing_anchor).toBe("p3");
    expect(claim?.status).toBe("confirmed");
  });

  it("refuses — before any write — when the quote is not in the chosen paragraph", async () => {
    const claimId = await addClaim({
      id: "clm_mismatch",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();

    await expect(
      repairClaimAnchor(PROJECT, claimId, {
        anchor: "p1",
        quote: "Die mediane Reviewzeit sinkt um 55 %.",
      }),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);

    expect(await store.read()).toEqual(before);
    expect((await store.verify()).ok).toBe(true);
  });

  it("refuses an anchor outside the briefing, an unparsable one and an empty quote", async () => {
    const claimId = await addClaim({
      id: "clm_range",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    const quote = "Die mediane Reviewzeit sinkt um 55 %.";

    await expect(
      repairClaimAnchor(PROJECT, claimId, { anchor: "p9", quote }),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);
    await expect(
      repairClaimAnchor(PROJECT, claimId, { anchor: "zwei", quote }),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);
    await expect(
      repairClaimAnchor(PROJECT, claimId, { anchor: "p2", quote: "   " }),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);
  });

  it("refuses for an unknown claim", async () => {
    await expect(
      repairClaimAnchor(PROJECT, "clm_ghost", {
        anchor: "p1",
        quote: P1,
      }),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);
  });
});

describe("repairBriefingPassage", () => {
  it("splices the anchored paragraph, publishes a revision naming the claim, and re-anchors silently", async () => {
    const claimId = await addClaim({
      id: "clm_passage",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });

    const corrected =
      "Absatz zwei: Die mediane Reviewzeit sinkt um 40 % (korrigiert).";
    await repairBriefingPassage(PROJECT, claimId, corrected);

    const store = RegisterStore.forProject(PROJECT);
    const after = await store.read();
    const briefing = after.project.briefing_import!;
    expect(briefing.revision).toBe(2);
    expect(store.blobs().readText(briefing.blob_path)).toBe(
      [P1, corrected, P3].join("\n\n"),
    );

    const events = after.project_events.map((event) => event.event);
    expect(events).toEqual([
      "project_created",
      "briefing_imported",
      "briefing_revised",
    ]);
    // The silent re-anchor pass covers the anchor consequences — no extra
    // audited anchor event is written here.
    expect(events).not.toContain("claim_anchor_revised");
    expect(after.project_events.at(-1)?.reason).toContain(claimId);

    // The claim's own quote is gone from the revised text, so its anchor
    // stays put (stale-over-guess) — and its status is untouched, leaving it
    // to proceed through its normal repair re-entry.
    const claim = after.claims.find((candidate) => candidate.id === claimId);
    expect(claim?.briefing_anchor).toBe("p2");
    expect(claim?.status).toBe("pending_adjudication");

    expect((await store.verify()).ok).toBe(true);
  });

  it("moves a claim whose quote shifted paragraphs as a consequence of the splice", async () => {
    const anchored = await addClaim({
      id: "clm_edited",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    const neighbour = await addClaim({
      id: "clm_neighbour",
      anchor: "p3",
      quote: "Die Fehlerrate bleibt unverändert.",
      text: "Die Fehlerrate bleibt unverändert.",
    });

    // The corrected passage is itself split into two paragraphs, so the
    // briefing grows from three to four and everything after it slides down
    // — the silent re-anchor pass has to follow the neighbour from p3 to p4.
    await repairBriefingPassage(
      PROJECT,
      anchored,
      "Absatz zwei neu, erster Teil.\n\nAbsatz zwei neu, zweiter Teil.",
    );

    const after = await RegisterStore.forProject(PROJECT).read();
    expect(after.claims).toHaveLength(2);
    expect(
      after.claims.find((candidate) => candidate.id === neighbour)
        ?.briefing_anchor,
    ).toBe("p4");
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });

  it("refuses an empty passage and a claim anchored to no paragraph", async () => {
    const claimId = await addClaim({
      id: "clm_empty",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    await expect(
      repairBriefingPassage(PROJECT, claimId, "   "),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);

    const unanchored = await addClaim({
      id: "clm_nowhere",
      anchor: "p42",
      quote: "Ein Satz, den das Briefing nicht enthält.",
    });
    await expect(
      repairBriefingPassage(PROJECT, unanchored, "Neuer Text."),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);
  });

  it("refuses for an unknown claim", async () => {
    await expect(
      repairBriefingPassage(PROJECT, "clm_ghost", "Neuer Text."),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);
  });

  it("refuses while an unpublished briefing draft exists, leaving both untouched", async () => {
    // Publishing a revision clears the project's draft, so a passage repair
    // run over an open draft would silently destroy an unrelated,
    // half-finished rewrite of the whole briefing.
    const claimId = await addClaim({
      id: "clm_draft_guard",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    await saveBriefingDraft(PROJECT, "Eine ganz andere, offene Überarbeitung.");
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();

    await expect(
      repairBriefingPassage(PROJECT, claimId, "Absatz zwei, korrigiert."),
    ).rejects.toBeInstanceOf(AnchorPreconditionError);

    // Neither side moved: no revision, and the draft is still there.
    expect(await store.read()).toEqual(before);
    expect((await getBriefingDraft(PROJECT))?.text).toBe(
      "Eine ganz andere, offene Überarbeitung.",
    );
  });

  it("works again once the draft has been discarded", async () => {
    const claimId = await addClaim({
      id: "clm_after_discard",
      anchor: "p2",
      quote: "Die mediane Reviewzeit sinkt um 55 %.",
    });
    await saveBriefingDraft(PROJECT, "Offene Überarbeitung.");
    await discardBriefingDraft(PROJECT);

    const corrected = "Absatz zwei: Die mediane Reviewzeit sinkt um 40 %.";
    await repairBriefingPassage(PROJECT, claimId, corrected);

    const store = RegisterStore.forProject(PROJECT);
    const after = await store.read();
    expect(after.project.briefing_import?.revision).toBe(2);
    expect(
      store.blobs().readText(after.project.briefing_import!.blob_path),
    ).toBe([P1, corrected, P3].join("\n\n"));
    expect((await store.verify()).ok).toBe(true);
  });
});

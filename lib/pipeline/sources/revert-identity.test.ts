import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import { PipelineError } from "../errors";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { createProject } from "../projects";
import { captureSource } from "./capture";
import { correctSource } from "./correction";
import { fakeFetcher, CSL_JSON_RESPONSE } from "./__fixtures__/fake-fetcher";
import { revertSourceIdentity } from "./revert-identity";

const PROJECT = "proj_ruecknahme";
const RIGHT_TEXT = Buffer.from("Die Reviewzeit sank messbar im Test.");
const WRONG_TEXT = Buffer.from("Eine Verlagsseite ohne den zitierten Beleg.");

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-revert-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Lässt sich eine Fehlkorrektur zurücknehmen?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** The original, CORRECT source: right metadata, right document. */
async function captureOriginal(): Promise<string> {
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Richtiges Papier", year: "2026" },
      upload: { content: RIGHT_TEXT, filename: "richtig.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  return source.id;
}

/** The wrong correction a reviewer accepted: different work, different
 * document — exactly the shape an over-eager repair suggestion produces. */
async function applyWrongCorrection(sourceId: string): Promise<void> {
  await correctSource(
    {
      projectId: PROJECT,
      sourceId,
      kind: "doi",
      identifier: "10.1109/TSE.2025.3489012",
      correctionAttemptId: "wi_falsch",
      documentUrl: "https://publisher.example.org/paper.pdf",
    },
    {
      fetcher: fakeFetcher({
        "https://api.crossref.org/works/": {
          contentType: "application/json",
          body: Buffer.from(CSL_JSON_RESPONSE),
        },
        "https://doi.org/": {
          contentType: "application/json",
          body: Buffer.from(CSL_JSON_RESPONSE),
        },
        "https://publisher.example.org/paper.pdf": {
          contentType: "text/plain",
          body: WRONG_TEXT,
        },
      }),
    },
  );
}

describe("revertSourceIdentity", () => {
  it("restores the archived identity AND its document", async () => {
    const sourceId = await captureOriginal();
    const before = (await RegisterStore.forProject(PROJECT).read()).sources[0];
    await applyWrongCorrection(sourceId);

    const result = await revertSourceIdentity(PROJECT, sourceId);

    expect(result.source.title).toBe(before.title);
    const blobs = RegisterStore.forProject(PROJECT).blobs();
    expect(
      blobs.readText(result.source.custom.snapshot?.text_blob_path as string),
    ).toBe(RIGHT_TEXT.toString());
  });

  it("audits the undo as a correction rather than erasing it", async () => {
    const sourceId = await captureOriginal();
    await applyWrongCorrection(sourceId);
    const wrong = (await RegisterStore.forProject(PROJECT).read()).sources[0];

    const result = await revertSourceIdentity(PROJECT, sourceId);

    // The discarded identity is archived in turn: the chain reads A → B → A.
    const archived = result.source.custom.previous_identities ?? [];
    expect(archived).toHaveLength(2);
    expect((archived.at(-1)?.item as { title?: string }).title).toBe(
      wrong.title,
    );
    // The revision advances; it is not rolled back.
    expect(result.newRevision).toBe(3);
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(
      register.project_events.filter(
        (event) => event.event === "source_identity_corrected",
      ),
    ).toHaveLength(2);
    expect((await RegisterStore.forProject(PROJECT).verify()).ok).toBe(true);
  });

  it("pulls claims stranded by the wrong identity back for re-checking", async () => {
    const sourceId = await captureOriginal();
    const claimId = await addClaimWalkedTo({
      projectId: PROJECT,
      claimNumber: 1,
      sourceId,
      status: "existence_checked",
    });
    await applyWrongCorrection(sourceId);
    // The real sequence: the correction re-queued the claim, stage 1 then
    // ran against the WRONG document and stranded it in adjudication.
    await RegisterStore.forProject(PROJECT).transaction((tx) => {
      tx.transitionClaim(claimId, {
        to: "captured",
        actor: "system:existence_check",
        reason: "Nachprüfung aufgenommen.",
      });
      const claim = tx.getClaim(claimId);
      tx.setExistenceCheck(claimId, claim.evidence[0].id, {
        status: "failed",
        at: new Date().toISOString(),
        match: "none",
      });
      tx.transitionClaim(claimId, {
        to: "pending_adjudication",
        actor: "system:existence_check",
        reason: "Wortlaut nicht im eingefrorenen Text gefunden.",
        routing: "existence_check_failed",
      });
    });

    const result = await revertSourceIdentity(PROJECT, sourceId);

    expect(result.recheckedClaimIds).toContain(claimId);
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims.find((c) => c.id === claimId)?.status).toBe(
      "recheck_required",
    );
  });

  it("refuses when there is nothing archived to restore", async () => {
    const sourceId = await captureOriginal();
    await expect(revertSourceIdentity(PROJECT, sourceId)).rejects.toThrow(
      PipelineError,
    );
    await expect(revertSourceIdentity(PROJECT, sourceId)).rejects.toThrow(
      /keine frühere Kennung/,
    );
  });

  it("refuses while a correction of the same source is in flight", async () => {
    const sourceId = await captureOriginal();
    await applyWrongCorrection(sourceId);
    const chain = {
      enqueueSourceCapture: () => {},
      pendingCaptureItems: () => [
        {
          workItemId: "wi_laufend",
          origin: "correction" as const,
          label: "Korrektur",
          targetSourceId: sourceId,
        },
      ],
      activeCaptureItem: () => undefined,
    };
    await expect(
      revertSourceIdentity(PROJECT, sourceId, { chain }),
    ).rejects.toThrow(/läuft bereits eine Korrektur/);
  });
});

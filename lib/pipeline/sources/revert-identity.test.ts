import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import type { SourceSnapshot } from "../../register";
import { PipelineError, RunActiveError } from "../errors";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { createProject } from "../projects";
import type { JobRunner } from "../runs/job-runner";
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

/** A plain TMB-44 revision: rotates the document, leaves the identity alone.
 * Only this capability appends to `previous_snapshots`, which is why that
 * array cannot be indexed in lockstep with `previous_identities`. */
async function reviseDocument(sourceId: string, text: string): Promise<void> {
  const store = RegisterStore.forProject(PROJECT);
  await store.transaction((tx) => {
    const current = tx.listSources().find((entry) => entry.id === sourceId)
      ?.custom.snapshot as SourceSnapshot;
    const ref = store.blobs().put(Buffer.from(text), "txt");
    tx.reviseSource(sourceId, {
      retrieved_at: new Date().toISOString(),
      sha256: ref.sha256,
      blob_path: ref.blobPath,
      revision: current.revision + 1,
    });
  });
}

/** A runner that reports a run in progress, so the guard is reached without
 * standing up a real one — same stub shape correction.test.ts uses. */
function busyRunner(): JobRunner {
  return {
    isRunning: () => true,
    currentRun: () => undefined,
    submit: () => {
      throw new Error("submit is not reachable from this guard test");
    },
    subscribeRunStarts: () => () => {},
  };
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

  it("refuses while a run of the same project is active", async () => {
    // The in-flight-correction guard above does NOT cover this: it sees
    // queued capture/correction work items, not a verification run already
    // under way. A revert rotates the frozen document, and a run caches the
    // sources once at its start, so without this guard the run would keep
    // settling claims against a document the revert has just replaced.
    const sourceId = await captureOriginal();
    await applyWrongCorrection(sourceId);
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();
    await expect(
      revertSourceIdentity(PROJECT, sourceId, { runner: busyRunner() }),
    ).rejects.toBeInstanceOf(RunActiveError);
    const after = await store.read();
    expect(after.project_events).toHaveLength(before.project_events.length);
    expect(
      after.sources.find((candidate) => candidate.id === sourceId)?.custom
        .snapshot?.revision,
    ).toBe(
      before.sources.find((c) => c.id === sourceId)?.custom.snapshot?.revision,
    );
  });

  it("restores the snapshot the correction replaced, not the newest archived one", async () => {
    const sourceId = await captureOriginal();
    const store = RegisterStore.forProject(PROJECT);
    const originalSnapshot = (await store.read()).sources[0].custom
      .snapshot as SourceSnapshot;
    await applyWrongCorrection(sourceId);

    // Three plain revisions AFTER the correction. Only tx.reviseSource
    // appends to previous_snapshots, so its last entry drifts away from the
    // snapshot the correction actually replaced — the live-register bug.
    for (const label of ["eins", "zwei", "drei"]) {
      await reviseDocument(sourceId, `Zwischenfassung ${label}.`);
    }
    const drifted = (await store.read()).sources[0];
    expect(drifted.custom.previous_snapshots?.at(-1)?.revision).toBe(4);

    const result = await revertSourceIdentity(PROJECT, sourceId);

    // The event records snapshot_revision {from: 1, to: 2}, so revision 1 is
    // what must come back — not revision 4.
    expect(result.source.custom.snapshot?.sha256).toBe(originalSnapshot.sha256);
    expect(result.source.custom.snapshot?.blob_path).toBe(
      originalSnapshot.blob_path,
    );
    expect(result.source.custom.snapshot?.sha256).not.toBe(
      drifted.custom.previous_snapshots?.at(-1)?.sha256,
    );
    expect((await store.verify()).ok).toBe(true);
  });

  it("restores the identity alone when the correction rotated no document", async () => {
    const sourceId = await captureOriginal();
    const store = RegisterStore.forProject(PROJECT);
    const beforeRegister = await store.read();
    const before = beforeRegister.sources[0];
    const frozen = before.custom.snapshot as SourceSnapshot;
    const setRevisionBefore = beforeRegister.project.source_set_revision;

    // The metadata-only shape: identity archived, document untouched,
    // snapshot_revision {from: 1, to: 1}.
    await store.transaction((tx) => {
      const { previousItem, newItem } = tx.correctSourceIdentity(sourceId, {
        item: { title: "Falsches Papier", issued: { "date-parts": [[2009]] } },
        replacedAt: new Date().toISOString(),
        correctionAttemptId: "wi_nur_metadaten",
      });
      tx.recordIdentityCorrection({
        source_id: sourceId,
        previous_item: previousItem,
        new_item: newItem,
        snapshot_revision: { from: frozen.revision, to: frozen.revision },
        recheck_claim_ids: [],
        actor: "system:source_correction",
        reason: "Nur die bibliografischen Angaben ersetzt.",
      });
    });

    const result = await revertSourceIdentity(PROJECT, sourceId);

    expect(result.source.title).toBe(before.title);
    expect(result.source.custom.snapshot?.sha256).toBe(frozen.sha256);
    expect(result.source.custom.snapshot?.blob_path).toBe(frozen.blob_path);
    expect(result.source.custom.snapshot?.revision).toBe(frozen.revision);
    expect(result.source.custom.previous_snapshots ?? []).toHaveLength(0);
    expect(result.newRevision).toBe(frozen.revision);
    const register = await store.read();
    // No rotation means no source-set revision either.
    expect(register.project.source_set_revision).toBe(setRevisionBefore);
    const events = register.project_events.filter(
      (event) => event.event === "source_identity_corrected",
    );
    expect(events.at(-1)?.identity_change?.snapshot_revision).toEqual({
      from: frozen.revision,
      to: frozen.revision,
    });
    expect((await store.verify()).ok).toBe(true);
  });

  it("refuses when no correction event says which snapshot the identity paired with", async () => {
    const sourceId = await captureOriginal();
    const store = RegisterStore.forProject(PROJECT);
    // An archived snapshot exists — a plain revision put it there — so the
    // old .at(-1) pairing would happily restore it. Only the absence of a
    // source_identity_corrected event may refuse this revert: without it the
    // two archives cannot be paired at all, and guessing is the bug.
    await reviseDocument(sourceId, "Eine spätere Fassung.");
    await store.transaction((tx) => {
      tx.correctSourceIdentity(sourceId, {
        item: { title: "Falsches Papier" },
        replacedAt: new Date().toISOString(),
        correctionAttemptId: "wi_ohne_event",
      });
    });
    const before = await store.read();

    await expect(revertSourceIdentity(PROJECT, sourceId)).rejects.toThrow(
      PipelineError,
    );

    const after = await store.read();
    expect(after.project_events).toHaveLength(before.project_events.length);
    expect(after.sources[0]).toEqual(before.sources[0]);
  });

  it("refuses when the replaced snapshot revision is not archived", async () => {
    const sourceId = await captureOriginal();
    const store = RegisterStore.forProject(PROJECT);
    // from !== to claims a rotation, and an archived snapshot exists — but
    // it carries revision 1, not the revision 7 the event names. Restoring
    // it anyway would invent a document the correction never replaced.
    await reviseDocument(sourceId, "Eine spätere Fassung.");
    await store.transaction((tx) => {
      const { previousItem, newItem } = tx.correctSourceIdentity(sourceId, {
        item: { title: "Falsches Papier" },
        replacedAt: new Date().toISOString(),
        correctionAttemptId: "wi_luecke",
      });
      tx.recordIdentityCorrection({
        source_id: sourceId,
        previous_item: previousItem,
        new_item: newItem,
        snapshot_revision: { from: 7, to: 8 },
        recheck_claim_ids: [],
        actor: "system:source_correction",
        reason: "Korrektur mit fehlendem Archivstand.",
      });
    });
    const before = await store.read();

    await expect(revertSourceIdentity(PROJECT, sourceId)).rejects.toThrow(
      PipelineError,
    );

    const after = await store.read();
    expect(after.project_events).toHaveLength(before.project_events.length);
    expect(after.sources[0]).toEqual(before.sources[0]);
  });
});

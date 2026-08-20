import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import type { ClaimStatus } from "../../register";
import {
  RunActiveError,
  SourceCorrectionPreconditionError,
  UnknownSourceError,
} from "../errors";
import { createProject } from "../projects";
import type { JobRunner } from "../runs/job-runner";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { CSL_JSON_RESPONSE, fakeFetcher } from "./__fixtures__/fake-fetcher";
import { captureSource } from "./capture";
import { correctSource, correctSourceMetadata } from "./correction";

const PROJECT = "proj_correction";
const WRONG_DOC = Buffer.from("Volltext des falschen Papers.");
const RIGHT_DOC = Buffer.from("Die Reviewzeit sank von 42 auf 19 Minuten.");

let workspace: string;
let sourceId: string;

/** Resolves the corrected DOI and serves the corrected document. */
function correctionFetcher() {
  return fakeFetcher({
    "https://doi.org/": {
      contentType: "application/vnd.citationstyles.csl+json",
      body: Buffer.from(CSL_JSON_RESPONSE),
    },
    "https://docs.example.org/richtig.txt": {
      contentType: "text/plain",
      body: RIGHT_DOC,
    },
  });
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-correction-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  // The wrongly identified source: entered via the auto-import flow, so it
  // carries provenance the correction must preserve.
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Falsches Paper", year: "2020" },
      upload: { content: WRONG_DOC, filename: "falsch.txt" },
      autoCapture: { raw_text: "Meyer 2025", method: "doi" },
      captureAttemptId: "cand_0001",
    },
    { fetcher: fakeFetcher({}) },
  );
  sourceId = source.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

let nextClaim = 0;

async function addClaimAt(
  status: ClaimStatus,
  onSource: string = sourceId,
): Promise<string> {
  nextClaim += 1;
  return addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: nextClaim,
    sourceId: onSource,
    status,
  });
}

/** A claim stranded in adjudication BECAUSE its existence check failed
 * against the wrongly identified source — the exact dead end the
 * correction exists to reopen. */
async function addClaimStrandedByExistenceCheck(): Promise<string> {
  const claimId = await addClaimAt("captured");
  const store = RegisterStore.forProject(PROJECT);
  await store.transaction((tx) => {
    const claim = tx.getClaim(claimId);
    tx.setExistenceCheck(claimId, claim.evidence[0].id, {
      status: "failed",
      at: new Date().toISOString(),
    });
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: "system:existence_check",
      reason: "Wortlaut nicht im eingefrorenen Text gefunden.",
      routing: "existence_check_failed",
    });
  });
  return claimId;
}

describe("correctSource", () => {
  it("rejects unknown sources", async () => {
    await expect(
      correctSource(
        {
          projectId: PROJECT,
          sourceId: "src_gibtsnicht",
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
          documentUrl: "https://docs.example.org/richtig.txt",
          correctionAttemptId: "wi_test",
        },
        { fetcher: correctionFetcher() },
      ),
    ).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("replaces the identity on the same id, archives the old one and readmits stuck claims", async () => {
    const confirmed = await addClaimAt("confirmed");
    const stranded = await addClaimStrandedByExistenceCheck();
    const spotChecked = await addClaimAt("pending_adjudication");
    const captured = await addClaimAt("captured");

    const result = await correctSource(
      {
        projectId: PROJECT,
        sourceId,
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://docs.example.org/richtig.txt",
        correctionAttemptId: "wi_korrektur_1",
      },
      { fetcher: correctionFetcher() },
    );

    expect(result.source.id).toBe(sourceId);
    expect(result.newRevision).toBe(2);
    expect(result.recheckedClaimIds.sort()).toEqual(
      [confirmed, stranded].sort(),
    );

    const store = RegisterStore.forProject(PROJECT);
    const register = await store.read();
    const source = register.sources.find(
      (candidate) => candidate.id === sourceId,
    );

    // The corrected bibliographic core, freshly verified.
    expect(source?.DOI).toBe("10.1109/TSE.2025.3489012");
    expect(source?.title).toBe(
      "Effects of AI Assistants on Code Review Duration",
    );
    expect(source?.custom.identifier_verified?.status).toBe(true);

    // The superseded identity is archived, not lost.
    expect(source?.custom.previous_identities).toHaveLength(1);
    const archived = source?.custom.previous_identities?.[0];
    expect(archived?.item.title).toBe("Falsches Paper");
    expect(archived?.item.custom).toBeUndefined();
    expect(archived?.identifier_verified).toBeUndefined();

    // Document rotated like a revision; first-entry provenance untouched.
    expect(source?.custom.snapshot?.revision).toBe(2);
    expect(source?.custom.previous_snapshots).toHaveLength(1);
    expect(
      store.blobs().read(source?.custom.snapshot?.blob_path as string),
    ).toEqual(RIGHT_DOC);
    expect(source?.custom.auto_capture?.raw_text).toBe("Meyer 2025");
    expect(source?.custom.capture_attempt_id).toBe("cand_0001");
    expect(source?.custom.correction_attempt_id).toBe("wi_korrektur_1");
    expect(register.project.source_set_revision).toBe(2);

    // The audit event carries the full before/after core.
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_identity_corrected",
    );
    expect(event?.identity_change?.source_id).toBe(sourceId);
    expect(event?.identity_change?.previous_item.title).toBe("Falsches Paper");
    expect(event?.identity_change?.new_item.DOI).toBe(
      "10.1109/TSE.2025.3489012",
    );
    expect(event?.identity_change?.snapshot_revision).toEqual({
      from: 1,
      to: 2,
    });
    expect(event?.identity_change?.recheck_claim_ids.sort()).toEqual(
      [confirmed, stranded].sort(),
    );

    // Settled and existence-check-stranded claims are readmitted; the
    // spot-check adjudication case and the unchecked claim stay put.
    const statusOf = (id: string) =>
      register.claims.find((claim) => claim.id === id)?.status;
    expect(statusOf(confirmed)).toBe("recheck_required");
    expect(statusOf(stranded)).toBe("recheck_required");
    expect(statusOf(spotChecked)).toBe("pending_adjudication");
    expect(statusOf(captured)).toBe("captured");

    expect((await store.verify()).ok).toBe(true);
  });

  it("leaves claims of other sources alone, even stranded ones", async () => {
    const other = await captureSource(
      {
        projectId: PROJECT,
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Zweitquelle", year: "2026" },
        upload: { content: Buffer.from("Anderer Inhalt."), filename: "b.txt" },
      },
      { fetcher: fakeFetcher({}) },
    );
    const onOther = await addClaimAt("confirmed", other.id);

    const result = await correctSource(
      {
        projectId: PROJECT,
        sourceId,
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://docs.example.org/richtig.txt",
        correctionAttemptId: "wi_korrektur_2",
      },
      { fetcher: correctionFetcher() },
    );
    expect(result.recheckedClaimIds).toEqual([]);
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims.find((claim) => claim.id === onOther)?.status).toBe(
      "confirmed",
    );
  });

  it("clears an earlier verification when correcting to an unverifiable kind", async () => {
    // First correction: to a verified DOI.
    await correctSource(
      {
        projectId: PROJECT,
        sourceId,
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        documentUrl: "https://docs.example.org/richtig.txt",
        correctionAttemptId: "wi_korrektur_3",
      },
      { fetcher: correctionFetcher() },
    );
    // Second correction: back to a manual upload — the DOI-era verification
    // must not survive on the new, unverified identity.
    await correctSource(
      {
        projectId: PROJECT,
        sourceId,
        kind: "upload",
        manual: { title: "Handkorrigiert", year: "2026" },
        upload: { content: RIGHT_DOC, filename: "richtig.txt" },
        correctionAttemptId: "wi_korrektur_4",
      },
      { fetcher: fakeFetcher({}) },
    );
    const register = await RegisterStore.forProject(PROJECT).read();
    const source = register.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    expect(source?.custom.identifier_verified).toBeUndefined();
    expect(source?.title).toBe("Handkorrigiert");
    expect(source?.custom.previous_identities).toHaveLength(2);
    // The archived DOI identity carries ITS verification.
    expect(
      source?.custom.previous_identities?.[1].identifier_verified?.status,
    ).toBe(true);
    expect(source?.custom.correction_attempt_id).toBe("wi_korrektur_4");
  });

  it("always writes the corrected identity, even for byte-identical documents", async () => {
    // The correct PDF was already in place; only the identity was wrong —
    // reviseSource's checksum no-op must NOT apply here.
    const result = await correctSource(
      {
        projectId: PROJECT,
        sourceId,
        kind: "upload",
        manual: { title: "Gleicher Inhalt, richtige Kennung", year: "2026" },
        upload: { content: WRONG_DOC, filename: "falsch.txt" },
        correctionAttemptId: "wi_korrektur_5",
      },
      { fetcher: fakeFetcher({}) },
    );
    expect(result.newRevision).toBe(2);
    const register = await RegisterStore.forProject(PROJECT).read();
    const source = register.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    expect(source?.title).toBe("Gleicher Inhalt, richtige Kennung");
    expect(source?.custom.snapshot?.revision).toBe(2);
  });

  it("requires a frozen snapshot", async () => {
    // A snapshotless source cannot exist through captureSource; build one
    // directly to pin the precondition.
    const store = RegisterStore.forProject(PROJECT);
    await store.transaction((tx) => {
      tx.addSource({
        id: "src_ohne_snapshot",
        type: "document",
        title: "Ohne Snapshot",
        custom: { source_type: "grey_literature" },
      });
    });
    await expect(
      correctSource(
        {
          projectId: PROJECT,
          sourceId: "src_ohne_snapshot",
          kind: "upload",
          manual: { title: "Egal" },
          upload: { content: RIGHT_DOC, filename: "r.txt" },
          correctionAttemptId: "wi_test",
        },
        { fetcher: fakeFetcher({}) },
      ),
    ).rejects.toBeInstanceOf(SourceCorrectionPreconditionError);
  });
});

describe("correctSourceMetadata", () => {
  /** The corrected identity only — this path resolves metadata and never
   * fetches a document, so the fetcher needs no document route. */
  function metadataFetcher() {
    return fakeFetcher({
      "https://doi.org/": {
        contentType: "application/vnd.citationstyles.csl+json",
        body: Buffer.from(CSL_JSON_RESPONSE),
      },
    });
  }

  /** A runner reporting the project busy. `isRunning` is the only member
   * this use-case consults; the rest exist to satisfy the port. */
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

  it("replaces the identity without touching the frozen document", async () => {
    const confirmed = await addClaimAt("confirmed");
    const stranded = await addClaimStrandedByExistenceCheck();
    const spotChecked = await addClaimAt("pending_adjudication");
    const captured = await addClaimAt("captured");

    const store = RegisterStore.forProject(PROJECT);
    const before = (await store.read()).sources.find(
      (candidate) => candidate.id === sourceId,
    );
    const beforeSnapshot = before?.custom.snapshot;

    const result = await correctSourceMetadata(
      {
        projectId: PROJECT,
        sourceId,
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
      },
      { fetcher: metadataFetcher() },
    );

    expect(result.source.id).toBe(sourceId);
    expect(result.revision).toBe(1);
    expect(result.recheckedClaimIds.sort()).toEqual(
      [confirmed, stranded].sort(),
    );

    const register = await store.read();
    const source = register.sources.find(
      (candidate) => candidate.id === sourceId,
    );

    // The corrected bibliographic core, freshly verified.
    expect(source?.DOI).toBe("10.1109/TSE.2025.3489012");
    expect(source?.title).toBe(
      "Effects of AI Assistants on Code Review Duration",
    );
    expect(source?.custom.identifier_verified?.status).toBe(true);

    // Exactly one archived identity, and no archived document at all.
    expect(source?.custom.previous_identities).toHaveLength(1);
    expect(source?.custom.previous_identities?.[0].item.title).toBe(
      "Falsches Paper",
    );
    expect(source?.custom.previous_snapshots ?? []).toHaveLength(0);

    // The frozen document is byte-identical: same blob, same revision.
    expect(source?.custom.snapshot?.sha256).toBe(beforeSnapshot?.sha256);
    expect(source?.custom.snapshot?.blob_path).toBe(beforeSnapshot?.blob_path);
    expect(source?.custom.snapshot?.revision).toBe(beforeSnapshot?.revision);
    expect(
      store.blobs().read(source?.custom.snapshot?.blob_path as string),
    ).toEqual(WRONG_DOC);

    // Nothing rotated, so the project-wide source set did not move either.
    expect(register.project.source_set_revision).toBe(1);

    // Exactly one correction event, recording an unmoved revision pair.
    const events = register.project_events.filter(
      (candidate) => candidate.event === "source_identity_corrected",
    );
    expect(events).toHaveLength(1);
    expect(events[0].identity_change?.snapshot_revision).toEqual({
      from: 1,
      to: 1,
    });
    expect(events[0].identity_change?.previous_item.title).toBe(
      "Falsches Paper",
    );
    expect(events[0].identity_change?.new_item.DOI).toBe(
      "10.1109/TSE.2025.3489012",
    );
    expect(source?.custom.correction_attempt_id).toMatch(/^wi_/);

    // Settled and existence-check-stranded claims are readmitted; the
    // spot-check adjudication case and the unchecked claim stay put.
    const statusOf = (id: string) =>
      register.claims.find((claim) => claim.id === id)?.status;
    expect(statusOf(confirmed)).toBe("recheck_required");
    expect(statusOf(stranded)).toBe("recheck_required");
    expect(statusOf(spotChecked)).toBe("pending_adjudication");
    expect(statusOf(captured)).toBe("captured");

    expect((await store.verify()).ok).toBe(true);
  });

  it("reclassifies the source type alongside the identity", async () => {
    await correctSourceMetadata(
      {
        projectId: PROJECT,
        sourceId,
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        sourceType: "peer_reviewed_publication",
      },
      { fetcher: metadataFetcher() },
    );
    const register = await RegisterStore.forProject(PROJECT).read();
    const source = register.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    expect(source?.custom.source_type).toBe("peer_reviewed_publication");
  });

  it("refuses while the project is busy, and writes nothing", async () => {
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();
    await expect(
      correctSourceMetadata(
        {
          projectId: PROJECT,
          sourceId,
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
        },
        { fetcher: metadataFetcher(), runner: busyRunner() },
      ),
    ).rejects.toBeInstanceOf(RunActiveError);
    const after = await store.read();
    expect(after.project_events).toHaveLength(before.project_events.length);
    expect(
      after.sources.find((candidate) => candidate.id === sourceId)?.title,
    ).toBe("Falsches Paper");
  });

  it("refuses while a correction of the same source is in flight", async () => {
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();
    const chain = {
      enqueueSourceCapture: () => {},
      pendingCaptureItems: () => [],
      activeCaptureItem: () => ({
        workItemId: "wi_laufend",
        origin: "correction" as const,
        label: "Korrektur",
        targetSourceId: sourceId,
      }),
    };
    await expect(
      correctSourceMetadata(
        {
          projectId: PROJECT,
          sourceId,
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
        },
        { fetcher: metadataFetcher(), chain },
      ),
    ).rejects.toBeInstanceOf(SourceCorrectionPreconditionError);
    const after = await store.read();
    expect(after.project_events).toHaveLength(before.project_events.length);
    expect(
      after.sources.find((candidate) => candidate.id === sourceId)?.title,
    ).toBe("Falsches Paper");
  });

  it("rejects unknown sources", async () => {
    await expect(
      correctSourceMetadata(
        {
          projectId: PROJECT,
          sourceId: "src_gibtsnicht",
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
        },
        { fetcher: metadataFetcher() },
      ),
    ).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("requires a frozen snapshot", async () => {
    const store = RegisterStore.forProject(PROJECT);
    await store.transaction((tx) => {
      tx.addSource({
        id: "src_ohne_snapshot",
        type: "document",
        title: "Ohne Snapshot",
        custom: { source_type: "grey_literature" },
      });
    });
    await expect(
      correctSourceMetadata(
        {
          projectId: PROJECT,
          sourceId: "src_ohne_snapshot",
          kind: "upload",
          manual: { title: "Egal" },
        },
        { fetcher: fakeFetcher({}) },
      ),
    ).rejects.toBeInstanceOf(SourceCorrectionPreconditionError);
  });
});

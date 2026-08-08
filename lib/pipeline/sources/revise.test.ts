import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import type { ClaimStatus } from "../../register";
import {
  RunActiveError,
  SourceRevisionPreconditionError,
  UnknownSourceError,
} from "../errors";
import { createProject } from "../projects";
import { addClaimWalkedTo } from "../__fixtures__/walk-claim";
import { createJobRunner } from "../runs/job-runner";
import { fakeFetcher } from "./__fixtures__/fake-fetcher";
import { captureSource, freezeSourceSet } from "./capture";
import { reviseSource } from "./revise";
import { pickUnfinishedClaims } from "../verification/select-claims";

const PROJECT = "proj_revision";
const V1 = Buffer.from("Die Reviewzeit sank von 42 auf 19 Minuten.");
const V2 = Buffer.from(
  "Die Reviewzeit sank von 42 auf 21 Minuten (korrigiert).",
);

let workspace: string;
let sourceId: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-revise-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_KUERZEL", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grauliteratur",
      manual: { title: "Bericht", year: "2026" },
      upload: { content: V1, filename: "bericht.txt" },
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

/** Walks a fresh claim to the requested status via the shared fixture. */
async function addClaimAt(status: ClaimStatus): Promise<string> {
  nextClaim += 1;
  return addClaimWalkedTo({
    projectId: PROJECT,
    claimNumber: nextClaim,
    sourceId,
    status,
  });
}

describe("reviseSource", () => {
  it("rejects revision while the source set is not frozen", async () => {
    await expect(
      reviseSource({
        projectId: PROJECT,
        sourceId,
        upload: { content: V2, filename: "bericht.txt" },
      }),
    ).rejects.toBeInstanceOf(SourceRevisionPreconditionError);
  });

  it("rejects revision while a run is active (stale run caches)", async () => {
    await freezeSourceSet(PROJECT);
    const runner = createJobRunner();
    runner.submit(
      PROJECT,
      ["item"],
      (item) => item,
      () => new Promise((resolve) => setTimeout(() => resolve("ok"), 50)),
      { kind: "verification" },
    );
    await expect(
      reviseSource(
        {
          projectId: PROJECT,
          sourceId,
          upload: { content: V2, filename: "bericht.txt" },
        },
        { runner },
      ),
    ).rejects.toBeInstanceOf(RunActiveError);
  });

  it("rejects unknown sources", async () => {
    await freezeSourceSet(PROJECT);
    await expect(
      reviseSource({
        projectId: PROJECT,
        sourceId: "src_gibtsnicht",
        upload: { content: V2, filename: "bericht.txt" },
      }),
    ).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it("recognizes identical content and changes nothing", async () => {
    await freezeSourceSet(PROJECT);
    const before = await RegisterStore.forProject(PROJECT).read();
    const result = await reviseSource({
      projectId: PROJECT,
      sourceId,
      upload: { content: V1, filename: "bericht.txt" },
    });
    expect(result.revised).toBe(false);
    expect(result.recheckedClaimIds).toEqual([]);
    const after = await RegisterStore.forProject(PROJECT).read();
    expect(after).toEqual(before);
  });

  it("rotates the snapshot, advances revisions, chains the event and marks settled claims", async () => {
    const confirmed = await addClaimAt("bestaetigt");
    const autoConfirmed = await addClaimAt("automatisch_bestaetigt");
    const preChecked = await addClaimAt("vorgeprueft");
    const captured = await addClaimAt("erfasst");
    const awaiting = await addClaimAt("zur_adjudikation");
    const discarded = await addClaimAt("verworfen");
    await freezeSourceSet(PROJECT);

    const result = await reviseSource({
      projectId: PROJECT,
      sourceId,
      upload: { content: V2, filename: "bericht.txt" },
    });
    expect(result.revised).toBe(true);
    expect(result.newRevision).toBe(2);
    expect(result.recheckedClaimIds.sort()).toEqual(
      [confirmed, autoConfirmed, preChecked].sort(),
    );

    const store = RegisterStore.forProject(PROJECT);
    const register = await store.read();

    // Snapshot rotated; the superseded one is preserved with its blobs.
    const source = register.sources.find((s) => s.id === sourceId);
    expect(source?.custom.snapshot?.revision).toBe(2);
    expect(source?.custom.previous_snapshots).toHaveLength(1);
    const old = source?.custom.previous_snapshots?.[0];
    expect(old?.revision).toBe(1);
    expect(store.blobs().read(old?.blob_path as string)).toEqual(V1);
    expect(
      store.blobs().read(source?.custom.snapshot?.blob_path as string),
    ).toEqual(V2);

    // Project-wide revision advanced, event chained.
    expect(register.project.source_set_revision).toBe(2);
    const event = register.project_events.find(
      (candidate) => candidate.event === "source_set_revised",
    );
    expect(event?.reason).toContain(sourceId);
    expect(event?.reason).toContain("3 Claim(s) zur Nachprüfung");

    // Exactly the settled claims moved; the others are untouched.
    const statusOf = (id: string) =>
      register.claims.find((claim) => claim.id === id)?.status;
    expect(statusOf(confirmed)).toBe("nachpruefung_erforderlich");
    expect(statusOf(autoConfirmed)).toBe("nachpruefung_erforderlich");
    expect(statusOf(preChecked)).toBe("nachpruefung_erforderlich");
    expect(statusOf(captured)).toBe("erfasst");
    expect(statusOf(awaiting)).toBe("zur_adjudikation");
    expect(statusOf(discarded)).toBe("verworfen");

    // Recheck claims are swept up by the next verification run.
    expect(
      pickUnfinishedClaims(register)
        .map((claim) => claim.id)
        .sort(),
    ).toEqual([confirmed, autoConfirmed, preChecked, captured].sort());

    // Re-admission to the cascade takes the ratified edge.
    await store.transaction((tx) => {
      tx.transitionClaim(confirmed, {
        to: "erfasst",
        actor: "system:existenzpruefung",
        reason: "Wiederaufnahme nach Bestandsrevision.",
      });
    });

    expect((await store.verify()).ok).toBe(true);
  });

  it("does not mark claims whose evidence lies on other sources", async () => {
    const other = await captureSource(
      {
        projectId: PROJECT,
        kind: "upload",
        sourceType: "grauliteratur",
        manual: { title: "Zweitquelle", year: "2026" },
        upload: { content: Buffer.from("Anderer Inhalt."), filename: "b.txt" },
      },
      { fetcher: fakeFetcher({}) },
    );
    const onFirst = await addClaimAt("bestaetigt");
    await freezeSourceSet(PROJECT);

    const result = await reviseSource({
      projectId: PROJECT,
      sourceId: other.id,
      upload: {
        content: Buffer.from("Anderer Inhalt, neu."),
        filename: "b.txt",
      },
    });
    expect(result.revised).toBe(true);
    expect(result.recheckedClaimIds).toEqual([]);
    const register = await RegisterStore.forProject(PROJECT).read();
    expect(register.claims.find((claim) => claim.id === onFirst)?.status).toBe(
      "bestaetigt",
    );
  });
});

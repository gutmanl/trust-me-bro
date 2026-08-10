import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../schema/project";
import {
  ChainIntegrityError,
  CorruptRegisterError,
  RegisterIntegrityError,
  RegisterValidationError,
} from "./errors";
import { RegisterStore } from "./store";

const config: ProjectConfig = {
  rubric_version: "se-evidence-rubric-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
  },
};

let projectDir: string;
let store: RegisterStore;

async function createProject(): Promise<RegisterStore> {
  const created = RegisterStore.atDirectory(projectDir);
  await created.create({
    id: "proj_persistence-test",
    research_question: "Wird korrekt persistiert?",
    config,
    actor: "human:lg",
    at: "2026-08-06T08:00:00Z",
  });
  return created;
}

beforeEach(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-persistence-"));
  store = await createProject();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("RegisterStore.create", () => {
  it("initializes a register whose first chain entry is project_created", async () => {
    const register = await store.read();
    expect(register.project.id).toBe("proj_persistence-test");
    expect(register.project_events).toHaveLength(1);
    expect(register.project_events[0]).toMatchObject({
      seq: 1,
      event: "project_created",
    });
    expect((await store.verify()).ok).toBe(true);
  });

  it("refuses to initialize twice", async () => {
    await expect(
      store.create({
        id: "proj_other",
        research_question: "Nochmal?",
        config,
        actor: "human:lg",
      }),
    ).rejects.toThrow(/already initialized/);
  });
});

describe("RegisterStore.transaction", () => {
  it("persists mutations and returns the mutator result", async () => {
    const seq = await store.transaction((tx) => {
      const entry = tx.recordProjectEvent({
        event: "source_set_frozen",
        reason: "Bestand eingefroren.",
        actor: "human:lg",
        at: "2026-08-06T09:00:00Z",
      });
      return entry.seq;
    });
    expect(seq).toBe(2);
    const register = await store.read();
    expect(register.project_events).toHaveLength(2);
    expect((await store.verify()).ok).toBe(true);
  });

  it("serializes concurrent transactions with gapless seq assignment", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.transaction((tx) => {
          tx.recordProjectEvent({
            event: "batch_run_started",
            reason: `Lauf ${index}.`,
            actor: "system:extraction",
          });
        }),
      ),
    );
    const register = await store.read();
    const seqs = register.project_events
      .map((event) => event.seq)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    expect((await store.verify()).ok).toBe(true);
  });

  it("leaves the file untouched when the mutator throws", async () => {
    const before = fs.readFileSync(store.claimsPath, "utf8");
    await expect(
      store.transaction(() => {
        throw new Error("mutator failure");
      }),
    ).rejects.toThrow("mutator failure");
    expect(fs.readFileSync(store.claimsPath, "utf8")).toBe(before);
  });

  it("validates the result against the schema before renaming", async () => {
    const before = fs.readFileSync(store.claimsPath, "utf8");
    await expect(
      store.transaction((tx) => {
        tx.recordProjectEvent({
          event: "unbekanntes_ereignis" as never,
          reason: "sollte abgewiesen werden",
          actor: "human:lg",
        });
      }),
    ).rejects.toThrow(RegisterValidationError);
    expect(fs.readFileSync(store.claimsPath, "utf8")).toBe(before);
  });

  it("rejects referentially inconsistent results before renaming", async () => {
    const source = {
      id: "src_doppelt",
      type: "article-journal",
      custom: { source_type: "peer_reviewed_publication" },
    } as const;
    const before = fs.readFileSync(store.claimsPath, "utf8");
    await expect(
      store.transaction((tx) => {
        tx.addSource(structuredClone(source) as never);
        tx.addSource(structuredClone(source) as never);
      }),
    ).rejects.toThrow(RegisterIntegrityError);
    expect(fs.readFileSync(store.claimsPath, "utf8")).toBe(before);
  });

  it("releases the lock after a failed transaction", async () => {
    await expect(
      store.transaction(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "source_set_frozen",
        reason: "Nach Fehler weiter nutzbar.",
        actor: "human:lg",
      });
    });
    expect((await store.read()).project_events).toHaveLength(2);
  });

  it("never leaves a torn claims.json when the rename fails", async () => {
    const before = fs.readFileSync(store.claimsPath, "utf8");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });
    await expect(
      store.transaction((tx) => {
        tx.recordProjectEvent({
          event: "source_set_frozen",
          reason: "wird nicht ankommen",
          actor: "human:lg",
        });
      }),
    ).rejects.toThrow("simulated rename failure");
    renameSpy.mockRestore();
    expect(fs.readFileSync(store.claimsPath, "utf8")).toBe(before);
    // No stray temp files remain next to claims.json.
    const leftovers = fs
      .readdirSync(projectDir)
      .filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("cannot bypass the chain via snapshot accessors", async () => {
    await store.transaction((tx) => {
      const claims = tx.listClaims();
      claims.push({} as never);
      const project = tx.getProject();
      project.research_question = "geändert?";
    });
    const register = await store.read();
    expect(register.claims).toHaveLength(0);
    expect(register.project.research_question).toBe(
      "Wird korrekt persistiert?",
    );
  });
});

describe("RegisterTransaction.recordBriefingImport", () => {
  it("freezes the briefing reference once and records the event", async () => {
    await store.transaction((tx) => {
      tx.recordBriefingImport({
        sha256: "a".repeat(64),
        blob_path: `blobs/aa/${"a".repeat(64)}.md`,
        tool: "deep-research-x",
        actor: "human:lg",
        at: "2026-08-06T09:00:00Z",
      });
    });
    const register = await store.read();
    expect(register.project.briefing_import?.sha256).toBe("a".repeat(64));
    expect(register.project_events.map((event) => event.event)).toContain(
      "briefing_imported",
    );
    expect((await store.verify()).ok).toBe(true);

    await expect(
      store.transaction((tx) =>
        tx.recordBriefingImport({
          sha256: "b".repeat(64),
          blob_path: `blobs/bb/${"b".repeat(64)}.md`,
          tool: "deep-research-x",
          actor: "human:lg",
        }),
      ),
    ).rejects.toThrow(/already has an imported briefing/);
  });
});

describe("RegisterTransaction.recordReferenceScan", () => {
  it("sets the pointer, appends the event, and overwrites on a second call", async () => {
    await store.transaction((tx) => {
      tx.recordReferenceScan({
        sha256: "a".repeat(64),
        blob_path: `blobs/aa/${"a".repeat(64)}.json`,
        method: "regex",
        candidate_count: 3,
        actor: "human:lg",
        reason: "Regelbasierter Scan: 3 Kandidat(en) gefunden.",
        at: "2026-08-06T10:00:00Z",
      });
    });
    let register = await store.read();
    expect(register.project.reference_scan?.sha256).toBe("a".repeat(64));
    expect(register.project.reference_scan?.method).toBe("regex");
    expect(register.project.reference_scan?.candidate_count).toBe(3);
    expect(
      register.project_events.filter(
        (event) => event.event === "reference_scan_completed",
      ),
    ).toHaveLength(1);
    expect((await store.verify()).ok).toBe(true);

    // Repeatable: a second scan overwrites the pointer without any guard.
    await store.transaction((tx) => {
      tx.recordReferenceScan({
        sha256: "b".repeat(64),
        blob_path: `blobs/bb/${"b".repeat(64)}.json`,
        method: "regex+llm",
        candidate_count: 7,
        actor: "human:lg",
        reason: "Regel- und LLM-Scan: 7 Kandidat(en) gefunden.",
        at: "2026-08-06T11:00:00Z",
      });
    });
    register = await store.read();
    expect(register.project.reference_scan?.sha256).toBe("b".repeat(64));
    expect(register.project.reference_scan?.method).toBe("regex+llm");
    expect(register.project.reference_scan?.candidate_count).toBe(7);
    expect(
      register.project_events.filter(
        (event) => event.event === "reference_scan_completed",
      ),
    ).toHaveLength(2);
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("RegisterStore.read", () => {
  it("throws CorruptRegisterError on unparseable JSON", async () => {
    fs.writeFileSync(store.claimsPath, "{ kaputt");
    await expect(store.read()).rejects.toThrow(CorruptRegisterError);
  });

  it("throws CorruptRegisterError on schema-invalid content", async () => {
    fs.writeFileSync(
      store.claimsPath,
      JSON.stringify({ schema_version: "1.0.0" }),
    );
    await expect(store.read()).rejects.toThrow(CorruptRegisterError);
  });
});

describe("tampering after persistence", () => {
  it("is detected by verify()", async () => {
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "source_set_frozen",
        reason: "Original.",
        actor: "human:lg",
      });
    });
    const register = JSON.parse(fs.readFileSync(store.claimsPath, "utf8"));
    register.project_events[1].reason = "Nachträglich geändert.";
    fs.writeFileSync(store.claimsPath, JSON.stringify(register, null, 2));
    const result = await store.verify();
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.type)).toContain("hash_mismatch");
  });
});

describe("ChainIntegrityError export", () => {
  it("is a distinct error type", () => {
    expect(new ChainIntegrityError([]).name).toBe("ChainIntegrityError");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Claim } from "../schema/claim";
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

describe("RegisterTransaction.reviseBriefing", () => {
  it("throws when the project has no imported briefing yet", async () => {
    await expect(
      store.transaction((tx) =>
        tx.reviseBriefing({
          sha256: "a".repeat(64),
          blob_path: `blobs/aa/${"a".repeat(64)}.md`,
          tool: "deep-research-x",
          actor: "human:lg",
          reason: "Revision.",
        }),
      ),
    ).rejects.toThrow(/no briefing to revise/);
  });

  it("rotates the current briefing into previous_briefings, advances revision, and appends briefing_revised", async () => {
    await store.transaction((tx) => {
      tx.recordBriefingImport({
        sha256: "a".repeat(64),
        blob_path: `blobs/aa/${"a".repeat(64)}.md`,
        tool: "deep-research-x",
        actor: "human:lg",
        at: "2026-08-06T09:00:00Z",
      });
    });
    await store.transaction((tx) => {
      tx.reviseBriefing({
        sha256: "b".repeat(64),
        blob_path: `blobs/bb/${"b".repeat(64)}.md`,
        tool: "deep-research-x",
        actor: "human:lg",
        reason: "Briefing überarbeitet.",
        at: "2026-08-06T10:00:00Z",
      });
    });
    let register = await store.read();
    expect(register.project.briefing_import?.sha256).toBe("b".repeat(64));
    expect(register.project.briefing_import?.revision).toBe(2);
    expect(register.project.previous_briefings).toHaveLength(1);
    expect(register.project.previous_briefings?.[0]).toMatchObject({
      sha256: "a".repeat(64),
    });
    expect(register.project.previous_briefings?.[0].revision).toBeUndefined();
    expect(register.project_events.map((event) => event.event)).toContain(
      "briefing_revised",
    );
    expect((await store.verify()).ok).toBe(true);

    // A second rotation keeps both prior briefings and advances again.
    await store.transaction((tx) => {
      tx.reviseBriefing({
        sha256: "c".repeat(64),
        blob_path: `blobs/cc/${"c".repeat(64)}.md`,
        tool: "deep-research-x",
        actor: "human:lg",
        reason: "Nochmal überarbeitet.",
        at: "2026-08-06T11:00:00Z",
      });
    });
    register = await store.read();
    expect(register.project.briefing_import?.sha256).toBe("c".repeat(64));
    expect(register.project.briefing_import?.revision).toBe(3);
    expect(register.project.previous_briefings).toHaveLength(2);
    expect(
      register.project_events.filter(
        (event) => event.event === "briefing_revised",
      ),
    ).toHaveLength(2);
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("RegisterTransaction.recordCaptureFailure", () => {
  it("appends a chain-linked source_capture_failed event with the payload", async () => {
    await store.transaction((tx) => {
      tx.recordCaptureFailure({
        work_item_id: "wi_test-1",
        origin: "manual",
        input: {
          kind: "doi",
          source_type: "peer_reviewed_publication",
          identifier: "10.1000/demo.1",
        },
        actor: "system:capture",
        reason: "Dokument nicht abrufbar (HTTP 404).",
        at: "2026-08-13T09:00:00Z",
      });
    });
    const register = await store.read();
    const event = register.project_events.at(-1);
    expect(event).toMatchObject({
      event: "source_capture_failed",
      actor: "system:capture",
      capture_failure: {
        work_item_id: "wi_test-1",
        origin: "manual",
        input: { kind: "doi", identifier: "10.1000/demo.1" },
      },
    });
    expect((await store.verify()).ok).toBe(true);
  });

  it("records per-source extraction attribution via recordProjectEvent's source_id", async () => {
    await store.transaction((tx) => {
      tx.addSource({
        id: "src_attr",
        type: "article-journal",
        custom: { source_type: "preprint" },
      });
      tx.recordProjectEvent({
        event: "batch_run_completed",
        reason: 'Extraktion abgeschlossen – Quelle "src_attr".',
        actor: "system:extraction",
        source_id: "src_attr",
      });
    });
    const register = await store.read();
    const event = register.project_events.at(-1);
    expect(event?.source_id).toBe("src_attr");
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("RegisterTransaction.reviseClaimAnchor / remapClaimAnchor", () => {
  const claimInput = {
    id: "clm_0001",
    text: "LLM-Reviews reduzieren die Reviewzeit.",
    claim_type: "quantitative_finding",
    briefing_anchor: "p12",
    anchor_quote: "reduzieren die Reviewzeit",
    provenance: {
      tool: "deep-research-x",
      model: "drx-1",
      extracted_at: "2026-08-06T08:10:00Z",
      search_path: "Lauf 1",
    },
    evidence: [],
  } as unknown as Omit<Claim, "status" | "history">;

  beforeEach(async () => {
    await store.transaction((tx) => {
      tx.addSource({
        id: "src_meyer2025",
        type: "article-journal",
        title: "Effects of AI Assistants on Code Review Duration",
        custom: { source_type: "peer_reviewed_publication" },
      } as never);
      tx.addClaim({
        claim: claimInput,
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
    });
  });

  it("reviseClaimAnchor sets the new anchor/quote, appends the audited event, and leaves status alone", async () => {
    const before = await store.read();
    const statusBefore = before.claims[0].status;

    const event = await store.transaction((tx) =>
      tx.reviseClaimAnchor("clm_0001", {
        new_anchor: "p14",
        new_quote: "verkürzen die Reviewzeit",
        actor: "human:lg",
        reason: "Textstelle manuell korrigiert.",
      }),
    );
    expect(event.event).toBe("claim_anchor_revised");
    expect(event.anchor_change).toEqual({
      claim_id: "clm_0001",
      previous_anchor: "p12",
      new_anchor: "p14",
      previous_quote: "reduzieren die Reviewzeit",
      new_quote: "verkürzen die Reviewzeit",
    });

    const register = await store.read();
    const claim = register.claims[0];
    expect(claim.briefing_anchor).toBe("p14");
    expect(claim.anchor_quote).toBe("verkürzen die Reviewzeit");
    expect(claim.status).toBe(statusBefore);
    expect((await store.verify()).ok).toBe(true);
  });

  it("reviseClaimAnchor preserves the existing anchor_quote when new_quote is omitted", async () => {
    const event = await store.transaction((tx) =>
      tx.reviseClaimAnchor("clm_0001", {
        new_anchor: "p14",
        actor: "human:lg",
        reason: "Nur Position korrigiert.",
      }),
    );
    expect(event.anchor_change).toEqual({
      claim_id: "clm_0001",
      previous_anchor: "p12",
      new_anchor: "p14",
      previous_quote: "reduzieren die Reviewzeit",
      // new_quote absent: the parameter was omitted, so nothing changed.
    });
    expect(event.anchor_change?.new_quote).toBeUndefined();

    const register = await store.read();
    const claim = register.claims[0];
    expect(claim.briefing_anchor).toBe("p14");
    expect(claim.anchor_quote).toBe("reduzieren die Reviewzeit");
    expect((await store.verify()).ok).toBe(true);
  });

  it("remapClaimAnchor updates the fields silently — no event of its own, chain still verifies", async () => {
    await store.transaction((tx) => {
      tx.remapClaimAnchor("clm_0001", {
        anchor: "p15",
        quote: "neue Formulierung",
      });
    });

    const register = await store.read();
    const claim = register.claims[0];
    expect(claim.briefing_anchor).toBe("p15");
    expect(claim.anchor_quote).toBe("neue Formulierung");
    expect(
      register.project_events.some(
        (event) => event.event === "claim_anchor_revised",
      ),
    ).toBe(false);
    // Content changed without minting an entry of its own: the store's
    // content_updated auto-event keeps the change chain-visible.
    expect(register.project_events.at(-1)?.event).toBe("content_updated");
    expect((await store.verify()).ok).toBe(true);
  });

  it("remapClaimAnchor preserves the existing anchor_quote when quote is omitted", async () => {
    await store.transaction((tx) => {
      tx.remapClaimAnchor("clm_0001", { anchor: "p15" });
    });

    const register = await store.read();
    const claim = register.claims[0];
    expect(claim.briefing_anchor).toBe("p15");
    expect(claim.anchor_quote).toBe("reduzieren die Reviewzeit");
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

describe("RegisterTransaction.setCalibrationResult rotation", () => {
  const claimInput = {
    id: "clm_0001",
    text: "LLM-Reviews reduzieren die Reviewzeit.",
    claim_type: "quantitative_finding",
    briefing_anchor: "p12",
    provenance: {
      tool: "deep-research-x",
      model: "drx-1",
      extracted_at: "2026-08-06T08:10:00Z",
      search_path: "Lauf 1",
    },
    evidence: [],
  } as unknown as Omit<Claim, "status" | "history">;

  beforeEach(async () => {
    await store.transaction((tx) => {
      tx.addClaim({
        claim: claimInput,
        actor: "system:extraction",
        reason: "Extrahiert.",
      });
    });
  });

  async function claim(): Promise<Claim> {
    return (await store.read()).claims[0];
  }

  it("archives nothing on the first write", async () => {
    await store.transaction((tx) => {
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult(
        "clm_0001",
        "licensed",
        "Der Beleg trägt die Aussage.",
        "1.1.0",
      );
    });

    const first = await claim();
    // Absent, not an empty array: the rotation builds the list lazily with
    // `[...(previous ?? []), superseded]`, so a claim judged once carries
    // no archive at all.
    expect(first.previous_calibrations).toBeUndefined();
    expect(first.calibration_prompt_version).toBe("1.1.0");
  });

  it("rotates the whole previous outcome on the second write", async () => {
    await store.transaction((tx) => {
      tx.setSupportDegree("clm_0001", "supported");
      tx.setCalibrationResult(
        "clm_0001",
        "licensed",
        "Der Beleg trägt die Aussage.",
        "1.1.0",
      );
    });
    await store.transaction((tx) => {
      // Deliberately in the production write order — the stage-3 site sets
      // the support degree FIRST. The archived degree must still be the
      // one the transaction opened with, not the one written a line above.
      tx.setSupportDegree("clm_0001", "partially_supported");
      tx.setCalibrationResult(
        "clm_0001",
        "weakened",
        "Jedoch: der Beleg trägt die Aussage nur teilweise.",
        "1.1.0",
      );
    });

    const second = await claim();
    expect(second.previous_calibrations).toHaveLength(1);
    const [archived] = second.previous_calibrations ?? [];
    expect(archived.calibration_result).toBe("licensed");
    expect(archived.calibration_reasoning).toBe("Der Beleg trägt die Aussage.");
    expect(archived.support_degree).toBe("supported");
    expect(archived.calibration_prompt_version).toBe("1.1.0");
    expect(Number.isNaN(Date.parse(archived.superseded_at))).toBe(false);
    // The current fields hold the SECOND outcome.
    expect(second.calibration_result).toBe("weakened");
    expect(second.support_degree).toBe("partially_supported");
    expect((await store.verify()).ok).toBe(true);
  });

  it("keeps a third write's archive in write order", async () => {
    for (const result of [
      "licensed",
      "weakened",
      "pending_adjudication",
    ] as const) {
      await store.transaction((tx) => {
        tx.setCalibrationResult("clm_0001", result, `Begründung ${result}.`);
      });
    }

    const third = await claim();
    expect(
      (third.previous_calibrations ?? []).map(
        (entry) => entry.calibration_result,
      ),
    ).toEqual(["licensed", "weakened"]);
    expect(third.calibration_result).toBe("pending_adjudication");
  });

  it("archives an unstamped original with no version, rather than borrowing the new one", async () => {
    // The pre-extension case: prose written before the stamp existed. Its
    // vintage is genuinely unknown, and inventing one from the project's
    // current pin would be a false record in an append-only file.
    await store.transaction((tx) => {
      tx.setCalibrationResult("clm_0001", "licensed", "Alte Begründung.");
    });
    await store.transaction((tx) => {
      tx.setCalibrationResult(
        "clm_0001",
        "weakened",
        "Neue Begründung.",
        "1.1.0",
      );
    });

    const rotated = await claim();
    const [archived] = rotated.previous_calibrations ?? [];
    expect(archived.calibration_reasoning).toBe("Alte Begründung.");
    expect(archived.calibration_prompt_version).toBeUndefined();
    expect(rotated.calibration_prompt_version).toBe("1.1.0");
  });

  it("rotates even when the second write carries no reasoning of its own", async () => {
    await store.transaction((tx) => {
      tx.setCalibrationResult("clm_0001", "licensed", "Erste Begründung.");
    });
    await store.transaction((tx) => {
      tx.setCalibrationResult("clm_0001", "weakened");
    });

    const rotated = await claim();
    expect(rotated.previous_calibrations).toHaveLength(1);
    expect(rotated.previous_calibrations?.[0].calibration_reasoning).toBe(
      "Erste Begründung.",
    );
    // `reasoning: undefined` still means "leave unchanged" — the archive
    // is what makes the previous prose recoverable, not this field.
    expect(rotated.calibration_reasoning).toBe("Erste Begründung.");
  });
});

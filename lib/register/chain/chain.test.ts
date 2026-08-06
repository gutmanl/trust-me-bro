import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../schema/register";
import exampleProject from "../schema/__fixtures__/example-project.json";
import { ChainAppender, computeEntryHash } from "./appender";
import { genesisPrevHash } from "./genesis";
import { verifyChain } from "./verify";

const identity = {
  id: "proj_test",
  research_question: "Testfrage?",
  created_at: "2026-08-01T00:00:00Z",
};

/**
 * Builds a register whose chain entries were minted by ChainAppender:
 * one project event, one claim with two history entries, one more event.
 */
function buildValidRegister(): ClaimsRegister {
  const base = structuredClone(exampleProject) as unknown as ClaimsRegister;
  base.project = { ...base.project, ...identity };
  base.claims[0].history = [];
  base.project_events = [];

  const appender = new ChainAppender(base);
  base.project_events.push(
    appender.append({
      at: "2026-08-01T08:00:00Z",
      actor: "human:lg",
      event: "project_created",
      reason: "Projekt angelegt.",
    }) as ClaimsRegister["project_events"][number],
  );
  base.claims[0].history.push(
    appender.append({
      at: "2026-08-01T08:10:00Z",
      actor: "system:extraction",
      from_status: null,
      to_status: "erfasst",
      reason: "Aus Briefing extrahiert.",
    }) as ClaimsRegister["claims"][number]["history"][number],
    appender.append({
      at: "2026-08-01T09:00:00Z",
      actor: "system:existence_check",
      from_status: "erfasst",
      to_status: "existenzgeprueft",
      reason: "Alle Fundstellen im eingefrorenen Bestand nachgewiesen.",
    }) as ClaimsRegister["claims"][number]["history"][number],
  );
  base.project_events.push(
    appender.append({
      at: "2026-08-01T09:30:00Z",
      actor: "human:lg",
      event: "source_set_frozen",
      reason: "Bestand eingefroren.",
    }) as ClaimsRegister["project_events"][number],
  );
  // Keep the derived status field consistent with the minted history.
  base.claims[0].status = "existenzgeprueft";
  return base;
}

describe("genesisPrevHash", () => {
  it("is deterministic and depends on exactly the three identity fields", () => {
    const base = genesisPrevHash(identity);
    expect(genesisPrevHash({ ...identity })).toBe(base);
    expect(
      genesisPrevHash({ ...identity, research_question: "Andere Frage?" }),
    ).not.toBe(base);
    expect(genesisPrevHash({ ...identity, id: "proj_other" })).not.toBe(base);
    expect(
      genesisPrevHash({ ...identity, created_at: "2027-01-01T00:00:00Z" }),
    ).not.toBe(base);
    // Mutable project fields must not influence the genesis hash.
    expect(
      genesisPrevHash({
        ...identity,
        source_set_revision: 7,
      } as typeof identity),
    ).toBe(base);
  });
});

describe("computeEntryHash", () => {
  it("hashes canonical(entry without hash) concatenated with prev_hash", () => {
    const prev = "ab".repeat(32);
    const entry = { seq: 1, actor: "human:lg", reason: "x", prev_hash: prev };
    // Independently constructed canonical form (keys sorted by code units).
    const canonical = `{"actor":"human:lg","prev_hash":"${prev}","reason":"x","seq":1}`;
    const expected = createHash("sha256")
      .update(canonical)
      .update(prev)
      .digest("hex");
    expect(computeEntryHash(entry)).toBe(expected);
  });
});

describe("ChainAppender", () => {
  it("starts at seq 1 with the genesis prev_hash on an empty chain", () => {
    const register = buildValidRegister();
    const first = register.project_events[0];
    expect(first.seq).toBe(1);
    expect(first.prev_hash).toBe(genesisPrevHash(identity));
  });

  it("continues from the persisted maximum seq", () => {
    const register = buildValidRegister();
    const appender = new ChainAppender(register);
    const next = appender.append({ note: "n" });
    expect(next.seq).toBe(5);
    expect(next.prev_hash).toBe(register.project_events[1].hash);
  });
});

describe("verifyChain", () => {
  it("accepts a register whose entries were minted by ChainAppender", () => {
    const result = verifyChain(buildValidRegister());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(4);
  });

  it("is independent of array order (orders by seq)", () => {
    const register = buildValidRegister();
    register.project_events.reverse();
    expect(verifyChain(register).ok).toBe(true);
  });

  it("detects modification of an entry", () => {
    const register = buildValidRegister();
    register.claims[0].history[0].reason = "Nachträglich geändert.";
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ type: "hash_mismatch", seq: 2 });
  });

  it("detects removal of a single entry as a gap", () => {
    const register = buildValidRegister();
    register.claims[0].history.splice(1, 1);
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      type: "gap",
      expectedSeq: 3,
      foundSeq: 4,
    });
  });

  it("detects deletion of an entire claim with its history", () => {
    const register = buildValidRegister();
    register.claims.splice(0, 1);
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.type)).toContain("gap");
  });

  it("detects duplicate seq values", () => {
    const register = buildValidRegister();
    register.project_events[1] = {
      ...register.project_events[1],
      seq: register.claims[0].history[1].seq,
    };
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.type)).toContain("duplicate_seq");
  });

  it("detects a changed project identity field as a broken genesis link", () => {
    const register = buildValidRegister();
    register.project = {
      ...register.project,
      research_question: "Neue Frage?",
    };
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      type: "prev_hash_mismatch",
      seq: 1,
    });
  });

  it("rejects an empty chain", () => {
    const register = buildValidRegister();
    register.claims[0].history = [];
    register.project_events = [];
    expect(verifyChain(register).errors).toContainEqual({
      type: "empty_chain",
    });
  });

  it("reports a chain that does not start at seq 1", () => {
    const register = buildValidRegister();
    register.project_events = register.project_events.filter(
      (event) => event.seq !== 1,
    );
    const result = verifyChain(register);
    expect(result.errors.map((error) => error.type)).toContain(
      "missing_seq_start",
    );
  });

  it("detects a status field edited past the chained history", () => {
    const register = buildValidRegister();
    register.claims[0].status = "bestaetigt";
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      type: "status_mismatch",
      claimId: register.claims[0].id,
      status: "bestaetigt",
      lastHistoryStatus: "existenzgeprueft",
    });
  });
});

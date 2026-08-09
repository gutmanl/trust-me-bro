import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../schema/register";
import exampleProject from "../schema/__fixtures__/example-project.json";
import { ChainAppender, computeEntryHash } from "./appender";
import { genesisPrevHash } from "./genesis";
import { computeStateRoot } from "./state-root";
import { verifyChain } from "./verify";

const identity = {
  id: "proj_test",
  research_question: "Testfrage?",
  created_at: "2026-08-01T00:00:00Z",
};

/**
 * Builds a register whose chain entries were minted by ChainAppender:
 * one project event, one claim with two history entries, one more event.
 * Unsealed — the entries carry no state_root, i.e. the register looks like
 * a legacy file from before the state-root extension.
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
      to_status: "captured",
      reason: "Aus Briefing extrahiert.",
    }) as ClaimsRegister["claims"][number]["history"][number],
    appender.append({
      at: "2026-08-01T09:00:00Z",
      actor: "system:existence_check",
      from_status: "captured",
      to_status: "existence_checked",
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
  base.claims[0].status = "existence_checked";
  return base;
}

/** Like buildValidRegister, but sealed the way the store seals at commit:
 * every entry carries the state root of the finished register. */
function buildSealedRegister(): ClaimsRegister {
  const base = structuredClone(exampleProject) as unknown as ClaimsRegister;
  base.project = { ...base.project, ...identity };
  base.claims[0].history = [];
  base.project_events = [];
  base.claims[0].status = "existence_checked";

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
      to_status: "captured",
      reason: "Aus Briefing extrahiert.",
    }) as ClaimsRegister["claims"][number]["history"][number],
    appender.append({
      at: "2026-08-01T09:00:00Z",
      actor: "system:existence_check",
      from_status: "captured",
      to_status: "existence_checked",
      reason: "Alle Fundstellen im eingefrorenen Bestand nachgewiesen.",
    }) as ClaimsRegister["claims"][number]["history"][number],
  );
  appender.seal(base);
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
    register.claims[0].status = "confirmed";
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      type: "status_mismatch",
      claimId: register.claims[0].id,
      status: "confirmed",
      lastHistoryStatus: "existence_checked",
    });
  });
});

describe("state root (content replay)", () => {
  it("seals every entry of a transaction with the same state root", () => {
    const register = buildSealedRegister();
    const roots = [
      ...register.project_events.map((event) => event.state_root),
      ...register.claims[0].history.map((entry) => entry.state_root),
    ];
    expect(roots).toHaveLength(3);
    expect(new Set(roots).size).toBe(1);
    expect(roots[0]).toBe(computeStateRoot(register));
    expect(verifyChain(register)).toMatchObject({ ok: true, errors: [] });
  });

  const tamper: [string, (register: ClaimsRegister) => void][] = [
    ["claim text", (r) => void (r.claims[0].text = "Ganz anderer Claim.")],
    [
      "verbatim excerpt",
      (r) => void (r.claims[0].evidence[0].verbatim_excerpt = "…anderes…"),
    ],
    [
      "resolved relation",
      (r) => void (r.claims[0].evidence[0].relation_type = "contradicts"),
    ],
    [
      "judgment confidence",
      (r) => void (r.claims[0].evidence[0].judgments[0].confidence = 0.01),
    ],
    [
      "support degree",
      (r) => void (r.claims[0].support_degree = "unsupported"),
    ],
    [
      "calibration result",
      (r) => void (r.claims[0].calibration_result = "weakened"),
    ],
    [
      "source title",
      (r) => void ((r.sources[0] as { title?: string }).title = "Anders"),
    ],
    [
      "snapshot retrieval time",
      (r) =>
        void (r.sources[0].custom.snapshot!.retrieved_at =
          "2027-01-01T00:00:00Z"),
    ],
    ["configuration", (r) => void (r.config.adjudication_sample_rate = 0.99)],
    ["source set revision", (r) => void (r.project.source_set_revision = 7)],
  ];

  for (const [label, mutate] of tamper) {
    it(`detects a tampered ${label} in a sealed register`, () => {
      const register = buildSealedRegister();
      mutate(register);
      const result = verifyChain(register);
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual({
        type: "state_root_mismatch",
        seq: 3,
      });
    });
  }

  it("cannot be downgraded by stripping the newest state_root", () => {
    const register = buildSealedRegister();
    delete register.claims[0].history[1].state_root;
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ type: "hash_mismatch", seq: 3 });
  });

  it("skips the content check for legacy registers without state_root", () => {
    const register = buildValidRegister();
    register.claims[0].text = "Unbemerkt geändert.";
    // Documented boundary: entries from before the extension cannot commit
    // content — the chain stays formally valid, only status is replayed.
    expect(verifyChain(register).ok).toBe(true);
  });

  it("re-verifies after a sealed follow-up transaction on a legacy chain", () => {
    const register = buildValidRegister();
    const appender = new ChainAppender(register);
    register.project_events.push(
      appender.append({
        at: "2026-08-02T08:00:00Z",
        actor: "human:lg",
        event: "config_changed",
        reason: "Konfiguration geändert.",
        config_change: {
          previous: structuredClone(register.config),
          next: structuredClone(register.config),
        },
      }) as ClaimsRegister["project_events"][number],
    );
    appender.seal(register);
    expect(verifyChain(register).ok).toBe(true);
    register.claims[0].text = "Jetzt nicht mehr unbemerkt.";
    const result = verifyChain(register);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      type: "state_root_mismatch",
      seq: 5,
    });
  });
});

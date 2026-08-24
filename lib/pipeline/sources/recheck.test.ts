/**
 * The compensating pin for the widened `pending_adjudication →
 * recheck_required` gate (reviewer-triggered re-verification).
 *
 * The gate used to admit only `existence_check_failed` routings, so
 * `sweepSourceRecheck`'s "source correction only readmits claims stuck on
 * the source's wrong identity" scope survived by CONSTRUCTION. The gate now
 * admits any machine routing, and that scope survives only through this
 * function's own filter — which nothing pinned, because
 * tests/architecture.test.ts maps edges as `{from, to, actorKind, decision}`
 * and carries no `gate` key. These cases are that pin.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import type { RegisterTransaction } from "../../register";
import { createProject } from "../projects";
import { fakeFetcher } from "./__fixtures__/fake-fetcher";
import { captureSource } from "./capture";
import { sweepSourceRecheck } from "./recheck";

const PROJECT = "proj_recheck_sweep";
const AT = "2026-08-24T12:00:00Z";

let workspace: string;
let sourceId: string;
let otherSourceId: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-recheck-sweep-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
  const source = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Bericht", year: "2026" },
      upload: {
        content: Buffer.from("Die Reviewzeit sank."),
        filename: "a.txt",
      },
    },
    { fetcher: fakeFetcher({}) },
  );
  sourceId = source.id;
  const other = await captureSource(
    {
      projectId: PROJECT,
      kind: "upload",
      sourceType: "grey_literature",
      manual: { title: "Anderer Bericht", year: "2026" },
      upload: { content: Buffer.from("Etwas anderes."), filename: "b.txt" },
    },
    { fetcher: fakeFetcher({}) },
  );
  otherSourceId = other.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

let nextClaim = 0;

/** Mints a claim on `onSource` and walks it through the REAL gates into
 * `pending_adjudication` with the requested machine routing. The two paths
 * differ in more than the routing string — the existence-check one never
 * reaches stage 2 — so they are walked, not fabricated. */
async function addParkedClaim(options: {
  routing: "existence_check_failed" | "negative_precheck";
  onSource?: string;
}): Promise<string> {
  nextClaim += 1;
  const claimId = `clm_${String(nextClaim).padStart(4, "0")}`;
  const evidenceId = `ev_${String(nextClaim).padStart(4, "0")}`;
  await RegisterStore.forProject(PROJECT).transaction((tx) => {
    tx.addClaim({
      claim: {
        id: claimId,
        text: `Die Reviewzeit sank messbar (${nextClaim}).`,
        claim_type: "quantitative_finding",
        briefing_anchor: `p${nextClaim}`,
        provenance: {
          tool: "test",
          model: "test",
          extracted_at: AT,
          search_path: "Test",
        },
        evidence: [
          {
            id: evidenceId,
            source_id: options.onSource ?? sourceId,
            locator: { page: 1 },
            verbatim_excerpt: "Reviewzeit sank",
            judgments: [],
          },
        ],
      },
      actor: "system:extraction",
      reason: "Testclaim erzeugt.",
    });
    if (options.routing === "existence_check_failed") {
      tx.setExistenceCheck(claimId, evidenceId, { status: "failed", at: AT });
      tx.transitionClaim(claimId, {
        to: "pending_adjudication",
        actor: "system:existence_check",
        reason: "Zitat im Dokument nicht auffindbar.",
        routing: "existence_check_failed",
      });
      return;
    }
    tx.setExistenceCheck(claimId, evidenceId, { status: "passed", at: AT });
    tx.transitionClaim(claimId, {
      to: "existence_checked",
      actor: "system:existence_check",
      reason: "Zitat nachgewiesen.",
    });
    tx.appendJudgment(claimId, evidenceId, {
      backend: "claude",
      model: "test",
      relation_type: "supports",
      confidence: 0.9,
      reasoning: "Deckt sich mit dem Auszug.",
      at: AT,
    });
    tx.setResolvedRelation(claimId, evidenceId, "supports");
    tx.setSupportDegree(claimId, "supported");
    // Not `licensed`, so notAutoConfirmable admits the routing edge — this
    // is the rubric-complaint park the widened gate now admits and the
    // sweep must nonetheless leave alone.
    tx.setCalibrationResult(claimId, "weakened", "Beleg trägt nur teilweise.");
    tx.transitionClaim(claimId, {
      to: "prechecked",
      actor: "system:precheck",
      reason: "Stufen 2/3 abgeschlossen.",
    });
    tx.transitionClaim(claimId, {
      to: "pending_adjudication",
      actor: "system:precheck",
      reason: "Nicht automatisch bestätigbar: Bewertungsschema.",
      routing: "negative_precheck",
    });
  });
  return claimId;
}

async function sweep(includeExistenceCheckRouting: boolean): Promise<string[]> {
  let selected: string[] = [];
  await RegisterStore.forProject(PROJECT).transaction(
    (tx: RegisterTransaction) => {
      selected = sweepSourceRecheck(tx, sourceId, {
        // Every `* → recheck_required` edge is system-only; the correction
        // path writes under its own token.
        actor: "system:source_correction",
        at: AT,
        reason: "Quellenkennung korrigiert – Prüfung wird wiederholt.",
        includeExistenceCheckRouting,
      });
    },
  );
  return selected;
}

describe("sweepSourceRecheck", () => {
  it("readmits ONLY the existence-check park, never the rubric-complaint park", async () => {
    const rubricComplaint = await addParkedClaim({
      routing: "negative_precheck",
    });
    const existenceFailure = await addParkedClaim({
      routing: "existence_check_failed",
    });

    // Both claims cite the corrected source and both now satisfy the
    // WIDENED transition gate. The narrow selection is the sweep's own
    // filter, and only an exact-set comparison proves it — a length check
    // passes just as happily if the wrong claim were picked.
    const selected = await sweep(true);
    expect(selected).toEqual([existenceFailure]);
    expect(selected).not.toContain(rubricComplaint);

    const register = await RegisterStore.forProject(PROJECT).read();
    const stillParked = register.claims.find((c) => c.id === rubricComplaint);
    expect(stillParked?.status).toBe("pending_adjudication");
  });

  it("readmits neither park without the opt-in", async () => {
    await addParkedClaim({ routing: "negative_precheck" });
    await addParkedClaim({ routing: "existence_check_failed" });
    expect(await sweep(false)).toEqual([]);
  });

  it("does not reach a machine-parked claim on a different source", async () => {
    const onOtherSource = await addParkedClaim({
      routing: "existence_check_failed",
      onSource: otherSourceId,
    });
    const onThisSource = await addParkedClaim({
      routing: "existence_check_failed",
    });
    const selected = await sweep(true);
    expect(selected).toEqual([onThisSource]);
    expect(selected).not.toContain(onOtherSource);
  });
});

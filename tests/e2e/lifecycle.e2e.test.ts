/**
 * End-to-end test of the register core: one project walked from creation
 * through freezing, extraction, all verification stages, sampling, human
 * adjudication and the repair loop, down to the rendered projection and the
 * REAL tmb-verify CLI running as a separate process against the resulting
 * directory. If any module composition breaks, this test breaks — it is the
 * epic's definition of done in executable form.
 */
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Ajv2020 } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RegisterStore } from "../../lib/register";
import type { ProjectConfig } from "../../lib/register";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
// The compiled artifact, not the TypeScript source: this is what the tarball
// ships as the `tmb` bin, so the test proves the thing users actually run.
// dist/cli/tmb.js is invoked directly rather than through the `tmb` shim —
// that sidesteps Windows .cmd quoting while exercising the same file.
const compiledCli = path.join(repoRoot, "dist", "cli", "tmb.js");

const config: ProjectConfig = {
  rubric_version: "se-evidence-rubric-v1",
  adjudication_sample_rate: 0.1,
  backends: {
    primary: { cli: "claude", model_family: "anthropic" },
    secondary: { cli: "codex", model_family: "openai" },
  },
};

const BRIEFING = [
  "LLM-gestützte Code-Reviews verändern den Reviewprozess.",
  "Die mediane Reviewzeit sinkt laut einer Studie um 55 %.",
  "Manche Aussagen des Briefings sind bislang unbelegt.",
].join("\n\n");

let projectDir: string;
let store: RegisterStore;

// `npx vitest run <path>` bypasses npm lifecycle hooks, so the build has to
// happen here. `incremental: true` keeps repeat runs near-instant.
beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "build-cli.mjs")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error("CLI build failed");
  }
}, 180_000);

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-e2e-"));
  store = RegisterStore.atDirectory(projectDir);
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

async function runCli(dir: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [compiledCli, "verify", dir],
      { cwd: repoRoot },
    );
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "" };
  }
}

describe("full project lifecycle", () => {
  it(
    "walks creation → freeze → verification → adjudication → repair → projection → CLI verify",
    { timeout: 120_000 },
    async () => {
      // 1. Create the project and freeze briefing + source snapshot.
      await store.create({
        id: "proj_e2e",
        research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
        config,
        actor: "human:lg",
        at: "2026-08-06T08:00:00Z",
      });
      const blobs = store.blobs();
      const briefingBlob = blobs.put(BRIEFING, "md");
      const snapshotBlob = blobs.put("PDF-Bytes der Studie", "pdf");
      const textBlob = blobs.put(
        "median review time dropped from 42 to 19 minutes",
        "txt",
      );

      await store.transaction((tx) => {
        tx.recordBriefingImport({
          sha256: briefingBlob.sha256,
          blob_path: briefingBlob.blobPath,
          tool: "deep-research-x",
          actor: "human:lg",
          at: "2026-08-06T08:01:00Z",
        });
        tx.addSource({
          id: "src_meyer2025",
          type: "article-journal",
          title: "Effects of AI Assistants on Code Review Duration",
          custom: {
            source_type: "peer_reviewed_publication",
            snapshot: {
              retrieved_at: "2026-08-06T08:02:00Z",
              sha256: snapshotBlob.sha256,
              blob_path: snapshotBlob.blobPath,
              text_blob_path: textBlob.blobPath,
              revision: 1,
            },
          },
        } as never);
        tx.recordProjectEvent({
          event: "source_set_frozen",
          reason: "Initialer Import, 1 Quelle, Revision 1.",
          actor: "human:lg",
          at: "2026-08-06T08:03:00Z",
        });
      });

      // 2. Extraction: one supported claim, one claim without evidence.
      await store.transaction((tx) => {
        tx.addClaim({
          claim: {
            id: "clm_0001",
            text: "LLM-Reviews reduzieren die mediane Reviewzeit um 55 %.",
            claim_type: "quantitative_finding",
            briefing_anchor: "p2",
            provenance: {
              tool: "deep-research-x",
              model: "drx-1",
              extracted_at: "2026-08-06T08:10:00Z",
              search_path: "Lauf 1",
            },
            evidence: [
              {
                id: "ev_0001",
                source_id: "src_meyer2025",
                locator: { page: 6 },
                verbatim_excerpt:
                  "median review time dropped from 42 to 19 minutes",
                judgments: [],
              },
            ],
          },
          actor: "system:extraction",
          reason: "Aus Briefing-Absatz p2 erfasst.",
          at: "2026-08-06T08:10:00Z",
        });
        tx.addClaim({
          claim: {
            id: "clm_0002",
            text: "Langfristig steigt die Codequalität.",
            claim_type: "effectiveness_statement",
            briefing_anchor: "p3",
            provenance: {
              tool: "deep-research-x",
              model: "drx-1",
              extracted_at: "2026-08-06T08:10:30Z",
              search_path: "Lauf 1",
            },
            evidence: [],
          },
          actor: "system:extraction",
          reason: "Keine Fundstelle extrahierbar.",
          at: "2026-08-06T08:10:30Z",
        });
      });

      // 3. Stages 1–3 plus the adjudication gate for the supported claim.
      await store.transaction((tx) => {
        tx.setExistenceCheck("clm_0001", "ev_0001", {
          status: "passed",
          at: "2026-08-06T09:00:00Z",
        });
        tx.transitionClaim("clm_0001", {
          to: "existence_checked",
          actor: "system:existence_check",
          reason: "Wortlaut im eingefrorenen Volltext nachgewiesen.",
          at: "2026-08-06T09:00:01Z",
        });
        tx.appendJudgment("clm_0001", "ev_0001", {
          backend: "claude",
          model: "claude-sonnet-5",
          relation_type: "supports",
          confidence: 0.93,
          reasoning: "Zahlenwert und Richtung stimmen überein.",
          at: "2026-08-06T09:05:00Z",
        });
        tx.appendJudgment("clm_0001", "ev_0001", {
          backend: "codex",
          model: "codex-2",
          relation_type: "supports",
          confidence: 0.88,
          reasoning: "Auszug deckt die Aussage.",
          at: "2026-08-06T09:06:00Z",
        });
        tx.setResolvedRelation("clm_0001", "ev_0001", "supports");
        tx.setSupportDegree("clm_0001", "supported");
        tx.setCalibrationResult("clm_0001", "licensed");
        tx.transitionClaim("clm_0001", {
          to: "prechecked",
          actor: "system:attribution",
          reason: "Stufe 2 und 3 abgeschlossen.",
          at: "2026-08-06T09:10:00Z",
        });
        tx.transitionClaim("clm_0001", {
          to: "auto_confirmed",
          actor: "system:adjudication_gate",
          reason:
            "Durchgehend positiv, keine Divergenz, Bewertung freigegeben.",
          at: "2026-08-06T09:10:01Z",
        });
      });

      // 4. Sampling pulls the auto-confirmed claim; the human confirms it.
      await store.transaction((tx) => {
        tx.transitionClaim("clm_0001", {
          to: "pending_adjudication",
          actor: "system:spot_check",
          reason: "Stichprobenkontrolle (Rate 0.1).",
          at: "2026-08-06T10:00:00Z",
        });
        tx.transitionClaim("clm_0001", {
          to: "confirmed",
          actor: "human:lg",
          reason: "Fundstelle und Zahlenwert im Snapshot verifiziert.",
          at: "2026-08-06T10:02:00Z",
          decision: {
            categories: [],
            reviewed_evidence_ids: ["ev_0001"],
            duration_s: 96,
          },
        });
      });

      // 5. The unsupported claim goes through complaint, repair and discard.
      await store.transaction((tx) => {
        tx.transitionClaim("clm_0002", {
          to: "contested",
          actor: "human:lg",
          reason: "Keine Fundstelle vorhanden.",
          at: "2026-08-06T10:10:00Z",
          decision: {
            categories: ["wording_not_in_source"],
            reviewed_evidence_ids: [],
            duration_s: 40,
          },
        });
        tx.transitionClaim("clm_0002", {
          to: "revised",
          actor: "system:repair",
          reason: "Reparaturvorschlag erzeugt.",
          at: "2026-08-06T10:11:00Z",
        });
        tx.transitionClaim("clm_0002", {
          to: "pending_adjudication",
          actor: "system:repair",
          reason: "Reparatur ohne belastbare Fundstelle, eskaliert.",
          at: "2026-08-06T10:12:00Z",
        });
        tx.transitionClaim("clm_0002", {
          to: "contested",
          actor: "human:lg",
          reason: "Weiterhin unbelegt.",
          at: "2026-08-06T10:13:00Z",
          decision: {
            categories: ["wording_not_in_source"],
            reviewed_evidence_ids: [],
            duration_s: 20,
          },
        });
        tx.transitionClaim("clm_0002", {
          to: "discarded",
          actor: "human:lg",
          reason: "Nicht reparierbar; verbleibt mit Begründung im Register.",
          at: "2026-08-06T10:14:00Z",
        });
      });

      // 6. Register invariants: chain valid, claims never deleted, gapless.
      const register = await store.read();
      expect(register.claims).toHaveLength(2);
      expect(register.claims.map((claim) => claim.status)).toEqual([
        "confirmed",
        "discarded",
      ]);
      const verification = await store.verify();
      expect(verification.errors).toEqual([]);
      expect(verification.ok).toBe(true);

      // 7. The on-disk file validates against the COMMITTED JSON Schema —
      // zod model, generated schema and written artifact stay one system.
      const ajv = new Ajv2020({ strict: false });
      addFormats(ajv);
      const committedSchema = JSON.parse(
        fs.readFileSync(
          path.join(repoRoot, "schema", "claims.schema.json"),
          "utf8",
        ),
      );
      const validate = ajv.compile(committedSchema);
      const onDisk = JSON.parse(fs.readFileSync(store.claimsPath, "utf8"));
      expect(validate(onDisk), JSON.stringify(validate.errors)).toBe(true);

      // 8. Project directory matches the normative layout.
      expect(fs.existsSync(path.join(projectDir, "claims.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(projectDir, "schema", "claims.schema.json")),
      ).toBe(true);
      expect(fs.existsSync(blobs.resolve(briefingBlob.blobPath))).toBe(true);
      expect(fs.existsSync(blobs.resolve(snapshotBlob.blobPath))).toBe(true);

      // 9. Projection: deterministic, status-annotated briefing.md.
      const rendered = await store.renderBriefingFile();
      expect(
        fs.readFileSync(path.join(projectDir, "briefing.md"), "utf8"),
      ).toBe(rendered);
      expect(rendered).toContain(
        "GEPRÜFT – keine Aussage zur manuellen Überprüfung offen",
      );
      expect(rendered).toContain("bestätigt (manuell überprüft)");
      expect(rendered).toContain("NICHT BESTÄTIGT – Status: verworfen");
      expect(await store.renderBriefingFile()).toBe(rendered);

      // 10. The standalone CLI, as a real child process, agrees.
      const good = await runCli(projectDir);
      expect(good.stdout).toContain("gapless");
      expect(good.code).toBe(0);

      // 11. Tampering is caught by the same CLI: silently "confirming" a
      // discarded claim must fail verification.
      const tampered = JSON.parse(fs.readFileSync(store.claimsPath, "utf8"));
      tampered.claims[1].status = "confirmed";
      fs.writeFileSync(store.claimsPath, JSON.stringify(tampered, null, 2));
      const bad = await runCli(projectDir);
      expect(bad.code).toBe(1);
      expect(bad.stdout).toContain("status_mismatch");
    },
  );
});

import fs from "node:fs";
import path from "node:path";

import { resolveProjectDir } from "../../identity";
import type { ActorId } from "../../identity/types";
import { ChainAppender, allChainEntries } from "../chain/appender";
import { computeStateRoot } from "../chain/state-root";
import { verifyChain } from "../chain/verify";
import type { ChainVerificationResult } from "../chain/verify";
import { createBlobStore } from "../blobs/store";
import type { BlobStore } from "../blobs/store";
import type { Claim } from "../schema/claim";
import type { ProjectEventType } from "../schema/enums";
import type { ProjectEvent } from "../schema/history";
import type { ProjectConfig } from "../schema/project";
import { ClaimsRegister, SCHEMA_VERSION } from "../schema/register";
import type { Source } from "../schema/source";
import { writeFileAtomic } from "./atomic-write";
import {
  ChainIntegrityError,
  CorruptRegisterError,
  RegisterIntegrityError,
  RegisterValidationError,
} from "./errors";
import { withProjectLock } from "./lock";
import { findIntegrityProblems } from "./validate";
import { renderBriefing } from "../projection/render-briefing";
import type { BriefingRenderContext } from "../projection/render-briefing";
import { toPlainCsl } from "../projection/csl";
import {
  adoptClaim,
  applyTransition,
  createClaim,
} from "../statemachine/engine";
import type { TransitionRequest } from "../statemachine/engine";
import type { Evidence, Judgment } from "../schema/evidence";
import type { SourceSnapshot } from "../schema/source";
import type {
  CalibrationResult,
  RelationType,
  SourceType,
  SupportDegree,
} from "../schema/enums";
import type { CaptureFailureInput, HistoryEntry } from "../schema/history";
import {
  buildRegisterJsonSchema,
  serializeJsonSchema,
} from "../schema/json-schema";

import type { z } from "zod";

/**
 * Capability surface handed to a transaction mutator. Deliberately narrow:
 * there is no way to obtain the mutable register or the chain appender, no
 * delete operation exists, and inputs are committed only after full
 * validation. Claim status transitions arrive with the status machine
 * (TMB-14) and are added here as the sole status-changing capability.
 */
export interface RegisterTransaction {
  /** Read-only snapshot accessors (clones — mutating them changes nothing). */
  getProject(): ClaimsRegister["project"];
  getConfig(): ProjectConfig;
  listSources(): Source[];
  listClaims(): Claim[];
  /** Read-only snapshot of the project events, e.g. for workflow
   * preconditions that must be checked inside the transaction. */
  listProjectEvents(): ProjectEvent[];
  getClaim(claimId: string): Claim;
  /** Adds a source entry (CSL-JSON item with `custom` block). Validated with
   * everything else at commit. */
  addSource(source: Source): void;
  /** Appends a project-wide event with its chain link. `source_id` (per-
   * source extraction attribution) and `work_item_id` (capture-failure
   * dismissal) are optional plain scalars riding the generic appender,
   * unlike the structured payloads that get capabilities of their own
   * (source work items). */
  recordProjectEvent(input: {
    event: ProjectEventType;
    reason: string;
    actor: ActorId;
    source_id?: string;
    work_item_id?: string;
    at?: string;
  }): ProjectEvent;
  /**
   * Records one failed source-capture attempt (source work items): appends a
   * `source_capture_failed` event carrying the work-item id, origin and the
   * retryable input snapshot — the durable "why did this not import" that
   * the volatile run log cannot provide across restarts. Mirrors
   * `reviseClaimAnchor`'s shape: mint one chain-linked event, no other
   * mutation.
   */
  recordCaptureFailure(input: {
    work_item_id: string;
    origin: "manual" | "reference_import" | "correction";
    input: CaptureFailureInput;
    actor: ActorId;
    reason: string;
    at?: string;
  }): ProjectEvent;
  /**
   * Records the one-time briefing import: freezes the reference to the
   * original briefing blob and appends the briefing_imported event. The
   * original is the input extraction is measured against, so re-import is
   * rejected (a revision workflow is a later epic).
   */
  recordBriefingImport(input: {
    sha256: string;
    blob_path: string;
    tool: string;
    actor: ActorId;
    at?: string;
  }): void;
  /**
   * Records a reference scan of the frozen briefing (reference auto-import):
   * sets the `reference_scan` pointer to the scan's result blob and appends
   * the `reference_scan_completed` event. Unlike `recordBriefingImport`,
   * REPEATABLE — the pointer is simply overwritten and there is no
   * already-scanned guard, because re-scanning after briefing edits (or to
   * pick up newly captured sources) is expected, not exceptional.
   */
  recordReferenceScan(input: {
    sha256: string;
    blob_path: string;
    method: "regex" | "regex+llm";
    candidate_count: number;
    actor: ActorId;
    reason: string;
    at?: string;
  }): void;
  /**
   * Creates a claim through the extraction gate: initial status is decided by
   * the evidence-completeness gate (evidence → captured, none → pending
   * adjudication), never by the caller.
   */
  addClaim(input: {
    claim: Omit<Claim, "status" | "history">;
    actor: ActorId;
    reason: string;
    at?: string;
  }): Claim;
  /**
   * Creates an adopted claim of a warm run (TMB-43) directly in its settled
   * origin status. The adoption edges' gate requires
   * provenance.origin_project_id, so extraction can never take this path.
   */
  adoptClaim(input: {
    claim: Omit<Claim, "status" | "history">;
    targetStatus: "confirmed" | "auto_confirmed" | "discarded";
    actor: ActorId;
    reason: string;
    at?: string;
  }): Claim;
  /**
   * Rotates a frozen source's snapshot to a new revision (TMB-44): the
   * superseded snapshot moves to previous_snapshots (never lost), the new
   * one becomes current, and the project-wide source_set_revision advances.
   * The caller is responsible for the checksum-identical short-circuit —
   * this capability, once invoked, always performs a revision.
   */
  reviseSource(sourceId: string, snapshot: SourceSnapshot): void;
  /**
   * Replaces a source's bibliographic core on the SAME id (source
   * correction): the superseded plain CSL core moves to
   * `custom.previous_identities` (with its identifier verification), the
   * new item's fields become the source's own, `identifier_verified` is
   * RE-STAMPED wholesale (omitting it clears an earlier stamp, matching
   * captureSource's url/upload semantics) and `correction_attempt_id`
   * records the correcting work item. Everything else in `custom` —
   * snapshot history, `auto_capture` first-entry provenance,
   * `capture_attempt_id` — carries forward untouched; pair with
   * `reviseSource` in the same transaction for the document rotation.
   * Returns the superseded and the new plain core for the caller's
   * `recordIdentityCorrection` payload.
   */
  correctSourceIdentity(
    sourceId: string,
    input: {
      item: Record<string, unknown>;
      replacedAt: string;
      identifierVerified?: { status: boolean; at: string };
      correctionAttemptId: string;
      sourceType?: SourceType;
    },
  ): {
    previousItem: Record<string, unknown>;
    newItem: Record<string, unknown>;
  };
  /**
   * Records the correction's audit event (source correction): appends
   * `source_identity_corrected` carrying the full before/after core —
   * mirrors `updateConfig`'s shape for a structured, payload-bearing event.
   */
  recordIdentityCorrection(input: {
    source_id: string;
    previous_item: Record<string, unknown>;
    new_item: Record<string, unknown>;
    snapshot_revision: { from: number; to: number };
    recheck_claim_ids: string[];
    actor: ActorId;
    reason: string;
    at?: string;
  }): ProjectEvent;
  /**
   * Rotates the briefing to a new revision (briefing revision workflow,
   * mirror of `reviseSource`): the current `briefing_import` moves to
   * `previous_briefings` (never lost), the new one becomes current with
   * `revision` advanced by one, and the `briefing_revised` event is
   * appended. The caller provides the already-stored blob reference — this
   * capability does not touch the blob store.
   */
  reviseBriefing(input: {
    sha256: string;
    blob_path: string;
    tool: string;
    actor: ActorId;
    reason: string;
    at?: string;
  }): void;
  /**
   * Manual, audited anchor correction (workbench epic): sets the claim's
   * `briefing_anchor`/`anchor_quote` and appends a `claim_anchor_revised`
   * project event carrying the before/after pair. `new_quote` is optional —
   * omitting it leaves the claim's current `anchor_quote` unchanged (not
   * cleared). Does NOT touch `claim.status` — an anchor correction is not a
   * verification outcome.
   */
  reviseClaimAnchor(
    claimId: string,
    input: {
      new_anchor: string;
      new_quote?: string;
      actor: ActorId;
      reason: string;
      at?: string;
    },
  ): ProjectEvent;
  /**
   * Silent mechanical remap used by the briefing-revision re-anchor pass
   * (workbench epic): updates `briefing_anchor`/`anchor_quote` without an
   * event of its own — the enclosing `briefing_revised` transaction's state
   * root covers it (the store's `content_updated` auto-event applies when
   * this is the transaction's only change). `quote` is optional — omitting
   * it leaves the claim's current `anchor_quote` unchanged (not cleared).
   */
  remapClaimAnchor(
    claimId: string,
    update: { anchor: string; quote?: string },
  ): void;
  /**
   * Replaces the project configuration (TMB-46) and appends the
   * config_changed event carrying the complete before/after pair — the sole
   * way to change config; a change past the audit trail is impossible.
   */
  updateConfig(input: {
    config: ProjectConfig;
    actor: ActorId;
    reason: string;
    at?: string;
  }): ProjectEvent;
  /**
   * The sole status-changing capability: checks edge, gate and decision
   * requirement, then appends exactly one chain-linked history entry.
   */
  transitionClaim(claimId: string, request: TransitionRequest): HistoryEntry;
  /** Adds evidence to a claim (repair: alternative evidence). */
  addEvidence(claimId: string, evidence: Evidence): void;
  /**
   * Rewrites the claim wording during the repair loop (TMB-37). The previous
   * wording is never lost: the caller records it in the accompanying
   * `contested → revised` transition's `revision` field.
   */
  reviseClaimText(claimId: string, newText: string): void;
  /** Records the stage-1 existence result for one piece of evidence. */
  setExistenceCheck(
    claimId: string,
    evidenceId: string,
    result: { status: "passed" | "failed"; at: string },
  ): void;
  /** Appends a backend judgment; existing judgments are never overwritten. */
  appendJudgment(claimId: string, evidenceId: string, judgment: Judgment): void;
  /** Sets the resolved relation of one piece of evidence (stage 2 result or
   * adjudication resolution on divergence). */
  setResolvedRelation(
    claimId: string,
    evidenceId: string,
    relation: RelationType,
  ): void;
  /** Sets the claim's aggregated support degree (stage 2 result). */
  setSupportDegree(claimId: string, degree: SupportDegree): void;
  /** Sets the claim's stage-3 calibration outcome (SE-Evidenz-Rubrik). */
  setCalibrationResult(claimId: string, result: CalibrationResult): void;
}

/**
 * Scratch briefing draft (workbench epic): the workbench's unsaved edit of
 * the briefing text, persisted so a page reload does not lose it. Lives in
 * `briefing.draft.json` next to `claims.json`, written via the same atomic
 * helper — but deliberately OUTSIDE the register: it carries no chain
 * entry, is not schema-validated, and is not part of `claims.json` (so it
 * never appears in an export bundle, which builds its file list explicitly
 * rather than scanning the project directory). `publishBriefingRevision`
 * clears it once its text has actually become a briefing revision.
 */
export interface BriefingDraft {
  text: string;
  /** ISO timestamp of the save. */
  saved_at: string;
  /** The briefing revision (0 before any briefing exists) the draft's text
   * was started from. Recorded for future conflict detection — nothing
   * currently compares it against the live revision, so it is informational:
   * publishing a draft written against an older revision is not refused or
   * flagged today. */
  based_on_revision: number;
}

export interface CreateProjectParams {
  id: string;
  research_question: string;
  config: ProjectConfig;
  actor: ActorId;
  /** ISO timestamp; defaults to now. Becomes the immutable created_at. */
  at?: string;
}

/** Internal shape of a running transaction: the mutable draft plus the
 * transaction's chain appender. Never leaves this module. */
interface TransactionInternals {
  draft: z.infer<typeof ClaimsRegister>;
  chain: ChainAppender;
}

const CLAIMS_FILE = "claims.json";

function serializeRegister(register: ClaimsRegister): string {
  // Two-space indent + trailing newline: stable, line-oriented formatting so
  // register changes appear as readable, local git diffs (F3).
  return `${JSON.stringify(register, null, 2)}\n`;
}

/**
 * The single write path for a project's claims.json. Every mutation runs
 * under the project lock as: fresh read → mutate via capabilities → validate
 * (schema, referential integrity, hash chain) → atomic write. A failing step
 * leaves the file untouched.
 */
export class RegisterStore {
  private constructor(readonly projectDir: string) {}

  /** Store for a project below the identity workspace root. */
  static forProject(projectId: string): RegisterStore {
    return new RegisterStore(resolveProjectDir(projectId));
  }

  /** Store for an explicit directory (tests, bundle import, CLI). */
  static atDirectory(projectDir: string): RegisterStore {
    return new RegisterStore(path.resolve(projectDir));
  }

  get claimsPath(): string {
    return path.join(this.projectDir, CLAIMS_FILE);
  }

  exists(): boolean {
    return fs.existsSync(this.claimsPath);
  }

  blobs(): BlobStore {
    return createBlobStore(this.projectDir);
  }

  /** Initializes a project directory with a fresh register whose first chain
   * entry is the project_created event. */
  async create(params: CreateProjectParams): Promise<ClaimsRegister> {
    fs.mkdirSync(this.projectDir, { recursive: true });
    return withProjectLock(this.projectDir, async () => {
      if (this.exists()) {
        throw new Error(`project already initialized: ${this.claimsPath}`);
      }
      const at = params.at ?? new Date().toISOString();
      const draft: ClaimsRegister = {
        schema_version: SCHEMA_VERSION,
        project: {
          id: params.id,
          research_question: params.research_question,
          created_at: at,
          source_set_revision: 1,
        },
        config: params.config,
        sources: [],
        claims: [],
        project_events: [],
      };
      const chain = new ChainAppender(draft);
      draft.project_events.push(
        chain.append({
          at,
          actor: params.actor,
          event: "project_created",
          reason: "Projekt angelegt.",
        }) as ProjectEvent,
      );
      chain.seal(draft);
      const validated = this.validate(draft);
      writeFileAtomic(this.claimsPath, serializeRegister(validated));
      // The project directory carries the JSON Schema of its schema_version
      // (file format appendix: schema/claims.schema.json is part of every
      // project directory).
      writeFileAtomic(
        path.join(this.projectDir, "schema", "claims.schema.json"),
        serializeJsonSchema(buildRegisterJsonSchema()),
      );
      return validated;
    });
  }

  /** Reads and validates the register without taking the lock — safe because
   * writes replace the file atomically. */
  async read(): Promise<ClaimsRegister> {
    return this.readFromDisk();
  }

  /** Verifies the persisted register's hash chain. */
  async verify(): Promise<ChainVerificationResult> {
    return verifyChain(await this.readFromDisk());
  }

  /**
   * Regenerates briefing.md from the frozen briefing blob and the current
   * register state and writes it atomically next to claims.json. The file is
   * a projection: deterministic, regenerable, carrying no truth of its own.
   */
  async renderBriefingFile(
    context: BriefingRenderContext = {},
  ): Promise<string> {
    const register = await this.readFromDisk();
    const briefingImport = register.project.briefing_import;
    if (!briefingImport) {
      throw new Error(
        `project ${register.project.id} has no imported briefing to render`,
      );
    }
    const original = this.blobs().readText(briefingImport.blob_path);
    const rendered = renderBriefing(original, register, context);
    writeFileAtomic(path.join(this.projectDir, "briefing.md"), rendered);
    return rendered;
  }

  private get draftPath(): string {
    return path.join(this.projectDir, "briefing.draft.json");
  }

  /** Saves (overwrites) the workbench's briefing draft. Not part of the
   * register — no lock, no chain entry, no schema validation; a draft is
   * scratch, and the atomic write is only to avoid a torn read mid-save. */
  saveDraft(text: string, basedOnRevision: number): void {
    const draft: BriefingDraft = {
      text,
      saved_at: new Date().toISOString(),
      based_on_revision: basedOnRevision,
    };
    writeFileAtomic(this.draftPath, `${JSON.stringify(draft, null, 2)}\n`);
  }

  /** The saved draft, or null when there is none — including when the file
   * is missing OR unreadable/malformed. A draft is scratch, never worth
   * crashing over: a corrupt draft.json (partial write from a killed
   * process, hand edit, …) is treated exactly like "no draft", not an
   * error, and the workbench simply starts from the published briefing. */
  readDraft(): BriefingDraft | null {
    if (!fs.existsSync(this.draftPath)) {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.draftPath, "utf8"));
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as BriefingDraft).text !== "string" ||
        typeof (raw as BriefingDraft).saved_at !== "string" ||
        typeof (raw as BriefingDraft).based_on_revision !== "number"
      ) {
        return null;
      }
      return raw as BriefingDraft;
    } catch {
      return null;
    }
  }

  /** Removes the draft, if any. A no-op when there is none. */
  clearDraft(): void {
    fs.rmSync(this.draftPath, { force: true });
  }

  /**
   * Runs a mutation transaction. The mutator receives only the capability
   * surface; commit validates the complete result and writes atomically.
   */
  async transaction<T>(
    mutator: (tx: RegisterTransaction) => T | Promise<T>,
  ): Promise<T> {
    return withProjectLock(this.projectDir, async () => {
      const draft = this.readFromDisk();
      const internals: TransactionInternals = {
        draft,
        chain: new ChainAppender(draft),
      };
      const result = await mutator(createTransaction(internals));
      // A transaction that changed content without minting any entry of its
      // own (e.g. a source capture) would silently outdate the last committed
      // state root. Make the change chain-visible instead: append the
      // content_updated event, then seal. Only detectable once the chain
      // carries a state root at all — legacy chains stay legacy until their
      // first entry-minting write.
      if (internals.chain.mintedCount === 0) {
        let newest: { seq: number; state_root?: string } | undefined;
        for (const entry of allChainEntries(draft)) {
          if (!newest || entry.seq > newest.seq) {
            newest = entry;
          }
        }
        if (
          newest?.state_root !== undefined &&
          newest.state_root !== computeStateRoot(draft)
        ) {
          draft.project_events.push(
            internals.chain.append({
              at: new Date().toISOString(),
              actor: "system:register",
              event: "content_updated",
              reason:
                "Inhaltsänderung ohne eigenen Verlaufseintrag versiegelt.",
            }) as ProjectEvent,
          );
        }
      }
      // Commit-time sealing: stamp this transaction's entries with the state
      // root of the state they committed (validate() then replays it).
      internals.chain.seal(draft);
      const validated = this.validate(draft);
      writeFileAtomic(this.claimsPath, serializeRegister(validated));
      return result;
    });
  }

  private validate(draft: ClaimsRegister): ClaimsRegister {
    const parsed = ClaimsRegister.safeParse(draft);
    if (!parsed.success) {
      throw new RegisterValidationError(parsed.error);
    }
    const problems = findIntegrityProblems(parsed.data);
    if (problems.length > 0) {
      throw new RegisterIntegrityError(problems);
    }
    const chainResult = verifyChain(parsed.data);
    if (!chainResult.ok) {
      throw new ChainIntegrityError(chainResult.errors);
    }
    return parsed.data;
  }

  private readFromDisk(): ClaimsRegister {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.claimsPath, "utf8"));
    } catch (error) {
      throw new CorruptRegisterError(`cannot read ${this.claimsPath}`, error);
    }
    const parsed = ClaimsRegister.safeParse(raw);
    if (!parsed.success) {
      throw new CorruptRegisterError(
        `${this.claimsPath} violates the field schema`,
        parsed.error,
      );
    }
    return parsed.data;
  }
}

function createTransaction(
  internals: TransactionInternals,
): RegisterTransaction {
  const { draft, chain } = internals;

  const mutableClaim = (claimId: string): Claim => {
    const claim = draft.claims.find((candidate) => candidate.id === claimId);
    if (!claim) {
      throw new Error(`unknown claim ${claimId}`);
    }
    return claim;
  };

  const mutableEvidence = (claimId: string, evidenceId: string): Evidence => {
    const evidence = mutableClaim(claimId).evidence.find(
      (candidate) => candidate.id === evidenceId,
    );
    if (!evidence) {
      throw new Error(`unknown evidence ${evidenceId} on claim ${claimId}`);
    }
    return evidence;
  };

  return {
    getProject: () => structuredClone(draft.project),
    getConfig: () => structuredClone(draft.config),
    listSources: () => structuredClone(draft.sources),
    listClaims: () => structuredClone(draft.claims),
    listProjectEvents: () => structuredClone(draft.project_events),
    getClaim(claimId) {
      const claim = draft.claims.find((candidate) => candidate.id === claimId);
      if (!claim) {
        throw new Error(`unknown claim ${claimId}`);
      }
      return structuredClone(claim);
    },
    addSource(source) {
      draft.sources.push(source);
    },
    recordProjectEvent({ event, reason, actor, source_id, work_item_id, at }) {
      const entry = chain.append({
        at: at ?? new Date().toISOString(),
        actor,
        event,
        reason,
        ...(source_id !== undefined ? { source_id } : {}),
        ...(work_item_id !== undefined ? { work_item_id } : {}),
      }) as ProjectEvent;
      draft.project_events.push(entry);
      return entry;
    },
    recordCaptureFailure({ work_item_id, origin, input, actor, reason, at }) {
      const entry = chain.append({
        at: at ?? new Date().toISOString(),
        actor,
        event: "source_capture_failed",
        reason,
        capture_failure: { work_item_id, origin, input },
      }) as ProjectEvent;
      draft.project_events.push(entry);
      return entry;
    },
    recordBriefingImport({ sha256, blob_path, tool, actor, at }) {
      if (draft.project.briefing_import) {
        throw new Error(
          `project ${draft.project.id} already has an imported briefing (re-import is not supported)`,
        );
      }
      const imported_at = at ?? new Date().toISOString();
      draft.project.briefing_import = { imported_at, sha256, blob_path, tool };
      draft.project_events.push(
        chain.append({
          at: imported_at,
          actor,
          event: "briefing_imported",
          reason: `Briefing eingefroren (${tool}).`,
        }) as ProjectEvent,
      );
    },
    recordReferenceScan({
      sha256,
      blob_path,
      method,
      candidate_count,
      actor,
      reason,
      at,
    }) {
      const scanned_at = at ?? new Date().toISOString();
      draft.project.reference_scan = {
        scanned_at,
        sha256,
        blob_path,
        method,
        candidate_count,
      };
      draft.project_events.push(
        chain.append({
          at: scanned_at,
          actor,
          event: "reference_scan_completed",
          reason,
        }) as ProjectEvent,
      );
    },
    addClaim(input) {
      return structuredClone(createClaim(draft, chain, input));
    },
    adoptClaim(input) {
      return structuredClone(adoptClaim(draft, chain, input));
    },
    reviseSource(sourceId, snapshot) {
      const source = draft.sources.find(
        (candidate) => candidate.id === sourceId,
      );
      if (!source) {
        throw new Error(`unknown source ${sourceId}`);
      }
      const superseded = source.custom.snapshot;
      if (!superseded) {
        throw new Error(`source ${sourceId} has no snapshot to revise`);
      }
      if (snapshot.revision !== superseded.revision + 1) {
        throw new Error(
          `source ${sourceId}: revision must advance ${superseded.revision} → ` +
            `${superseded.revision + 1}, got ${snapshot.revision}`,
        );
      }
      source.custom.previous_snapshots = [
        ...(source.custom.previous_snapshots ?? []),
        superseded,
      ];
      source.custom.snapshot = structuredClone(snapshot);
      draft.project.source_set_revision += 1;
    },
    correctSourceIdentity(
      sourceId,
      { item, replacedAt, identifierVerified, correctionAttemptId, sourceType },
    ) {
      const index = draft.sources.findIndex(
        (candidate) => candidate.id === sourceId,
      );
      if (index === -1) {
        throw new Error(`unknown source ${sourceId}`);
      }
      const existing = draft.sources[index];
      const previousItem = toPlainCsl(existing);
      // identifier_verified is re-stamped wholesale below (the OLD stamp
      // moves into the archived identity); everything else in `custom`
      // carries forward.
      const { identifier_verified: previousVerification, ...carriedCustom } =
        existing.custom;
      const corrected: Source = {
        ...structuredClone(item),
        id: existing.id,
        type: String(item.type ?? "document"),
        custom: {
          ...carriedCustom,
          ...(sourceType !== undefined ? { source_type: sourceType } : {}),
          ...(identifierVerified !== undefined
            ? { identifier_verified: { ...identifierVerified } }
            : {}),
          previous_identities: [
            ...(existing.custom.previous_identities ?? []),
            {
              replaced_at: replacedAt,
              item: previousItem,
              ...(previousVerification !== undefined
                ? { identifier_verified: previousVerification }
                : {}),
            },
          ],
          correction_attempt_id: correctionAttemptId,
        },
      };
      draft.sources[index] = corrected;
      return {
        previousItem,
        newItem: toPlainCsl(structuredClone(corrected)),
      };
    },
    recordIdentityCorrection({
      source_id,
      previous_item,
      new_item,
      snapshot_revision,
      recheck_claim_ids,
      actor,
      reason,
      at,
    }) {
      const entry = chain.append({
        at: at ?? new Date().toISOString(),
        actor,
        event: "source_identity_corrected",
        reason,
        identity_change: {
          source_id,
          previous_item,
          new_item,
          snapshot_revision,
          recheck_claim_ids,
        },
      }) as ProjectEvent;
      draft.project_events.push(entry);
      return entry;
    },
    reviseBriefing({ sha256, blob_path, tool, actor, reason, at }) {
      const current = draft.project.briefing_import;
      if (!current) {
        throw new Error(
          `project ${draft.project.id} has no briefing to revise`,
        );
      }
      draft.project.previous_briefings = [
        ...(draft.project.previous_briefings ?? []),
        current,
      ];
      const imported_at = at ?? new Date().toISOString();
      draft.project.briefing_import = {
        imported_at,
        sha256,
        blob_path,
        tool,
        revision: (current.revision ?? 1) + 1,
      };
      draft.project_events.push(
        chain.append({
          at: imported_at,
          actor,
          event: "briefing_revised",
          reason,
        }) as ProjectEvent,
      );
    },
    reviseClaimAnchor(claimId, { new_anchor, new_quote, actor, reason, at }) {
      const claim = mutableClaim(claimId);
      const previous_anchor = claim.briefing_anchor;
      const previous_quote = claim.anchor_quote;
      claim.briefing_anchor = new_anchor;
      // Omitted new_quote means "leave the current quote unchanged", not
      // "clear it" — only assign when the caller actually provided one.
      if (new_quote !== undefined) {
        claim.anchor_quote = new_quote;
      }
      const entry = chain.append({
        at: at ?? new Date().toISOString(),
        actor,
        event: "claim_anchor_revised",
        reason,
        anchor_change: {
          claim_id: claimId,
          previous_anchor,
          new_anchor,
          ...(previous_quote !== undefined ? { previous_quote } : {}),
          ...(new_quote !== undefined ? { new_quote } : {}),
        },
      }) as ProjectEvent;
      draft.project_events.push(entry);
      return entry;
    },
    remapClaimAnchor(claimId, { anchor, quote }) {
      const claim = mutableClaim(claimId);
      claim.briefing_anchor = anchor;
      // Same preserve-if-omitted semantics as reviseClaimAnchor.
      if (quote !== undefined) {
        claim.anchor_quote = quote;
      }
    },
    updateConfig({ config, actor, reason, at }) {
      const previous = structuredClone(draft.config);
      draft.config = structuredClone(config);
      const entry = chain.append({
        at: at ?? new Date().toISOString(),
        actor,
        event: "config_changed",
        reason,
        config_change: { previous, next: structuredClone(config) },
      }) as ProjectEvent;
      draft.project_events.push(entry);
      return entry;
    },
    transitionClaim(claimId, request) {
      return structuredClone(
        applyTransition(mutableClaim(claimId), chain, request),
      );
    },
    addEvidence(claimId, evidence) {
      mutableClaim(claimId).evidence.push(structuredClone(evidence));
    },
    reviseClaimText(claimId, newText) {
      mutableClaim(claimId).text = newText;
    },
    setExistenceCheck(claimId, evidenceId, result) {
      mutableEvidence(claimId, evidenceId).existence_check = { ...result };
    },
    appendJudgment(claimId, evidenceId, judgment) {
      mutableEvidence(claimId, evidenceId).judgments.push(
        structuredClone(judgment),
      );
    },
    setResolvedRelation(claimId, evidenceId, relation) {
      mutableEvidence(claimId, evidenceId).relation_type = relation;
    },
    setSupportDegree(claimId, degree) {
      mutableClaim(claimId).support_degree = degree;
    },
    setCalibrationResult(claimId, result) {
      mutableClaim(claimId).calibration_result = result;
    },
  };
}

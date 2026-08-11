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
  SupportDegree,
} from "../schema/enums";
import type { HistoryEntry } from "../schema/history";
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
  /** Read-only snapshot of the project events, e.g. for workflow gates
   * (source_set_frozen) that must be checked inside the transaction. */
  listProjectEvents(): ProjectEvent[];
  getClaim(claimId: string): Claim;
  /** Adds a source entry (CSL-JSON item with `custom` block). Validated with
   * everything else at commit. */
  addSource(source: Source): void;
  /** Appends a project-wide event with its chain link. */
  recordProjectEvent(input: {
    event: ProjectEventType;
    reason: string;
    actor: ActorId;
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
    recordProjectEvent({ event, reason, actor, at }) {
      const entry = chain.append({
        at: at ?? new Date().toISOString(),
        actor,
        event,
        reason,
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

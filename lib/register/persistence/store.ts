import fs from "node:fs";
import path from "node:path";

import { resolveProjectDir } from "../../identity";
import type { ActorId } from "../../identity/types";
import { ChainAppender } from "../chain/appender";
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
import { applyTransition, createClaim } from "../statemachine/engine";
import type { TransitionRequest } from "../statemachine/engine";
import type { Evidence, Judgment } from "../schema/evidence";
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
   * Creates a claim through the extraction gate: initial status is decided by
   * the Nachweisvollständigkeits-Gate (evidence → erfasst, none → zur
   * Adjudikation), never by the caller.
   */
  addClaim(input: {
    claim: Omit<Claim, "status" | "history">;
    actor: ActorId;
    reason: string;
    at?: string;
  }): Claim;
  /**
   * The sole status-changing capability: checks edge, gate and decision
   * requirement, then appends exactly one chain-linked history entry.
   */
  transitionClaim(claimId: string, request: TransitionRequest): HistoryEntry;
  /** Adds evidence to a claim (repair: alternative Fundstelle). */
  addEvidence(claimId: string, evidence: Evidence): void;
  /**
   * Rewrites the claim wording during the repair loop (TMB-37). The previous
   * wording is never lost: the caller records it in the accompanying
   * `beanstandet → ueberarbeitet` transition's `revision` field.
   */
  reviseClaimText(claimId: string, newText: string): void;
  /** Records the stage-1 existence result for one piece of evidence. */
  setExistenceCheck(
    claimId: string,
    evidenceId: string,
    result: { status: "bestanden" | "nicht_bestanden"; at: string },
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
  async renderBriefingFile(): Promise<string> {
    const register = await this.readFromDisk();
    const briefingImport = register.project.briefing_import;
    if (!briefingImport) {
      throw new Error(
        `project ${register.project.id} has no imported briefing to render`,
      );
    }
    const original = this.blobs().readText(briefingImport.blob_path);
    const rendered = renderBriefing(original, register);
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
    addClaim(input) {
      return structuredClone(createClaim(draft, chain, input));
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

/**
 * The PROMPT-05 ship gate: compares the verdicts prompt v1.1.0 produces
 * against the two v1.2.0 ordering variants over the frozen fixture corpus,
 * calibrated against a v1.1.0 noise floor. Deliberately NOT part of the
 * vitest suite — it spends real subscription quota and needs an
 * authenticated CLI.
 *
 *   npx tsx scripts/compare-prompt-verdicts.ts claude
 *   npx tsx scripts/compare-prompt-verdicts.ts claude --arm noise-floor --n 10
 *   npx tsx scripts/compare-prompt-verdicts.ts --dry-run
 *   npx tsx scripts/compare-prompt-verdicts.ts --help
 *
 * Three facts specific to this script, on top of the smoke script's:
 *
 * 1. It is the ship gate for PROMPT-05. `DEFAULT_RUBRIC_VERSION` does not
 *    move until the report it writes states a pass, and 03-05 asserts that
 *    with a grep for the `GATE_RESULT:` lines below rather than by reading a
 *    paragraph.
 * 2. It is RESUMABLE. A rate-limit pause mid-run is expected rather than
 *    exceptional, so every result is appended to the NDJSON as it arrives
 *    and a restarted run skips the units it already has. Stopping and
 *    restarting is safe and costs nothing.
 * 3. Its output is a COMMITTED artifact the thesis cites. The report's
 *    gating lines are the harness's own evaluation of a tolerance rule that
 *    was written down before any data existed; they are never hand-edited.
 *
 * Boundaries. It calls backends directly against a throwaway directory under
 * the OS temp dir, the way `scripts/adapter-smoke.ts` does. It opens no
 * register store, performs no register write of any kind and never targets a
 * real project directory. (The plan grep-verifies both call forms, which is
 * why this sentence names neither.) `scripts/` is outside
 * `coverage.include` and outside the architecture test's scanned domain
 * files, so writing NDJSON and spawning child processes here is sanctioned
 * rather than a hole in the layering.
 *
 * Run it from the `software/` directory: the prompt loader and the rubric
 * rule loader both resolve their data files from the process working
 * directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AttributionInput,
  Backend,
  ClaimContext,
  EvidenceContext,
  RubricInput,
  TraceSink,
} from "../lib/adapters";
import {
  createClaudeBackend,
  createCodexBackend,
  createConcurrencyGate,
  Orchestrator,
  renderPromptForJob,
} from "../lib/adapters";
import type {
  CalibrationResult,
  RelationType,
  SourceType,
} from "../lib/register";
// Deep imports, deliberately: these three live off the `lib/pipeline`
// barrel, and the harness must compute the post-cap verdict and the
// persisted string with the SAME functions production uses — a
// re-implementation would make the measurement a second opinion about
// production rather than a recording of it. Putting them on the barrel
// would move a pinned public surface in a plan that changes no production
// code. `scripts/` is outside the architecture test's scanned domain and
// outside the ESLint import restrictions (which cover `lib/**` and
// `cli/**`), so this is a sanctioned exception.
import {
  combineCalibrationResult,
  evaluateMechanicalRubric,
  loadRubricRuleSet,
} from "../lib/pipeline/verification/rubric-rules";
// Routes through `joinReasoningRoles` — the codebase's single join — so the
// recorded string is byte-identical to what the register would have held.
import { resolvePersistedReasoning } from "../lib/pipeline/verification/reasoning-join";

/** Upper bound per call, mirroring `scripts/adapter-smoke.ts`. */
const TIMEOUT_MS = 300_000;

/**
 * Hardcoded rather than read from the adapter config on purpose: the
 * first-attempt contract pass rate is only comparable across arms and across
 * machines if every arm ran under the same attempt budget. Three attempts is
 * the documented policy the production retry loop implements.
 */
const RETRY_POLICY = { maxAttempts: 3, retryBaseDelayMs: 2_000 } as const;

/**
 * THE PRE-REGISTERED TOLERANCE RULE. Written before any data existed and
 * quoted verbatim into the report.
 *
 * Never edit this string, and never edit the two constants below it, once a
 * single arm has run. A tolerance chosen after seeing the data is not a
 * tolerance — it is a description of the data wearing a rule's clothes, and
 * the whole gate is worth nothing the moment it becomes one.
 */
const PRE_REGISTERED_TOLERANCE =
  "at most 2 of 30 claims (7 percent) change their persisted " +
  "calibration_result, and no claim moves between licensed and " +
  "pending_adjudication";
/** The ratio form of the rule's first clause, so a reduced N is evaluable. */
const MAX_FLIP_RATIO = 2 / 30;
/** The rule's second clause: a two-step move fails the arm outright. */
const TWO_STEP_ENDPOINTS: readonly CalibrationResult[] = [
  "licensed",
  "pending_adjudication",
];

/**
 * The machine-readable gate line's prefix and its field order.
 *
 * `GATE_RESULT:` and the bare words `PASS` / `FAIL` are a CONTRACT with
 * 03-05, whose flip task greps
 * `^GATE_RESULT: PASS arm=<chosen arm>` before it edits
 * `DEFAULT_RUBRIC_VERSION`. A paraphrase here is a broken gate, not a style
 * difference. The full shape, one line per arm that actually ran:
 *
 *   GATE_RESULT: PASS arm=v1.2.0-ordering-a flips=1/30 two_step=0
 */
const GATE_MARKER = "GATE_RESULT:";

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

type ArmName =
  "noise-floor" | "v1.1.0-baseline" | "v1.2.0-ordering-a" | "v1.2.0-ordering-b";

/** Which recorded verdicts an arm's paired flip count is measured against. */
type Reference = "fixture" | "v1.1.0-baseline";

interface Arm {
  readonly name: ArmName;
  /** Selects the mechanical rule table AND is interpolated into the prompt. */
  readonly ruleSetVersion: string;
  readonly rubricPromptVersion: string;
  readonly attributionPromptVersion: string;
  readonly reference: Reference;
  readonly why: string;
}

/**
 * The four arms, in run order. The noise floor is FIRST on purpose: if a
 * v1.1.0 generation alone flips more verdicts than the rule allows, the
 * remaining three arms cannot distinguish "the prompt moved it" from "the
 * model is nondeterministic", and spending them would be waste.
 *
 * Ordering B carries no pin — it is addressed by naming its version string,
 * which is how `loadPromptTemplate` resolves `v1.2.0-plain-first.md`. Its
 * mechanical rules come from the v1.2 rule set, whose `claim_types` block is
 * byte-identical to v1.1's, so the arms differ in exactly one variable: the
 * prose template.
 */
const ARMS: readonly Arm[] = [
  {
    name: "noise-floor",
    ruleSetVersion: "se-evidence-rubric-v1.1",
    rubricPromptVersion: "1.1.0",
    attributionPromptVersion: "1.1.0",
    reference: "fixture",
    why: "v1.1.0 re-generated and compared against the verdicts the real runs recorded — the model's own nondeterminism, with no prompt change in it",
  },
  {
    name: "v1.1.0-baseline",
    ruleSetVersion: "se-evidence-rubric-v1.1",
    rubricPromptVersion: "1.1.0",
    attributionPromptVersion: "1.1.0",
    reference: "fixture",
    why: "the reference the two v1.2.0 arms are paired against, generated in the same session and by the same model as they are",
  },
  {
    name: "v1.2.0-ordering-a",
    ruleSetVersion: "se-evidence-rubric-v1.2",
    rubricPromptVersion: "1.2.0",
    attributionPromptVersion: "1.2.0",
    reference: "v1.1.0-baseline",
    why: "two-layer prose, technical layer first (the pinned variant)",
  },
  {
    name: "v1.2.0-ordering-b",
    ruleSetVersion: "se-evidence-rubric-v1.2",
    rubricPromptVersion: "1.2.0-plain-first",
    attributionPromptVersion: "1.2.0-plain-first",
    reference: "v1.1.0-baseline",
    why: "two-layer prose, plain layer first (the unpinned variant)",
  },
];

// ---------------------------------------------------------------------------
// Corpus and records
// ---------------------------------------------------------------------------

interface FixtureClaim extends ClaimContext {
  readonly evidence: readonly EvidenceContext[];
  readonly ground_truth: {
    readonly calibration_result: CalibrationResult | null;
    readonly relation_types: Readonly<Record<string, RelationType>>;
    readonly mechanical: "met" | "not_met";
    readonly rubric_version: string;
    readonly rubric_template_version: string;
    readonly attribution_template_version: string;
  };
  readonly borderline: {
    readonly weakened_or_parked: boolean;
    readonly mechanical_not_met: boolean;
    readonly second_opinion_fired: boolean;
  };
}

interface FixtureCorpus {
  readonly generated_at: string;
  readonly source_project_count: number;
  readonly claims_with_ground_truth: number;
  readonly claims: readonly FixtureClaim[];
}

/** One failed contract clause, as reported by the boundary that rejected it. */
interface ClauseFailure {
  readonly attempt: number;
  readonly error_kind: string;
  readonly error_name: string;
  readonly message: string;
}

/**
 * One NDJSON line: one job, in one arm, for one claim (and one evidence, for
 * attribution). Self-contained on purpose — the reference values travel with
 * the record, so a partial run stays analysable and the report can be
 * regenerated from the NDJSON alone.
 */
interface ResultRecord {
  readonly arm: ArmName;
  readonly claim_id: string;
  readonly evidence_id: string | null;
  readonly job_kind: "attribution" | "rubric";
  /** The template version this record was GENERATED and VALIDATED under. */
  readonly prompt_version: string;
  readonly template_sha256: string;
  /** Which output contract the response actually satisfied. */
  readonly contract: "single-reasoning" | "two-layer" | null;
  readonly backend: string;
  readonly model: string | null;
  readonly status: "ok" | "exhausted";
  readonly attempts: number;
  readonly latency_ms: number;
  readonly output: unknown;
  readonly contract_validation: "pass" | "fail";
  readonly failed_clauses: readonly ClauseFailure[];
  /** The string `joinReasoningRoles` would have persisted. */
  readonly joined_reasoning: string | null;
  // attribution only
  readonly relation_type?: RelationType | null;
  readonly confidence?: number | null;
  readonly ground_truth_relation_type?: RelationType | null;
  // rubric only — BOTH verdicts, always, because the mechanical cap sits
  // between them and a single number would hide how much of a drift it
  // absorbed. `null` on an exhausted unit, never absent.
  readonly verdict_pre_cap?: CalibrationResult | null;
  readonly verdict_post_cap?: CalibrationResult | null;
  readonly mechanical?: "met" | "not_met" | null;
  readonly ground_truth_calibration_result?: CalibrationResult | null;
  readonly claim_text?: string;
  readonly recorded_at: string;
}

/** Identity of a unit of work, for the resume index. */
function unitKey(
  arm: string,
  claimId: string,
  jobKind: string,
  evidenceId: string | null,
): string {
  return `${arm} ${claimId} ${jobKind} ${evidenceId ?? "-"}`;
}

function recordKey(record: ResultRecord): string {
  return unitKey(
    record.arm,
    record.claim_id,
    record.job_kind,
    record.evidence_id,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  readonly backendId: string | null;
  readonly arms: readonly ArmName[];
  readonly sampleSize: number | null;
  readonly dryRun: boolean;
  readonly fixturesPath: string;
  readonly outDir: string;
  readonly smokeResult: string | null;
}

const DEFAULT_FIXTURES = path.join("tests", "corpus", "verdict-fixtures.json");
const DEFAULT_OUT_DIR = path.join("tests", "corpus", "verdict-comparison");

function printHelp(): void {
  console.log(
    [
      "usage: npx tsx scripts/compare-prompt-verdicts.ts <claude|codex> [options]",
      "",
      "The PROMPT-05 ship gate. Spends real subscription quota; never run from",
      "npm run check. Run it from the software/ directory.",
      "",
      "Arms, in run order (the noise floor runs FIRST and can stop the rest):",
      ...ARMS.map(
        (arm) =>
          `  ${arm.name.padEnd(18)} rubric v${arm.rubricPromptVersion}, attribution v${arm.attributionPromptVersion}` +
          `, paired against ${arm.reference}\n${" ".repeat(22)}${arm.why}`,
      ),
      "",
      "Options:",
      "  --arm <name>        run only this arm (repeatable). Default: all four, in order.",
      "  --n <count>         cap the sample size for this invocation (borderline claims first).",
      "  --dry-run           make no CLI call: read the existing NDJSON, report what would",
      "                      be skipped, and write the report from what is already recorded.",
      `  --fixtures <path>   corpus file. Default: ${DEFAULT_FIXTURES}`,
      `  --out <dir>         output directory. Default: ${DEFAULT_OUT_DIR}`,
      "  --smoke-result <s>  record the pre-run adapter-smoke outcome in the report header,",
      "                      so it is not hand-typed next to the gate lines.",
      "  --help              print this and exit without spending anything.",
      "",
      "Resume behaviour: every result is appended to results.ndjson as it arrives.",
      "A restarted run reads that file and SKIPS every (arm, claim, job, evidence)",
      "unit already recorded, so a rate-limit pause costs a second sitting rather",
      "than the run. Stopping and restarting is safe; nothing is recorded twice.",
      "",
      "Halt condition: after the noise-floor arm the pre-registered tolerance rule",
      "is evaluated against it. If the floor alone exceeds the rule the report is",
      "written and the remaining arms do not run.",
      "",
      "Exit codes: 0 = ran and reported (INCLUDING a recorded FAIL — a failing arm",
      "is a measurement, not a script error), 1 = operational problem, 2 = usage,",
      "3 = paused by a rate limit; resume with the same command.",
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): Options | "help" | null {
  const positional: string[] = [];
  const arms: ArmName[] = [];
  let sampleSize: number | null = null;
  let dryRun = false;
  let fixturesPath = DEFAULT_FIXTURES;
  let outDir = DEFAULT_OUT_DIR;
  let smokeResult: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (arg === "--arm") {
      const known = ARMS.find((candidate) => candidate.name === value);
      if (known === undefined) {
        console.error(
          `unknown arm "${value ?? ""}" (expected one of: ${ARMS.map((a) => a.name).join(", ")})`,
        );
        return null;
      }
      arms.push(known.name);
      index += 1;
      continue;
    }
    if (arg === "--n") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(`--n expects a positive integer, got "${value ?? ""}"`);
        return null;
      }
      sampleSize = parsed;
      index += 1;
      continue;
    }
    if (arg === "--fixtures" || arg === "--out" || arg === "--smoke-result") {
      if (value === undefined) {
        console.error(`${arg} expects a value`);
        return null;
      }
      if (arg === "--fixtures") {
        fixturesPath = value;
      } else if (arg === "--out") {
        outDir = value;
      } else {
        smokeResult = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`unknown option "${arg}"`);
      return null;
    }
    positional.push(arg);
  }

  const backendId = positional[0] ?? null;
  if (positional.length > 1) {
    console.error("expected at most one backend id");
    return null;
  }
  if (!dryRun && backendId === null) {
    console.error("a backend id is required unless --dry-run is given");
    return null;
  }
  return {
    backendId,
    arms: arms.length > 0 ? arms : ARMS.map((arm) => arm.name),
    sampleSize,
    dryRun,
    fixturesPath,
    outDir,
    smokeResult,
  };
}

function buildBackend(id: string): Backend {
  if (id === "claude") {
    return createClaudeBackend();
  }
  if (id === "codex") {
    return createCodexBackend();
  }
  throw new Error(`unknown backend "${id}" (expected: claude or codex)`);
}

// ---------------------------------------------------------------------------
// NDJSON store
// ---------------------------------------------------------------------------

function readRecords(file: string): ResultRecord[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const records: ResultRecord[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as ResultRecord);
    } catch {
      // A half-written last line is the expected shape of an interrupted
      // run. Report it and keep the rest: discarding the whole file would
      // throw away hours of paid-for results over one truncated record.
      console.warn(
        `results line ${index + 1} is not valid JSON and was skipped`,
      );
    }
  }
  return records;
}

function appendRecord(file: string, record: ResultRecord): void {
  // Appended as it arrives, never buffered to the end: a rate-limit pause
  // mid-run is expected, and a buffer would lose everything before it.
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Running one arm
// ---------------------------------------------------------------------------

/**
 * Collects every attempt envelope the orchestrator writes, instead of
 * persisting them into a project directory. This is the designed injection
 * seam, and it is what gives the harness the per-ATTEMPT detail the report
 * needs: which clause rejected which attempt, and the attempt a unit finally
 * passed on.
 */
interface CapturedAttempt {
  readonly attempt: number;
  readonly model: string | null;
  readonly prompt_version: string;
  readonly error?: { kind: string; name: string; message: string };
}

function capturingTraceSink(into: CapturedAttempt[]): TraceSink {
  return {
    write: (_projectDir, envelope) => {
      into.push({
        attempt: envelope.attempt,
        model: envelope.model,
        prompt_version: envelope.prompt_version,
        ...(envelope.error !== undefined ? { error: envelope.error } : {}),
      });
      return Promise.resolve();
    },
  };
}

/** A rate-limit pause, propagated out of the arm loop to stop the run. */
class PausedError extends Error {
  constructor(readonly detail: string) {
    super(`run paused by a rate limit: ${detail}`);
    this.name = "PausedError";
  }
}

interface RunUnitResult {
  readonly status: "ok" | "exhausted";
  readonly output: unknown;
  readonly model: string | null;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly failedClauses: ClauseFailure[];
}

async function runUnit(
  orchestrator: Orchestrator,
  backendId: string,
  job: Parameters<Orchestrator["run"]>[1],
  attempts: CapturedAttempt[],
): Promise<RunUnitResult> {
  attempts.length = 0;
  const startedAt = Date.now();
  const outcome = await orchestrator.run(backendId, job);
  const latencyMs = Date.now() - startedAt;
  const failedClauses: ClauseFailure[] = attempts
    .filter((entry) => entry.error !== undefined)
    .map((entry) => ({
      attempt: entry.attempt,
      error_kind: entry.error?.kind ?? "unknown",
      error_name: entry.error?.name ?? "unknown",
      message: entry.error?.message ?? "",
    }));

  if (outcome.status === "paused") {
    throw new PausedError(outcome.reason);
  }
  if (outcome.status === "exhausted") {
    return {
      status: "exhausted",
      output: null,
      model: null,
      attempts: outcome.attempts,
      latencyMs,
      failedClauses,
    };
  }
  return {
    status: "ok",
    output: outcome.output,
    model: outcome.model,
    attempts: outcome.attempts,
    latencyMs,
    failedClauses,
  };
}

/** `resolvePersistedReasoning` branches on the presence of a key, and so
 * does this — the recorded contract label is a fact about the response, not
 * an assumption about the arm, which is exactly what lets the artifact be
 * audited for a version mix-up after the fact. */
function contractOf(output: unknown): "single-reasoning" | "two-layer" | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  return "reasoning" in output ? "single-reasoning" : "two-layer";
}

function joinedReasoningOf(output: unknown): string | null {
  if (contractOf(output) === null) {
    return null;
  }
  return resolvePersistedReasoning(
    output as Parameters<typeof resolvePersistedReasoning>[0],
  );
}

/**
 * The claims this invocation runs, capped by `--n`.
 *
 * Borderline claims first, then claims carrying recorded ground truth, then
 * the rest — each block sorted by id, so the choice is deterministic and a
 * reduced-N arm is reproducible. The bias is deliberate and conservative: a
 * noise floor measured on the hardest claims is an UPPER bound on the
 * model's nondeterminism, so a floor that passes at reduced N passes for a
 * reason rather than by having drawn easy cases.
 */
function selectClaims(
  corpus: FixtureCorpus,
  sampleSize: number | null,
): readonly FixtureClaim[] {
  if (sampleSize === null || sampleSize >= corpus.claims.length) {
    return corpus.claims;
  }
  // Pairable claims (a recorded calibration_result) rank BEFORE borderline
  // ones. A capped run exists to measure the noise floor cheaply, and the
  // floor and baseline arms pair against the fixture's recorded verdict — a
  // borderline claim with no recorded verdict costs the same calls and
  // contributes nothing to the paired count. The first real run drew ten
  // such claims and produced a 0/0 "measurement".
  const rank = (claim: FixtureClaim): number => {
    const borderline =
      claim.borderline.weakened_or_parked ||
      claim.borderline.mechanical_not_met ||
      claim.borderline.second_opinion_fired;
    const pairable = claim.ground_truth.calibration_result !== null;
    if (pairable) {
      return borderline ? 0 : 1;
    }
    return borderline ? 2 : 3;
  };
  return [...corpus.claims]
    .sort(
      (left, right) =>
        rank(left) - rank(right) || left.id.localeCompare(right.id),
    )
    .slice(0, sampleSize);
}

async function runArm(
  arm: Arm,
  claims: readonly FixtureClaim[],
  orchestrator: Orchestrator,
  backendId: string,
  projectDir: string,
  attempts: CapturedAttempt[],
  resultsFile: string,
  already: ReadonlySet<string>,
): Promise<void> {
  const ruleSet = loadRubricRuleSet(arm.ruleSetVersion);
  console.log(`\n=== arm ${arm.name} — ${arm.why}`);
  console.log(
    `    rule set ${arm.ruleSetVersion}; rubric template v${arm.rubricPromptVersion}, ` +
      `attribution template v${arm.attributionPromptVersion}; paired against ${arm.reference}`,
  );

  for (const claim of claims) {
    // Attribution first, then the rubric — the same order production runs
    // them in, because the rubric's mechanical cap is computed over THIS
    // arm's relation types, not over the register's.
    const relationTypes = new Map<string, RelationType>();

    for (const evidence of claim.evidence) {
      const key = unitKey(arm.name, claim.id, "attribution", evidence.id);
      if (already.has(key)) {
        continue;
      }
      const input: AttributionInput = { claim, evidence };
      // Rendered at the ARM's own version, which travels to the boundary as
      // `job.prompt.version` and is what selects the output schema there.
      // Getting this wrong does not raise: it produces an arm in which every
      // generation fails validation for a reason that has nothing to do with
      // the prompt. The version is therefore recorded per record as
      // `prompt_version`, so the artifact can be audited for exactly that.
      const prompt = renderPromptForJob(
        "attribution",
        input,
        arm.attributionPromptVersion,
      );
      process.stdout.write(`- ${claim.id}/${evidence.id} attribution … `);
      const result = await runUnit(
        orchestrator,
        backendId,
        {
          kind: "attribution",
          projectDir,
          input,
          prompt,
          timeoutMs: TIMEOUT_MS,
        },
        attempts,
      );
      const output = result.output as {
        relation_type?: RelationType;
        confidence?: number;
      } | null;
      if (output?.relation_type !== undefined) {
        relationTypes.set(evidence.id, output.relation_type);
      }
      console.log(
        `${result.status} (attempt ${result.attempts}, ${Math.round(result.latencyMs / 1000)}s)`,
      );
      appendRecord(resultsFile, {
        arm: arm.name,
        claim_id: claim.id,
        evidence_id: evidence.id,
        job_kind: "attribution",
        // The version this record was generated AND validated under; the
        // validating boundary read the very same `prompt_version` off the job.
        prompt_version: prompt.version,
        template_sha256: prompt.template_sha256,
        contract: contractOf(result.output),
        backend: backendId,
        model: result.model,
        status: result.status,
        attempts: result.attempts,
        latency_ms: result.latencyMs,
        output: result.output,
        contract_validation: result.status === "ok" ? "pass" : "fail",
        failed_clauses: result.failedClauses,
        joined_reasoning: joinedReasoningOf(result.output),
        relation_type: output?.relation_type ?? null,
        confidence: output?.confidence ?? null,
        ground_truth_relation_type:
          claim.ground_truth.relation_types[evidence.id] ?? null,
        recorded_at: new Date().toISOString(),
      });
    }

    const rubricKey = unitKey(arm.name, claim.id, "rubric", null);
    if (already.has(rubricKey)) {
      continue;
    }
    const rubricInput: RubricInput = {
      claim,
      evidence: claim.evidence,
      rubric_version: arm.ruleSetVersion,
    };
    const rubricPrompt = renderPromptForJob(
      "rubric",
      rubricInput,
      arm.rubricPromptVersion,
    );
    process.stdout.write(`- ${claim.id} rubric … `);
    const rubricResult = await runUnit(
      orchestrator,
      backendId,
      {
        kind: "rubric",
        projectDir,
        input: rubricInput,
        prompt: rubricPrompt,
        timeoutMs: TIMEOUT_MS,
      },
      attempts,
    );
    const rubricOutput = rubricResult.output as {
      calibration_result?: CalibrationResult;
    } | null;

    // The mechanical half, computed the way production computes it: over the
    // types of the DISTINCT pertinent sources of THIS arm's attributions.
    const pertinent = [
      ...new Map(
        claim.evidence
          .filter((item) => {
            const relation = relationTypes.get(item.id);
            return relation === "supports" || relation === "partially_supports";
          })
          .map((item) => [item.source_id, item.source_type] as const),
      ).values(),
    ] as readonly SourceType[];
    const rule = ruleSet.claim_types[claim.claim_type];
    const mechanical =
      rule === undefined
        ? "not_met"
        : evaluateMechanicalRubric(pertinent, rule);

    // BOTH verdicts, always. The cap is untouched by this phase and absorbs
    // part of any upward drift, so a single number would hide exactly the
    // thing the gate is measuring. `null` on an exhausted unit — never absent.
    const preCap = rubricOutput?.calibration_result ?? null;
    const postCap =
      preCap === null ? null : combineCalibrationResult(mechanical, preCap);
    console.log(
      `${rubricResult.status} (attempt ${rubricResult.attempts}, ` +
        `${Math.round(rubricResult.latencyMs / 1000)}s, ${preCap ?? "-"} → ${postCap ?? "-"})`,
    );
    appendRecord(resultsFile, {
      arm: arm.name,
      claim_id: claim.id,
      evidence_id: null,
      job_kind: "rubric",
      prompt_version: rubricPrompt.version,
      template_sha256: rubricPrompt.template_sha256,
      contract: contractOf(rubricResult.output),
      backend: backendId,
      model: rubricResult.model,
      status: rubricResult.status,
      attempts: rubricResult.attempts,
      latency_ms: rubricResult.latencyMs,
      output: rubricResult.output,
      contract_validation: rubricResult.status === "ok" ? "pass" : "fail",
      failed_clauses: rubricResult.failedClauses,
      joined_reasoning: joinedReasoningOf(rubricResult.output),
      verdict_pre_cap: preCap,
      verdict_post_cap: postCap,
      mechanical: rubricResult.status === "ok" ? mechanical : null,
      ground_truth_calibration_result:
        claim.ground_truth.calibration_result ?? null,
      claim_text: claim.text,
      recorded_at: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface ArmAnalysis {
  readonly arm: ArmName;
  readonly reference: Reference;
  readonly paired: number;
  readonly flips: number;
  readonly twoStepMoves: number;
  readonly passed: boolean;
  readonly allowedFlips: number;
  readonly preCap: Record<string, number>;
  readonly postCap: Record<string, number>;
  readonly relationFlips: number;
  readonly relationPaired: number;
  readonly firstAttempt: number;
  readonly completed: number;
  readonly exhausted: number;
  readonly clauseHits: ReadonlyMap<string, number>;
  readonly plainChars: number[];
  readonly caveatChars: number[];
  readonly technicalChars: number[];
  readonly hedgePlain: number;
  readonly hedgeTechnical: number;
  readonly overlapRatios: number[];
  readonly refusals: number;
  readonly refusalDenominator: number;
  readonly templateDigests: ReadonlyMap<string, string>;
  readonly models: ReadonlySet<string>;
  readonly contracts: ReadonlySet<string>;
}

function isTwoStep(from: CalibrationResult, to: CalibrationResult): boolean {
  return (
    from !== to &&
    TWO_STEP_ENDPOINTS.includes(from) &&
    TWO_STEP_ENDPOINTS.includes(to)
  );
}

/**
 * German hedge markers, counted per prose layer as a DIAGNOSTIC only.
 *
 * Never a gate, and never a retry trigger: a word-list lint false-positives
 * on legitimate German, and a retry loop on grammatical prose is worse than
 * its miss rate. The number exists so the human diff review knows where to
 * look — specifically for the asymmetry the two-layer design can introduce,
 * a plain layer that hedges less than the technical layer it is supposed to
 * summarise.
 */
const HEDGE_WORDS: readonly string[] = [
  "möglicherweise",
  "vermutlich",
  "eventuell",
  "tendenziell",
  "offenbar",
  "scheinbar",
  "anscheinend",
  "vielleicht",
  "unklar",
  "womöglich",
  "wohl",
  "eher",
  "kaum",
  "nur bedingt",
  "nicht eindeutig",
  "lässt sich nicht",
  "deutet darauf hin",
  "könnte",
  "dürfte",
];

function hedgeHits(text: string): number {
  const lower = text.toLowerCase();
  return HEDGE_WORDS.reduce(
    (total, word) => total + (lower.includes(word) ? 1 : 0),
    0,
  );
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 3),
  );
}

/** |plain ∩ technical| / |plain| — how much of the plain layer is just the
 * technical layer's vocabulary repeated. Reported, never gating. */
function overlapRatio(plain: string, technical: string): number | null {
  const plainTokens = tokenSet(plain);
  if (plainTokens.size === 0) {
    return null;
  }
  const technicalTokens = tokenSet(technical);
  let shared = 0;
  for (const token of plainTokens) {
    if (technicalTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / plainTokens.size;
}

/**
 * The display tier's quote-refusal condition, REPRODUCED from
 * `app/projects/verdict-glossary.ts` rather than imported.
 *
 * Two reasons it is a copy. The display module lives in `app/` because
 * placement is what makes a leak into the register impossible, and this
 * harness must not become the first thing that reaches across that boundary.
 * And the plan reports this rate; it does not relax the logic on the
 * strength of it, so a copy that can only ever go stale in the direction of
 * "the harness measured something the display no longer does" is safer than
 * a coupling that would let a later edit here change what the UI does.
 *
 * Only the QUOTE-STRUCTURE half is reproduced: the excerpt-span pass in the
 * original only ADDS protected intervals and can never cause a refusal.
 * Keep the four constants below in step with that file if it ever changes.
 */
const DOUBLE_QUOTE_MARKS = "„“”«»‟";
const SINGLE_QUOTE_MARKS = "‚‘’‹›‛";
const DIRECTIONAL_OPENERS = "„«‟‚‹‛";
const MAX_QUOTED_RUNS = 8;

function refusesSubstitution(text: string): boolean {
  let openIndex: number | null = null;
  let openFamily: string | null = null;
  let runs = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const family = DOUBLE_QUOTE_MARKS.includes(character)
      ? "double"
      : SINGLE_QUOTE_MARKS.includes(character)
        ? "single"
        : null;
    if (family === null) {
      continue;
    }
    if (openIndex === null) {
      openIndex = index;
      openFamily = family;
      continue;
    }
    if (family !== openFamily) {
      continue;
    }
    if (DIRECTIONAL_OPENERS.includes(character)) {
      return true; // nested quotation — the display refuses
    }
    openIndex = null;
    openFamily = null;
    runs += 1;
    if (runs > MAX_QUOTED_RUNS) {
      return true;
    }
  }
  return openIndex !== null; // unterminated quotation — the display refuses
}

/**
 * A coarse clause key for a rejected attempt. Heuristic by design: the
 * boundary reports `path: message` segments, and the first few words of the
 * message are enough to tell the excerpt anchor from the character cap from
 * the verdict slot-frame. It groups a diagnostic, it does not decide
 * anything.
 */
function clauseKey(message: string): string {
  const body = message.split("fails schema validation:").pop() ?? message;
  const first = body.split(";")[0].trim();
  return first.split(/\s+/).slice(0, 8).join(" ").slice(0, 110);
}

function analyseArm(
  arm: Arm,
  records: readonly ResultRecord[],
): ArmAnalysis | null {
  const mine = records.filter((record) => record.arm === arm.name);
  if (mine.length === 0) {
    return null;
  }
  const rubric = mine.filter((record) => record.job_kind === "rubric");
  const attribution = mine.filter(
    (record) => record.job_kind === "attribution",
  );

  // The reference side of the pairing. `fixture` reads the ground truth that
  // travels on the record itself; a named arm reads that arm's own verdicts,
  // so the two v1.2.0 arms are compared against a baseline generated in the
  // same session and by the same model.
  const referenceByClaim = new Map<string, CalibrationResult>();
  if (arm.reference === "fixture") {
    for (const record of rubric) {
      const truth = record.ground_truth_calibration_result;
      if (truth !== null && truth !== undefined) {
        referenceByClaim.set(record.claim_id, truth);
      }
    }
  } else {
    for (const record of records) {
      if (record.arm === arm.reference && record.job_kind === "rubric") {
        const value = record.verdict_post_cap;
        if (value !== null && value !== undefined) {
          referenceByClaim.set(record.claim_id, value);
        }
      }
    }
  }

  let paired = 0;
  let flips = 0;
  let twoStepMoves = 0;
  const preCap: Record<string, number> = {};
  const postCap: Record<string, number> = {};
  for (const record of rubric) {
    if (record.verdict_pre_cap != null) {
      preCap[record.verdict_pre_cap] =
        (preCap[record.verdict_pre_cap] ?? 0) + 1;
    }
    const mineValue = record.verdict_post_cap;
    if (mineValue == null) {
      continue;
    }
    postCap[mineValue] = (postCap[mineValue] ?? 0) + 1;
    const reference = referenceByClaim.get(record.claim_id);
    if (reference === undefined) {
      continue;
    }
    paired += 1;
    if (reference !== mineValue) {
      flips += 1;
    }
    if (isTwoStep(reference, mineValue)) {
      twoStepMoves += 1;
    }
  }

  // Attribution relation flips: reported, never gating — four values plus a
  // confidence float, and the divergence rule makes the effect on a claim's
  // fate non-linear.
  const relationReference = new Map<string, RelationType>();
  if (arm.reference !== "fixture") {
    for (const record of records) {
      if (
        record.arm === arm.reference &&
        record.job_kind === "attribution" &&
        record.relation_type != null &&
        record.evidence_id !== null
      ) {
        relationReference.set(record.evidence_id, record.relation_type);
      }
    }
  }
  let relationPaired = 0;
  let relationFlips = 0;
  for (const record of attribution) {
    const mineValue = record.relation_type;
    if (mineValue == null || record.evidence_id === null) {
      continue;
    }
    const reference =
      arm.reference === "fixture"
        ? (record.ground_truth_relation_type ?? undefined)
        : relationReference.get(record.evidence_id);
    if (reference === undefined || reference === null) {
      continue;
    }
    relationPaired += 1;
    if (reference !== mineValue) {
      relationFlips += 1;
    }
  }

  const clauseHits = new Map<string, number>();
  const plainChars: number[] = [];
  const caveatChars: number[] = [];
  const technicalChars: number[] = [];
  const overlapRatios: number[] = [];
  const templateDigests = new Map<string, string>();
  const models = new Set<string>();
  const contracts = new Set<string>();
  let hedgePlain = 0;
  let hedgeTechnical = 0;
  let refusals = 0;
  let refusalDenominator = 0;
  let firstAttempt = 0;
  let completed = 0;
  let exhausted = 0;

  for (const record of mine) {
    templateDigests.set(
      `${record.job_kind} v${record.prompt_version}`,
      record.template_sha256,
    );
    if (record.model !== null) {
      models.add(record.model);
    }
    if (record.contract !== null) {
      contracts.add(record.contract);
    }
    if (record.status === "ok") {
      completed += 1;
      if (record.attempts === 1) {
        firstAttempt += 1;
      }
    } else {
      exhausted += 1;
    }
    for (const failure of record.failed_clauses) {
      const key = clauseKey(failure.message);
      clauseHits.set(key, (clauseHits.get(key) ?? 0) + 1);
    }
    if (record.joined_reasoning !== null) {
      refusalDenominator += 1;
      if (refusesSubstitution(record.joined_reasoning)) {
        refusals += 1;
      }
    }
    const output = record.output as {
      reasoning_plain?: string;
      caveat?: string | null;
      reasoning_technical?: string;
    } | null;
    if (typeof output?.reasoning_plain === "string") {
      plainChars.push(output.reasoning_plain.length);
      hedgePlain += hedgeHits(output.reasoning_plain);
    }
    if (typeof output?.caveat === "string") {
      caveatChars.push(output.caveat.length);
    }
    if (typeof output?.reasoning_technical === "string") {
      technicalChars.push(output.reasoning_technical.length);
      hedgeTechnical += hedgeHits(output.reasoning_technical);
    }
    if (
      typeof output?.reasoning_plain === "string" &&
      typeof output?.reasoning_technical === "string"
    ) {
      const ratio = overlapRatio(
        output.reasoning_plain,
        output.reasoning_technical,
      );
      if (ratio !== null) {
        overlapRatios.push(ratio);
      }
    }
  }

  const allowedFlips = Math.floor(paired * MAX_FLIP_RATIO);
  return {
    arm: arm.name,
    reference: arm.reference,
    paired,
    flips,
    twoStepMoves,
    // The rule, both clauses, evaluated on the PERSISTED verdict.
    passed: paired > 0 && flips <= allowedFlips && twoStepMoves === 0,
    allowedFlips,
    preCap,
    postCap,
    relationFlips,
    relationPaired,
    firstAttempt,
    completed,
    exhausted,
    clauseHits,
    plainChars,
    caveatChars,
    technicalChars,
    hedgePlain,
    hedgeTechnical,
    overlapRatios,
    refusals,
    refusalDenominator,
    templateDigests,
    models,
    contracts,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)} %`;
}

function median(values: readonly number[]): string {
  if (values.length === 0) {
    return "n/a";
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return `${Math.round(value)} (min ${sorted[0]}, max ${sorted[sorted.length - 1]})`;
}

function gateLine(analysis: ArmAnalysis): string {
  return (
    `${GATE_MARKER} ${analysis.passed ? "PASS" : "FAIL"} arm=${analysis.arm} ` +
    `flips=${analysis.flips}/${analysis.paired} two_step=${analysis.twoStepMoves}`
  );
}

function distributionRow(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort();
  return entries.length === 0
    ? "—"
    : entries.map(([key, count]) => `${key} ${count}`).join(", ");
}

function writeReport(
  file: string,
  options: Options,
  records: readonly ResultRecord[],
  analyses: readonly ArmAnalysis[],
  corpus: FixtureCorpus | null,
  haltedAfterFloor: boolean,
): void {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push(
    "# Verdict comparison — prompt v1.1.0 against v1.2.0 (PROMPT-05 ship gate)",
  );
  push();
  push(
    "Generated by `scripts/compare-prompt-verdicts.ts`. Do not hand-edit the " +
      "`GATE_RESULT:` lines below.",
  );
  push();
  push(
    "Why those lines exist: everything else in this ship gate is already " +
      "mechanical — the report exists, it quotes the pre-registered rule, and " +
      "03-05's own test pins the constant's post-state. *This arm passed* was " +
      "the one link carried only by a human having read a paragraph. One " +
      "printed line per arm closes it, and 03-05 greps for it before it edits " +
      "`DEFAULT_RUBRIC_VERSION`. A line edited to read `PASS` because the " +
      "prose beside it argues for one is the exact substitution the whole gate " +
      "exists to prevent.",
  );
  push();

  push("## Run metadata");
  push();
  push("| Field | Value |");
  push("| --- | --- |");
  push(`| Report written | ${new Date().toISOString()} |`);
  push(`| Backend | ${options.backendId ?? "(dry run — no backend)"} |`);
  const models = new Set(analyses.flatMap((a) => [...a.models]));
  push(
    `| Models reported | ${models.size === 0 ? "—" : [...models].sort().join(", ")} |`,
  );
  push(
    `| Pre-run smoke check | ${options.smokeResult ?? "not recorded — pass --smoke-result"} |`,
  );
  push(
    `| Corpus | ${
      corpus === null
        ? "not read in this invocation"
        : `${corpus.claims.length} claims, ${corpus.claims_with_ground_truth} with a recorded calibration_result, frozen ${corpus.generated_at}`
    } |`,
  );
  push(`| Records in NDJSON | ${records.length} |`);
  push(`| Sample cap for this invocation | ${options.sampleSize ?? "none"} |`);
  push();
  push("| Arm | Ran | Paired N | Contract(s) seen | Template digests |");
  push("| --- | --- | --- | --- | --- |");
  for (const arm of ARMS) {
    const analysis = analyses.find((entry) => entry.arm === arm.name);
    if (analysis === undefined) {
      push(`| ${arm.name} | no — not recorded | — | — | — |`);
      continue;
    }
    const digests = [...analysis.templateDigests]
      .sort()
      .map(([label, digest]) => `${label} \`${digest.slice(0, 12)}…\``)
      .join("<br>");
    push(
      `| ${arm.name} | yes (${analysis.completed} ok, ${analysis.exhausted} exhausted) ` +
        `| ${analysis.paired} | ${[...analysis.contracts].sort().join(", ") || "—"} | ${digests} |`,
    );
  }
  push();
  const missing = ARMS.filter(
    (arm) => !analyses.some((entry) => entry.arm === arm.name),
  );
  if (missing.length > 0) {
    push(
      `**Incomplete:** ${missing
        .map((arm) => arm.name)
        .join(
          ", ",
        )} — no record in the NDJSON. An arm with no line below did ` +
        "not run; that is stated here in words rather than implied by absence.",
    );
    push();
  }
  if (haltedAfterFloor) {
    push(
      "**The run stopped after the noise-floor arm.** The floor alone exceeds " +
        "the pre-registered rule, so this gate cannot distinguish a prompt " +
        "effect from model nondeterminism at this sample size. The remaining " +
        "arms were not run and the tolerance rule was NOT adjusted to fit. " +
        "What to do next is 03-05's decision, not this script's.",
    );
    push();
  }

  push("## Gating result");
  push();
  push(
    "The pre-registered tolerance rule, quoted verbatim — written down before any data existed:",
  );
  push();
  push(`> ${PRE_REGISTERED_TOLERANCE}`);
  push();
  push(
    "Evaluated on the PERSISTED (post-cap) verdict, as a ratio so a reduced-N " +
      `arm is evaluable: flips / N ≤ ${MAX_FLIP_RATIO.toFixed(4)}, and zero moves ` +
      "between `licensed` and `pending_adjudication`. The PAIRED per-claim flip " +
      "count is the statistic; the distributions further down are reported and " +
      "do not gate, because at N = 30 two arms can show identical counts with " +
      "every individual claim swapped.",
  );
  push();
  push(
    "| Arm | Paired against | Paired N | Flips | Allowed | Two-step moves | Result |",
  );
  push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const analysis of analyses) {
    push(
      `| ${analysis.arm} | ${analysis.reference} | ${analysis.paired} | ` +
        `${analysis.flips} (${percent(analysis.flips, analysis.paired)}) | ` +
        `≤ ${analysis.allowedFlips} | ${analysis.twoStepMoves} | ` +
        `**${analysis.passed ? "PASS" : "FAIL"}** |`,
    );
  }
  push();
  for (const analysis of analyses) {
    if (analysis.paired === 0) {
      // A FAIL with no pairs is NOT a tolerance breach and must never be read
      // as one — nor as a pass. The arm ran but nothing could be compared,
      // usually because the arm it is paired against has not run yet.
      push(
        `Note: \`${analysis.arm}\` has NO paired claims — nothing could be ` +
          `compared against \`${analysis.reference}\`, so the rule was not ` +
          "evaluable. It is recorded as `FAIL` because an arm that was not " +
          "measured must never read `PASS`; it is not a tolerance breach. " +
          `Run \`${analysis.reference}\` first, or re-run this arm.`,
      );
      continue;
    }
    if (analysis.paired < 30) {
      push(
        `Note: \`${analysis.arm}\` was evaluated at a REDUCED N of ` +
          `${analysis.paired}, not 30 — the rule's ratio form was applied and ` +
          "the comparison is correspondingly weaker.",
      );
    }
  }
  push();
  push("```");
  for (const analysis of analyses) {
    push(gateLine(analysis));
  }
  push("```");
  push();

  push("## Verdict distributions (reported, not gating)");
  push();
  push("| Arm | Pre-cap (the model's own verdict) | Post-cap (persisted) |");
  push("| --- | --- | --- |");
  for (const analysis of analyses) {
    push(
      `| ${analysis.arm} | ${distributionRow(analysis.preCap)} | ${distributionRow(analysis.postCap)} |`,
    );
  }
  push();
  push(
    "Both columns are recorded per result because `combineCalibrationResult` " +
      "sits between them, is untouched by this phase, and therefore absorbs " +
      "part of any upward drift. A single number would hide exactly that.",
  );
  push();

  push("## First-attempt contract pass rate");
  push();
  push("| Arm | Completed | First attempt | Rate | Exhausted |");
  push("| --- | --- | --- | --- | --- |");
  for (const analysis of analyses) {
    push(
      `| ${analysis.arm} | ${analysis.completed} | ${analysis.firstAttempt} | ` +
        `${percent(analysis.firstAttempt, analysis.completed)} | ${analysis.exhausted} |`,
    );
  }
  push();
  push(
    "This is the cheapest available calibration of *is this contract " +
      "achievable*, and it is the input to 03-05's re-examination of the " +
      "plain-layer character cap. It is reported, not gated.",
  );
  push();
  for (const analysis of analyses) {
    const repeated = [...analysis.clauseHits]
      .filter(([, count]) => count > 2)
      .sort((left, right) => right[1] - left[1]);
    if (repeated.length === 0) {
      continue;
    }
    push(`Clauses that fired more than twice in \`${analysis.arm}\`:`);
    push();
    for (const [key, count] of repeated) {
      push(`- ${count}× — ${key}`);
    }
    push();
  }

  push("## Non-gating diagnostics");
  push();
  push(
    "| Arm | Plain chars (median) | Caveat chars | Technical chars | Hedge hits plain/technical | Plain∩technical overlap | Quote refusals |",
  );
  push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const analysis of analyses) {
    const overlap =
      analysis.overlapRatios.length === 0
        ? "n/a"
        : `${(
            (analysis.overlapRatios.reduce((sum, value) => sum + value, 0) /
              analysis.overlapRatios.length) *
            100
          ).toFixed(1)} % (mean)`;
    push(
      `| ${analysis.arm} | ${median(analysis.plainChars)} | ${median(analysis.caveatChars)} ` +
        `| ${median(analysis.technicalChars)} | ${analysis.hedgePlain}/${analysis.hedgeTechnical} ` +
        `| ${overlap} | ${analysis.refusals}/${analysis.refusalDenominator} ` +
        `(${percent(analysis.refusals, analysis.refusalDenominator)}) |`,
    );
  }
  push();
  push("| Arm | Attribution relation_type flips | Paired evidence |");
  push("| --- | --- | --- |");
  for (const analysis of analyses) {
    push(
      `| ${analysis.arm} | ${analysis.relationFlips} ` +
        `(${percent(analysis.relationFlips, analysis.relationPaired)}) | ${analysis.relationPaired} |`,
    );
  }
  push();
  push(
    "None of the above gates anything. The hedge count comes from a word list " +
      "defined in the harness — a diagnostic, because a word-list lint " +
      "false-positives on legitimate German and a retry loop on grammatical " +
      "prose is worse than its miss rate. No readability score is computed. " +
      "The quote-refusal rate reproduces the display tier's own refusal " +
      "condition and is reported only; it does not license relaxing that logic.",
  );
  push();

  push("## Side-by-side prose dump");
  push();
  push(
    "The deliverable the human diff review reads. Nothing mechanical replaces " +
      "it: it is the only check that catches semantic overstatement — a plain " +
      "layer asserting more than the technical layer supports.",
  );
  push();
  const claimIds = [
    ...new Set(
      records.filter((r) => r.job_kind === "rubric").map((r) => r.claim_id),
    ),
  ].sort();
  for (const claimId of claimIds) {
    const forClaim = records.filter(
      (record) => record.claim_id === claimId && record.job_kind === "rubric",
    );
    const text = forClaim.find(
      (record) => record.claim_text !== undefined,
    )?.claim_text;
    push(`### ${claimId}`);
    push();
    if (text !== undefined) {
      push(`> ${text}`);
      push();
    }
    for (const arm of ARMS) {
      const record = forClaim.find((entry) => entry.arm === arm.name);
      if (record === undefined) {
        continue;
      }
      push(
        `**${arm.name}** (v${record.prompt_version}, ${record.verdict_pre_cap ?? "-"} → ${record.verdict_post_cap ?? "-"})`,
      );
      push();
      push("```text");
      push(
        record.joined_reasoning ??
          "(no output — the unit exhausted its attempts)",
      );
      push("```");
      push();
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readCorpus(file: string): FixtureCorpus | null {
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as FixtureCorpus;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    printHelp();
    return 0;
  }
  if (parsed === null) {
    console.error("");
    console.error("run with --help for the arm names and the resume behaviour");
    return 2;
  }
  const options = parsed;
  const resultsFile = path.join(options.outDir, "results.ndjson");
  const reportFile = path.join(options.outDir, "REPORT.md");
  fs.mkdirSync(options.outDir, { recursive: true });

  const existing = readRecords(resultsFile);
  const already = new Set(existing.map(recordKey));
  const corpus = readCorpus(options.fixturesPath);
  console.log(`records already recorded: ${existing.length}`);

  if (options.dryRun) {
    // Deliberately tolerant of a missing corpus: this mode exists to prove
    // the gate line is emitted and greppable BEFORE any quota is spent on
    // producing a real one, and it must run against a hand-written NDJSON on
    // a machine that has no fixture corpus at all.
    if (corpus === null) {
      console.log(
        `no corpus at ${options.fixturesPath} — reporting from the NDJSON alone`,
      );
    } else {
      const claims = selectClaims(corpus, options.sampleSize);
      for (const armName of options.arms) {
        const arm = ARMS.find((entry) => entry.name === armName);
        if (arm === undefined) {
          continue;
        }
        let total = 0;
        let skipped = 0;
        for (const claim of claims) {
          for (const evidence of claim.evidence) {
            total += 1;
            if (
              already.has(
                unitKey(arm.name, claim.id, "attribution", evidence.id),
              )
            ) {
              skipped += 1;
            }
          }
          total += 1;
          if (already.has(unitKey(arm.name, claim.id, "rubric", null))) {
            skipped += 1;
          }
        }
        console.log(
          `${arm.name}: would skip ${skipped} of ${total} units, ${total - skipped} calls remaining`,
        );
      }
    }
    const analyses = ARMS.map((arm) => analyseArm(arm, existing)).filter(
      (entry): entry is ArmAnalysis => entry !== null,
    );
    writeReport(reportFile, options, existing, analyses, corpus, false);
    console.log(`wrote ${reportFile} (dry run — no CLI call was made)`);
    for (const analysis of analyses) {
      console.log(gateLine(analysis));
    }
    return 0;
  }

  if (corpus === null) {
    console.error(
      `no fixture corpus at ${options.fixturesPath}. Produce it first with ` +
        "scripts/extract-verdict-fixtures.ts on the machine that holds the " +
        "real registers.",
    );
    return 1;
  }
  const backendId = options.backendId;
  if (backendId === null) {
    return 2;
  }

  const claims = selectClaims(corpus, options.sampleSize);
  const backend = buildBackend(backendId);
  const attempts: CapturedAttempt[] = [];
  const orchestrator = new Orchestrator({
    backends: [backend],
    traceSink: capturingTraceSink(attempts),
    // Serial. Agent-CLI calls are heavy and the arms must be comparable;
    // parallelism would change the latency numbers and nothing else.
    gate: createConcurrencyGate(1),
    policy: RETRY_POLICY,
  });
  // A throwaway directory, exactly as the manual smoke script builds one.
  // No real project directory is ever named here.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-verdicts-"));
  console.log(`backend: ${backend.id}`);
  console.log(`throwaway project directory: ${projectDir}`);
  console.log(
    `claims this invocation: ${claims.length} of ${corpus.claims.length}`,
  );

  let haltedAfterFloor = false;
  let paused: PausedError | null = null;
  try {
    for (const armName of options.arms) {
      const arm = ARMS.find((entry) => entry.name === armName);
      if (arm === undefined) {
        continue;
      }
      const ruleSet = loadRubricRuleSet(arm.ruleSetVersion);
      // The artifact must name the bytes it measured: a template edited
      // mid-run shows up here as a mismatch rather than as an unexplained
      // shift between arms.
      const rubricPin = ruleSet.prompt_template_sha256;
      const attributionPin = ruleSet.attribution_template_sha256;
      console.log(
        `    pins in ${arm.ruleSetVersion}: rubric ${rubricPin.slice(0, 12)}…, ` +
          `attribution ${attributionPin?.slice(0, 12) ?? "(none — unpinned variant)"}…`,
      );

      await runArm(
        arm,
        claims,
        orchestrator,
        backendId,
        projectDir,
        attempts,
        resultsFile,
        already,
      );

      if (arm.name === "noise-floor") {
        const analysis = analyseArm(arm, readRecords(resultsFile));
        if (analysis !== null && analysis.paired === 0) {
          // Not a breach and not a pass: nothing could be compared. Spending
          // the other arms against an unmeasured floor is the waste the halt
          // exists to prevent, but the report must not call this a FAIL of
          // the rule — the note beside the gate table says so.
          console.error(
            "\nthe noise-floor arm produced NO paired claims — the selected " +
              "claims carry no recorded calibration_result. The floor is " +
              "unmeasured, not breached. Stopping before the remaining arms; " +
              "re-run with claims that carry a recorded verdict.",
          );
          break;
        }
        if (analysis !== null && !analysis.passed) {
          haltedAfterFloor = true;
          console.error(
            `\nthe noise floor alone exceeds the pre-registered rule ` +
              `(${analysis.flips}/${analysis.paired} flips, ${analysis.twoStepMoves} two-step). ` +
              "Stopping: the remaining arms would be uninterpretable, and the " +
              "tolerance is NOT adjusted to fit. The decision belongs to 03-05.",
          );
          break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof PausedError)) {
      throw error;
    }
    paused = error;
    console.error(`\n${error.message}`);
    console.error(
      "Everything recorded so far is on disk. Re-run the same command when " +
        "quota returns; the harness skips what it already has.",
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  const finalRecords = readRecords(resultsFile);
  const analyses = ARMS.map((arm) => analyseArm(arm, finalRecords)).filter(
    (entry): entry is ArmAnalysis => entry !== null,
  );
  writeReport(
    reportFile,
    options,
    finalRecords,
    analyses,
    corpus,
    haltedAfterFloor,
  );
  console.log(`\nwrote ${reportFile}`);
  for (const analysis of analyses) {
    console.log(gateLine(analysis));
  }
  return paused === null ? 0 : 3;
}

main().then((code) => {
  process.exitCode = code;
});

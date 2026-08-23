/**
 * Freezes a fixture corpus for the PROMPT-05 ship gate out of the REAL
 * project registers on this machine. Deliberately NOT part of the vitest
 * suite — it can only run where the gitignored local workspace directory
 * with real registers exists, which is one specific machine: not a fresh
 * clone, not CI, not a cloud session.
 *
 *   npx tsx scripts/extract-verdict-fixtures.ts <workspace-root>
 *   npx tsx scripts/extract-verdict-fixtures.ts <workspace-root> --out <path>
 *
 * The workspace root is an ARGUMENT rather than an environment lookup on
 * purpose: an explicit path makes the precondition checkable in one line and
 * keeps the script honest about the fact that it runs on one machine.
 *
 * It READS registers and never writes one. There is no store opened here and
 * no register write of any kind — the only file this script creates is the
 * corpus JSON. (Grep-verified by the plan's acceptance criteria, which is why
 * the sentence above avoids spelling the call forms out.)
 *
 * Redaction is BY CONSTRUCTION, not by review: the emitted claim record is
 * typed as the adapter layer's own `ClaimContext` / `EvidenceContext` plus a
 * ground-truth and a borderline block, so the only way an actor handle, a
 * chain hash, a blob path, a history entry, a complaint text or an
 * adjudication note could reach the file is by widening those types. The
 * verbatim excerpts DO stay — attribution judges strictly against the
 * excerpt, so they are load-bearing, and they are exactly what the human
 * content review before the commit is for.
 *
 * Claim ids are NAMESPACED per register (`r1.clm_0001`, `r2.clm_0001`, …).
 * Every register numbers its claims from `clm_0001`, so three registers of
 * the same briefing collide on every id — and the comparison harness keys
 * its resume skip-list and its ground-truth pairing on the claim id alone.
 * Without the prefix a resumed run would skip the wrong register's claims
 * and pair one register's verdict against another's ground truth, silently.
 * The prefix is the register's ordinal in sorted directory order, never the
 * directory name, so no project id reaches the file.
 *
 * Run it from the `software/` directory: `loadRubricRuleSet` resolves the
 * rule files from the process working directory.
 */
import fs from "node:fs";
import path from "node:path";

import type { ClaimContext, EvidenceContext } from "../lib/adapters";
import type {
  CalibrationResult,
  RelationType,
  SourceType,
} from "../lib/register";
import { ClaimsRegister } from "../lib/register";
// Deep import, deliberately: `evaluateMechanicalRubric` and
// `loadRubricRuleSet` are internals of the verification package and sit off
// the `lib/pipeline` barrel. Recomputing the mechanical verdict with a
// re-implementation instead would make the "mechanical_not_met" proxy a
// second opinion about production rather than a recording of it — and
// putting them ON the barrel would move a pinned public surface in a plan
// that changes no production code. `scripts/` is outside the architecture
// test's scanned domain and outside the ESLint import restrictions (which
// cover `lib/**` and `cli/**`), so this is a sanctioned exception rather
// than a hole in the layering.
import {
  evaluateMechanicalRubric,
  loadRubricRuleSet,
} from "../lib/pipeline/verification/rubric-rules";

/** The gate is meaningless below this; the plan forbids lowering it. */
const MIN_CLAIMS = 30;

/**
 * The three borderline proxies, recorded per claim as explicit booleans so
 * "borderline cases are included" is a checkable fact about the file rather
 * than a sentence in a document.
 */
interface BorderlineProxies {
  /** The recorded calibration result is `weakened` or `pending_adjudication`. */
  readonly weakened_or_parked: boolean;
  /** The mechanical rubric evaluated to not-met, so the cap fired. */
  readonly mechanical_not_met: boolean;
  /** Some evidence carries more than one judgment — the second-opinion rule fired. */
  readonly second_opinion_fired: boolean;
}

/**
 * What the v1.1.0-era production run recorded for this claim. The harness
 * compares its own generations against these values, so the corpus carries
 * the vintage that produced them: a project pinned to `se-evidence-rubric-v1`
 * recorded its verdict under rubric template 1.0.0, not 1.1.0, and a report
 * that did not say so would overstate how clean the baseline is.
 */
interface GroundTruth {
  /** `null` for a claim that never reached stage 3. */
  readonly calibration_result: CalibrationResult | null;
  /** Evidence id → the resolved relation type, where one was recorded. */
  readonly relation_types: Readonly<Record<string, RelationType>>;
  /** Recomputed with the production function, not read from the register. */
  readonly mechanical: "met" | "not_met";
  /** The rule set the recording project was pinned to. */
  readonly rubric_version: string;
  /** The rubric prompt template that rule set names. */
  readonly rubric_template_version: string;
  /** The attribution prompt template that rule set names. */
  readonly attribution_template_version: string;
}

/**
 * One corpus claim: exactly the fields a job input needs, plus the recorded
 * ground truth and the borderline proxies. `ClaimContext` and
 * `EvidenceContext` are the adapter layer's own projections — reusing them
 * here is what makes the field set an assertion the compiler checks.
 */
interface FixtureClaim extends ClaimContext {
  readonly evidence: readonly EvidenceContext[];
  readonly ground_truth: GroundTruth;
  readonly borderline: BorderlineProxies;
}

interface FixtureCorpus {
  readonly generated_at: string;
  /** How many registers contributed. Deliberately NOT their ids or paths. */
  readonly source_project_count: number;
  /** Claims carrying a recorded `calibration_result` — the paired baseline. */
  readonly claims_with_ground_truth: number;
  readonly claims: readonly FixtureClaim[];
}

interface Options {
  readonly workspaceRoot: string;
  readonly outPath: string;
}

function parseArgs(argv: readonly string[]): Options | null {
  const positional: string[] = [];
  let outPath = path.join("tests", "corpus", "verdict-fixtures.json");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined) {
        return null;
      }
      outPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      return null;
    }
    positional.push(arg);
  }
  const workspaceRoot = positional[0];
  if (workspaceRoot === undefined || positional.length > 1) {
    return null;
  }
  return { workspaceRoot, outPath };
}

/** Project directories under the workspace root that hold a register. */
function registerFiles(workspaceRoot: string): string[] {
  return fs
    .readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceRoot, entry.name, "claims.json"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function extractFromRegister(
  file: string,
  registerOrdinal: number,
): FixtureClaim[] {
  const register = ClaimsRegister.parse(
    JSON.parse(fs.readFileSync(file, "utf8")),
  );
  const ruleSet = loadRubricRuleSet(register.config.rubric_version);
  const sourceTypeById = new Map<string, SourceType>(
    register.sources.map((source) => [source.id, source.custom.source_type]),
  );

  const claims: FixtureClaim[] = [];
  for (const claim of register.claims) {
    const evidence: EvidenceContext[] = [];
    const relationTypes: Record<string, RelationType> = {};
    let secondOpinionFired = false;

    for (const item of claim.evidence) {
      const sourceType = sourceTypeById.get(item.source_id);
      if (sourceType === undefined) {
        // A claim whose evidence names a source the register does not carry
        // cannot produce a valid job input, so it is dropped rather than
        // patched with a guessed source type — the rubric weighs the type.
        continue;
      }
      evidence.push({
        id: item.id,
        source_id: item.source_id,
        source_type: sourceType,
        locator: item.locator,
        verbatim_excerpt: item.verbatim_excerpt,
      });
      if (item.relation_type !== undefined) {
        relationTypes[item.id] = item.relation_type;
      }
      if (item.judgments.length > 1) {
        secondOpinionFired = true;
      }
    }

    if (evidence.length === 0) {
      // Nothing to attribute and nothing for the rubric to weigh.
      continue;
    }

    // The mechanical half, computed exactly the way production computes it:
    // over the types of the DISTINCT pertinent sources, one entry per source.
    const pertinentSourceTypes = [
      ...new Map(
        evidence
          .filter((item) => {
            const relation = relationTypes[item.id];
            return relation === "supports" || relation === "partially_supports";
          })
          .map((item) => [item.source_id, item.source_type] as const),
      ).values(),
    ];
    const rule = ruleSet.claim_types[claim.claim_type];
    const mechanical =
      rule === undefined
        ? "not_met"
        : evaluateMechanicalRubric(pertinentSourceTypes, rule);

    const calibrationResult = claim.calibration_result ?? null;
    claims.push({
      id: `r${registerOrdinal}.${claim.id}`,
      text: claim.text,
      claim_type: claim.claim_type,
      briefing_anchor: claim.briefing_anchor,
      evidence,
      ground_truth: {
        calibration_result: calibrationResult,
        relation_types: relationTypes,
        mechanical,
        rubric_version: register.config.rubric_version,
        rubric_template_version: ruleSet.prompt_template_version,
        attribution_template_version: ruleSet.attribution_template_version,
      },
      borderline: {
        weakened_or_parked:
          calibrationResult === "weakened" ||
          calibrationResult === "pending_adjudication",
        mechanical_not_met: mechanical === "not_met",
        second_opinion_fired: secondOpinionFired,
      },
    });
  }
  return claims;
}

function isBorderline(claim: FixtureClaim): boolean {
  return (
    claim.borderline.weakened_or_parked ||
    claim.borderline.mechanical_not_met ||
    claim.borderline.second_opinion_fired
  );
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    console.error(
      "usage: npx tsx scripts/extract-verdict-fixtures.ts <workspace-root> [--out <path>]",
    );
    return 2;
  }

  // The plan's execution precondition, asserted before anything is read.
  if (!fs.existsSync(options.workspaceRoot)) {
    console.error(
      `workspace root "${options.workspaceRoot}" does not exist — this script ` +
        "can only run on the machine that holds the real registers. Do not " +
        "substitute the demo project and do not author claims: a fabricated " +
        "corpus makes the ship gate a ceremony.",
    );
    return 1;
  }

  const files = registerFiles(options.workspaceRoot);
  if (files.length === 0) {
    console.error(
      `no project register found under "${options.workspaceRoot}" ` +
        "(expected <root>/<project>/claims.json)",
    );
    return 1;
  }
  console.log(`registers: ${files.length}`);

  const claims = files
    .flatMap((file, index) => extractFromRegister(file, index + 1))
    // Sorted by claim id so a re-extraction produces a readable diff rather
    // than a reshuffled file.
    .sort((left, right) => left.id.localeCompare(right.id));

  const borderline = claims.filter(isBorderline);
  const withGroundTruth = claims.filter(
    (claim) => claim.ground_truth.calibration_result !== null,
  );
  const evidenceCount = claims.reduce(
    (total, claim) => total + claim.evidence.length,
    0,
  );

  console.log(`claims: ${claims.length} (evidence ${evidenceCount})`);
  console.log(
    `borderline: ${borderline.length}` +
      ` (weakened/parked ${claims.filter((c) => c.borderline.weakened_or_parked).length},` +
      ` mechanical not_met ${claims.filter((c) => c.borderline.mechanical_not_met).length},` +
      ` second opinion ${claims.filter((c) => c.borderline.second_opinion_fired).length})`,
  );
  console.log(`with recorded calibration_result: ${withGroundTruth.length}`);

  const vintages = new Map<string, number>();
  for (const claim of claims) {
    const key =
      `${claim.ground_truth.rubric_version} ` +
      `(rubric ${claim.ground_truth.rubric_template_version},` +
      ` attribution ${claim.ground_truth.attribution_template_version})`;
    vintages.set(key, (vintages.get(key) ?? 0) + 1);
  }
  for (const [vintage, count] of [...vintages].sort()) {
    console.log(`ground-truth vintage: ${count} claim(s) from ${vintage}`);
  }

  if (claims.length < MIN_CLAIMS) {
    console.error(
      `only ${claims.length} claims survived, fewer than the ${MIN_CLAIMS} the ` +
        "gate requires. Stop and report — do not lower N and do not author " +
        "substitute claims.",
    );
    return 1;
  }
  if (borderline.length === 0) {
    console.error(
      "no borderline claim is present. A corpus that cannot exercise the " +
        "interesting cases cannot prove stability. Stop and report.",
    );
    return 1;
  }

  // Not a halt, but it decides the sample size of the two arms that compare
  // against the recorded ground truth, so it must be visible before any
  // quota is spent rather than discovered in the report.
  if (withGroundTruth.length < MIN_CLAIMS) {
    console.warn(
      `WARNING: only ${withGroundTruth.length} of ${claims.length} claims carry a ` +
        "recorded calibration_result. The noise-floor and v1.1.0-baseline arms " +
        "are paired against those claims only, so their N is smaller than the " +
        "v1.2.0 arms'. The report states this beside the number; do not round " +
        "it away.",
    );
  }

  const corpus: FixtureCorpus = {
    generated_at: new Date().toISOString(),
    source_project_count: files.length,
    claims_with_ground_truth: withGroundTruth.length,
    claims,
  };

  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
  // Two-space indent with a trailing newline: what Prettier's JSON printer
  // produces for an already-expanded object, so the committed file survives
  // `npm run format:check`. If it ever disagrees, `npm run format` is the
  // fix — the file stays byte-stable across re-extractions either way.
  fs.writeFileSync(
    options.outPath,
    `${JSON.stringify(corpus, null, 2)}\n`,
    "utf8",
  );
  console.log(`wrote ${options.outPath}`);
  console.log(
    "NOT committed by this script: the verbatim excerpts are third-party " +
      "text and the claim texts are your own briefings. A human content " +
      "review gates the commit (03-04 Task 2).",
  );
  return 0;
}

process.exitCode = main();

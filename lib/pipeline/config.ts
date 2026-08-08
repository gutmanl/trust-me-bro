import { getCurrentActor } from "../identity";
import type { ProjectConfig, ProjectEvent } from "../register";
import { InvalidProjectInputError, RunActiveError } from "./errors";
import { buildBackendsConfig, requireProjectStore } from "./projects";
import type { BackendCli } from "./projects";
import { getGlobalJobRunner } from "./runs/job-runner";
import type { JobRunner } from "./runs/job-runner";
import { loadRubricRuleSet } from "./verification/rubric-rules";

/**
 * Project settings use-case (TMB-46): the config block is editable per
 * project; every effective change is recorded as a config_changed chain
 * event carrying the complete before/after pair — "which value, by whom,
 * when" is answered structurally (config_change / actor / at), the reason
 * text summarizes only the changed fields for the history view.
 */

export interface UpdateProjectConfigInput {
  rubricVersion: string;
  adjudicationSampleRate: number;
  maxRepairCycles: number;
  primaryCli: BackendCli;
  /** Absent = single model family; second_opinion is dropped with it. */
  secondaryCli?: BackendCli;
  secondOpinion?: {
    confidenceThreshold: number;
    onRelationNotStuetzt: boolean;
  };
}

export interface UpdateProjectConfigResult {
  config: ProjectConfig;
  /** Null when the submitted values equal the current config (no event). */
  event: ProjectEvent | null;
  changedFields: string[];
}

const BACKEND_CLIS: readonly BackendCli[] = ["claude", "codex"];

function validate(input: UpdateProjectConfigInput): void {
  if (!BACKEND_CLIS.includes(input.primaryCli)) {
    throw new InvalidProjectInputError(
      `Unbekanntes primäres Backend "${input.primaryCli}".`,
    );
  }
  if (input.secondaryCli && !BACKEND_CLIS.includes(input.secondaryCli)) {
    throw new InvalidProjectInputError(
      `Unbekanntes sekundäres Backend "${input.secondaryCli}".`,
    );
  }
  if (input.secondaryCli && input.secondaryCli === input.primaryCli) {
    // The same rule createProject enforces: with the two-CLI registry the
    // CLI determines the model family, so same CLI = same family — an
    // invalid combination under an active divergence rule.
    throw new InvalidProjectInputError(
      "Die zweite Modellfamilie muss sich von der ersten unterscheiden (Divergenzregel).",
    );
  }
  if (
    !Number.isFinite(input.adjudicationSampleRate) ||
    input.adjudicationSampleRate < 0 ||
    input.adjudicationSampleRate > 1
  ) {
    throw new InvalidProjectInputError(
      "Die Stichprobenrate muss zwischen 0 und 1 liegen.",
    );
  }
  if (!Number.isInteger(input.maxRepairCycles) || input.maxRepairCycles < 1) {
    throw new InvalidProjectInputError(
      "Die maximale Zahl der Reparaturzyklen muss eine ganze Zahl ≥ 1 sein.",
    );
  }
  try {
    loadRubricRuleSet(input.rubricVersion);
  } catch (error) {
    throw new InvalidProjectInputError(
      `Rubrikversion "${input.rubricVersion}" ist nicht prüfbar: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (input.secondOpinion) {
    const { confidenceThreshold } = input.secondOpinion;
    if (
      !Number.isFinite(confidenceThreshold) ||
      confidenceThreshold < 0 ||
      confidenceThreshold > 1
    ) {
      throw new InvalidProjectInputError(
        "Die Konfidenzschwelle der Divergenzregel muss zwischen 0 und 1 liegen.",
      );
    }
  }
}

function buildConfig(input: UpdateProjectConfigInput): ProjectConfig {
  return {
    rubric_version: input.rubricVersion.trim(),
    adjudication_sample_rate: input.adjudicationSampleRate,
    max_repair_cycles: input.maxRepairCycles,
    backends: buildBackendsConfig(input.primaryCli, input.secondaryCli),
    // second_opinion requires a secondary backend (schema refine); without
    // one it is dropped regardless of the submitted values, mirroring
    // createProject's auto-disable.
    ...(input.secondaryCli && input.secondOpinion
      ? {
          second_opinion: {
            confidence_threshold: input.secondOpinion.confidenceThreshold,
            on_relation_not_stuetzt: input.secondOpinion.onRelationNotStuetzt,
          },
        }
      : {}),
  };
}

/** Human-readable list of changed fields ("adjudication_sample_rate: 0.1 →
 * 0.2") for the event reason; the structural truth is the config_change
 * payload, this is display only. */
export function describeConfigChanges(
  previous: ProjectConfig,
  next: ProjectConfig,
): string[] {
  const changes: string[] = [];
  const compare = (field: string, before: unknown, after: unknown): void => {
    const render = (value: unknown): string =>
      value === undefined ? "–" : JSON.stringify(value);
    if (render(before) !== render(after)) {
      changes.push(`${field}: ${render(before)} → ${render(after)}`);
    }
  };
  compare("rubric_version", previous.rubric_version, next.rubric_version);
  compare(
    "adjudication_sample_rate",
    previous.adjudication_sample_rate,
    next.adjudication_sample_rate,
  );
  compare(
    "max_repair_cycles",
    previous.max_repair_cycles,
    next.max_repair_cycles,
  );
  compare(
    "backends.primary",
    previous.backends.primary.cli,
    next.backends.primary.cli,
  );
  compare(
    "backends.secondary",
    previous.backends.secondary?.cli,
    next.backends.secondary?.cli,
  );
  compare(
    "second_opinion.confidence_threshold",
    previous.second_opinion?.confidence_threshold,
    next.second_opinion?.confidence_threshold,
  );
  compare(
    "second_opinion.on_relation_not_stuetzt",
    previous.second_opinion?.on_relation_not_stuetzt,
    next.second_opinion?.on_relation_not_stuetzt,
  );
  return changes;
}

export async function updateProjectConfig(
  projectId: string,
  input: UpdateProjectConfigInput,
  deps: { runner?: JobRunner } = {},
): Promise<UpdateProjectConfigResult> {
  validate(input);
  const runner = deps.runner ?? getGlobalJobRunner();
  if (runner.isRunning(projectId)) {
    // A run reads its config once at start; an edit mid-run would not
    // corrupt it, but the UX would suggest otherwise — reject clearly.
    throw new RunActiveError(projectId);
  }
  const store = requireProjectStore(projectId);
  return store.transaction((tx) => {
    const previous = tx.getConfig();
    const next = buildConfig(input);
    const changedFields = describeConfigChanges(previous, next);
    if (changedFields.length === 0) {
      return { config: previous, event: null, changedFields };
    }
    const event = tx.updateConfig({
      config: next,
      actor: getCurrentActor(),
      reason: `Konfiguration geändert: ${changedFields.join("; ")}.`,
    });
    return { config: next, event, changedFields };
  });
}

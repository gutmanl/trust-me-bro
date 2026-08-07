/**
 * Public surface of the pipeline layer (epic TMB-3/TMB-4): the use-cases the
 * web layer calls. app/ imports exclusively from this barrel; module
 * internals stay internal.
 */
export * from "./errors";
export { mintProjectId, slugify } from "./ids";
export {
  createProject,
  DEFAULT_ADJUDICATION_SAMPLE_RATE,
  DEFAULT_RUBRIC_VERSION,
  getProjectSummary,
  listProjects,
  readProject,
} from "./projects";
export type {
  BackendCli,
  CreateProjectInput,
  ProjectSummary,
} from "./projects";

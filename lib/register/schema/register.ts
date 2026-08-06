import { z } from "zod";

import { Claim } from "./claim";
import { ProjectEvent } from "./history";
import { Project, ProjectConfig } from "./project";
import { Source } from "./source";

/** Semantic version of the field schema implemented by this module. */
export const SCHEMA_VERSION = "1.0.0";

/**
 * The canonical register file claims.json — sole source of truth for all
 * structured project data (file format appendix, normative). Six sections:
 * schema_version, project, config, sources[], claims[], project_events[].
 */
export const ClaimsRegister = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  project: Project,
  config: ProjectConfig,
  sources: z.array(Source),
  claims: z.array(Claim),
  project_events: z.array(ProjectEvent),
});
export type ClaimsRegister = z.infer<typeof ClaimsRegister>;

import type { Project } from "../schema/project";
import { canonicalize } from "./canonical-json";
import { sha256Hex } from "./hash";

/** The three project fields that are immutable after creation; the chain is
 * anchored to exactly these (file format appendix, normative invariant). */
export type ProjectIdentity = Pick<
  Project,
  "id" | "research_question" | "created_at"
>;

/**
 * prev_hash of the first chain entry (seq 1): the SHA-256 of the canonical
 * serialization of the project identity. Binding the chain to these fields
 * makes a changed research question by definition a new project.
 */
export function genesisPrevHash(project: ProjectIdentity): string {
  return sha256Hex(
    canonicalize({
      id: project.id,
      research_question: project.research_question,
      created_at: project.created_at,
    }),
  );
}

import { getCurrentActor } from "../../identity";
import { ProjectId, RegisterStore } from "../../register";
import type { Claim, ClaimsRegister, Source } from "../../register";
import {
  InvalidProjectInputError,
  ProjectAlreadyExistsError,
  WarmRunPreconditionError,
} from "../errors";
import { requireProjectStore } from "../projects";

const ACTOR_ADOPTION = "system:warm_run" as const;

/** The settled origin statuses a warm run adopts (ratified with TMB-7):
 * confirmed and auto-confirmed claims save review effort, discarded ones
 * fulfill A6 — negative decisions remain reusable. */
const ADOPTABLE_STATUSES = new Set([
  "confirmed",
  "auto_confirmed",
  "discarded",
]);

type AdoptableStatus = "confirmed" | "auto_confirmed" | "discarded";

export interface CreateWarmRunInput {
  originProjectId: string;
  newProjectId: string;
  newResearchQuestion: string;
}

export interface CreateWarmRunResult {
  projectId: string;
  adoptedCount: number;
  adoptedByStatus: Record<AdoptableStatus, number>;
  copiedSourceCount: number;
}

function extFromBlobPath(blobPath: string): string {
  return blobPath.slice(blobPath.lastIndexOf(".") + 1);
}

/** Copies every snapshot blob (current and superseded revisions) of the
 * origin's sources into the new project's content-addressed store. Identical
 * bytes reproduce identical paths, so the cloned Source objects need zero
 * rewriting. */
function copySourceBlobs(
  originStore: RegisterStore,
  newStore: RegisterStore,
  sources: readonly Source[],
): void {
  const originBlobs = originStore.blobs();
  const newBlobs = newStore.blobs();
  for (const source of sources) {
    const snapshots = [
      ...(source.custom.snapshot ? [source.custom.snapshot] : []),
      ...(source.custom.previous_snapshots ?? []),
    ];
    for (const snapshot of snapshots) {
      for (const blobPath of [snapshot.blob_path, snapshot.text_blob_path]) {
        if (blobPath) {
          newBlobs.put(originBlobs.read(blobPath), extFromBlobPath(blobPath));
        }
      }
    }
  }
}

/**
 * Creates a follow-up project as a warm run (TMB-43): the new project starts
 * with the origin's configuration, the complete source corpus (sources and
 * blobs copied verbatim) and all settled claims of the origin — created
 * directly in their origin status, with ids kept verbatim and
 * `provenance.origin_project_id` referencing the origin. Only their
 * relevance to the new question is re-assessed afterwards
 * (startRelevanceCheck); existence and attribution stand.
 */
export async function createWarmRunProject(
  input: CreateWarmRunInput,
): Promise<CreateWarmRunResult> {
  const newResearchQuestion = input.newResearchQuestion.trim();
  if (newResearchQuestion.length === 0) {
    throw new InvalidProjectInputError(
      "Die Recherchefrage darf nicht leer sein.",
    );
  }
  if (!ProjectId.safeParse(input.newProjectId).success) {
    throw new InvalidProjectInputError(
      `Projekt-Id "${input.newProjectId}" ist ungültig: erwartet wird z. B. ` +
        "\"proj_beispiel-2026\" (Kleinbuchstaben, Ziffern, '.', '_', '-').",
    );
  }

  const originStore = requireProjectStore(input.originProjectId);
  const origin: ClaimsRegister = await originStore.read();
  if (newResearchQuestion === origin.project.research_question.trim()) {
    throw new WarmRunPreconditionError(
      "Ein warmer Lauf ist eine Folgefrage – die Recherchefrage muss sich " +
        "von der des Ursprungsprojekts unterscheiden.",
    );
  }
  const eligible = origin.claims.filter((claim) =>
    ADOPTABLE_STATUSES.has(claim.status),
  );
  if (eligible.length === 0) {
    throw new WarmRunPreconditionError(
      "Das Ursprungsprojekt hat keine abgeschlossenen Aussagen (bestätigt, " +
        "automatisch bestätigt oder verworfen) – nichts zu übernehmen.",
    );
  }

  const newStore = RegisterStore.forProject(input.newProjectId);
  if (newStore.exists()) {
    throw new ProjectAlreadyExistsError(input.newProjectId);
  }
  const actor = getCurrentActor();
  await newStore.create({
    id: input.newProjectId,
    research_question: newResearchQuestion,
    config: structuredClone(origin.config),
    actor,
  });

  // Blob copies are plain file writes into a content-addressed store —
  // harmless if the adoption transaction below fails (orphans are never
  // referenced), so they run outside the project lock.
  copySourceBlobs(originStore, newStore, origin.sources);

  const adoptedByStatus: Record<AdoptableStatus, number> = {
    confirmed: 0,
    auto_confirmed: 0,
    discarded: 0,
  };
  await newStore.transaction((tx) => {
    for (const source of origin.sources) {
      tx.addSource(structuredClone(source));
    }
    for (const originClaim of eligible) {
      const status = originClaim.status as AdoptableStatus;
      adoptedByStatus[status] += 1;
      tx.adoptClaim({
        claim: adoptedClaimShell(originClaim, input.originProjectId),
        targetStatus: status,
        actor: ACTOR_ADOPTION,
        reason:
          `Aus Projekt "${input.originProjectId}" übernommen ` +
          `(Aussage ${originClaim.id}, Status ${originClaim.status}, ` +
          `Bestandsrevision ${origin.project.source_set_revision}).`,
      });
    }
  });

  return {
    projectId: input.newProjectId,
    adoptedCount: eligible.length,
    adoptedByStatus,
    copiedSourceCount: origin.sources.length,
  };
}

/** The adopted claim, ids kept verbatim: (origin_project_id, claim id)
 * addresses the origin claim exactly; evidence — including existence checks,
 * judgments and resolved relations — travels whole. The origin's history
 * stays behind: chain entries are bound to the origin project's genesis and
 * are structurally uncopyable into a foreign chain. */
function adoptedClaimShell(
  originClaim: Claim,
  originProjectId: string,
): Omit<Claim, "status" | "history"> {
  return {
    id: originClaim.id,
    text: originClaim.text,
    claim_type: originClaim.claim_type,
    ...(originClaim.support_degree
      ? { support_degree: originClaim.support_degree }
      : {}),
    ...(originClaim.calibration_result
      ? { calibration_result: originClaim.calibration_result }
      : {}),
    briefing_anchor: originClaim.briefing_anchor,
    provenance: {
      ...structuredClone(originClaim.provenance),
      origin_project_id: originProjectId,
    },
    evidence: structuredClone(originClaim.evidence),
  };
}

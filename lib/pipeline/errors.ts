/**
 * Typed error taxonomy of the pipeline layer. Routes and server actions map
 * these to user-facing messages; anything not a PipelineError is a
 * programming error and propagates unchanged (same discipline as the
 * adapter layer's AdapterError).
 */
export class PipelineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input of a use-case is invalid (empty question, malformed id, …). */
export class InvalidProjectInputError extends PipelineError {}

export class ProjectAlreadyExistsError extends PipelineError {
  constructor(readonly projectId: string) {
    super(`Projekt "${projectId}" existiert bereits.`);
  }
}

export class UnknownProjectError extends PipelineError {
  constructor(readonly projectId: string) {
    super(`Projekt "${projectId}" existiert nicht.`);
  }
}

/** Input of the briefing import is unusable (empty content, missing tool). */
export class InvalidBriefingInputError extends PipelineError {}

/** Input of the source capture is unusable. */
export class InvalidSourceInputError extends PipelineError {}

/** DOI/arXiv resolution failed (network, unknown id, malformed answer). */
export class IdentifierResolutionError extends PipelineError {}

/** The source document could not be downloaded. */
export class DocumentFetchError extends PipelineError {}

/** A run is already active for this project (per-project sequential). */
export class RunActiveError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Für Projekt "${projectId}" läuft bereits ein Lauf – ` +
        "je Projekt wird sequenziell gearbeitet (Einzelschreiber).",
    );
  }
}

/** A pause/resume/cancel request found no active run of the addressed kind
 * (TMB-50) — e.g. the run finished between page render and button click. */
export class NoActiveRunError extends PipelineError {
  constructor(readonly projectId: string) {
    super(`Für Projekt "${projectId}" läuft aktuell kein Lauf.`);
  }
}

/** Preconditions of the extraction run are not met. */
export class ExtractionPreconditionError extends PipelineError {}

/** Extraction already produced claims; re-extraction is a later epic
 * (warm runs, TMB-7) — guarding now avoids claim-id ambiguity. */
export class ExtractionAlreadyRanError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Projekt "${projectId}" hat bereits extrahierte Claims – ` +
        "eine erneute Extraktion ist im Prototyp nicht vorgesehen.",
    );
  }
}

/** Full-text extraction of a snapshot failed; recorded at the source
 * entry (custom.snapshot.text_extraction_error), never silently dropped. */
export class FullTextExtractionError extends PipelineError {}

/** Preconditions of the verification run are not met (no claims, nothing
 * left to verify, unknown rubric version). */
export class VerificationPreconditionError extends PipelineError {}

/** The source set is frozen; captures/changes need a revision workflow
 * (later epic) instead of silently mutating the frozen corpus. */
export class SourceSetFrozenError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Der Quellenbestand von Projekt "${projectId}" ist eingefroren – ` +
        "alle Prüfungen beziehen sich auf diesen Stand.",
    );
  }
}

/** A source revision violates its preconditions (TMB-44): the set is not
 * frozen yet (unfrozen sources are simply re-captured), or the source has
 * no snapshot. */
export class SourceRevisionPreconditionError extends PipelineError {}

/** The referenced source does not exist in the project. */
export class UnknownSourceError extends PipelineError {
  constructor(readonly sourceId: string) {
    super(`Quelle "${sourceId}" existiert nicht.`);
  }
}

/** Freezing needs at least one captured source. */
export class EmptySourceSetError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Projekt "${projectId}" hat noch keine Quellen – ` +
        "ein leerer Quellenbestand kann nicht eingefroren werden.",
    );
  }
}

/** A warm run violates its preconditions (TMB-43): origin not frozen, no
 * settled claims to adopt, or the follow-up question equals the origin's. */
export class WarmRunPreconditionError extends PipelineError {}

/** The relevance check violates its preconditions (TMB-43): no adopted
 * claims awaiting a relevance check. */
export class RelevancePreconditionError extends PipelineError {}

/** An adjudication decision violates its preconditions (claim not awaiting
 * adjudication, missing justification for "other", unmeasurable
 * duration). */
export class AdjudicationPreconditionError extends PipelineError {}

/** A repair step violates its preconditions (claim not contested). */
export class RepairPreconditionError extends PipelineError {}

/** A .tmb bundle failed verification on import (format, manifest checksums,
 * schema, hash chain or blob integrity) — aborted before any write, with
 * the itemized diagnosis as the user-facing message. */
export class InvalidBundleError extends PipelineError {
  constructor(readonly diagnosis: string[]) {
    super(`Bundle ist ungültig: ${diagnosis.join("; ")}`);
  }
}

/** A requested blob does not exist in the project (or the path is not a
 * valid blob path — both map to not-found, no path internals leak). */
export class UnknownBlobError extends PipelineError {
  constructor(relativePath: string, options?: { cause?: unknown }) {
    super(`Blob "${relativePath}" existiert nicht.`, options);
  }
}

/** First-run setup input is invalid (TMB-47: handle outside the safe
 * ASCII subset that actor ids hashed into the chain are restricted to). */
export class InvalidIdentityInputError extends PipelineError {}

/** One briefing per project: the original is the input extraction is
 * measured against; re-import would silently change that baseline. */
export class BriefingAlreadyImportedError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Projekt "${projectId}" hat bereits ein importiertes Briefing – ` +
        "der Original-Import ist unveränderlich (ein Briefing je Projekt).",
    );
  }
}

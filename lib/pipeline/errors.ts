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

/** Full-text extraction of a snapshot failed; recorded at the source
 * entry (custom.snapshot.text_extraction_error), never silently dropped. */
export class FullTextExtractionError extends PipelineError {}

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

/** Freezing needs at least one captured source. */
export class EmptySourceSetError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Projekt "${projectId}" hat noch keine Quellen – ` +
        "ein leerer Quellenbestand kann nicht eingefroren werden.",
    );
  }
}

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

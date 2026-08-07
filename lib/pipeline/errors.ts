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

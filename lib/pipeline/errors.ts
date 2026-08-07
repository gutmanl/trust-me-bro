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

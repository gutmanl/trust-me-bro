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

/** A project cannot be archived while a run is active for it: moving the
 * project directory out from under an in-flight capture/verification would
 * make it write into a vanished path. Recoverable — the caller waits for the
 * run or cancels it, then retries. */
export class ProjectArchiveBlockedError extends PipelineError {
  constructor(readonly projectId: string) {
    super(
      `Projekt "${projectId}" kann nicht archiviert werden, ` +
        "solange ein Lauf aktiv ist – bitte den Lauf abwarten oder abbrechen.",
    );
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

/**
 * A fetch exceeded one of its resource limits (S-06): response size, total
 * time, or number of redirects. Distinct from DocumentFetchError because
 * the cause is a bound this application chose, not a failure at the other
 * end — and the message has to say which bound, or the user cannot tell an
 * oversized document from a broken server.
 */
export class ResourceLimitExceededError extends PipelineError {}

/**
 * A fetch was refused because the target resolves to a non-public address
 * (S-06 SSRF hardening): loopback, private, link-local (including the
 * cloud-metadata endpoint), unique-local or otherwise non-routable. URLs
 * come out of briefings and references, i.e. untrusted material, and the
 * server must not be turned into a proxy for reaching addresses only it can
 * see. Distinct from DocumentFetchError because the cause is a policy this
 * application enforces, not a failure at the other end.
 */
export class BlockedAddressError extends PipelineError {}

/**
 * The configured backend cannot be constructed for a run — its `cli` names no
 * adapter this build registers (an unknown id, or the API spike with its gate
 * closed). A configuration problem surfaced as a German precondition rather
 * than an untranslated crash, wherever a run resolves its orchestrator.
 */
export class BackendUnavailableError extends PipelineError {}

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

/** Preconditions of the initial research run are not met. */
export class ResearchPreconditionError extends PipelineError {}

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

/**
 * PDF text extraction exceeded its time budget — distinct from
 * FullTextExtractionError on purpose: a genuine parse failure ("no text
 * layer") is soft (the source is captured with the error recorded), but a
 * TIMEOUT means we could not even finish looking at the document, so the
 * capture item FAILS rather than importing a source we never really read.
 * It therefore propagates past extractTextOrError's soft catch.
 */
export class TextExtractionTimeoutError extends PipelineError {
  constructor(seconds: number) {
    super(
      `Volltextextraktion nach ${seconds}s abgebrochen – das PDF ließ sich ` +
        "nicht in der vorgesehenen Zeit verarbeiten (evtl. beschädigt oder zu " +
        "komplex). Die Quelle wurde nicht übernommen.",
    );
  }
}

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

/** Preconditions of a reference scan are not met (reference auto-import):
 * no briefing imported yet, or the source set is already frozen. */
export class ReferenceScanPreconditionError extends PipelineError {}

/** Preconditions of a reference capture batch are not met (reference
 * auto-import): no candidates selected, or the source set is already
 * frozen. */
export class ReferenceCapturePreconditionError extends PipelineError {}

/** Preconditions of publishing a briefing revision are not met (workbench
 * epic): no text to publish (empty input and no saved draft, or the text
 * itself is blank). Missing-tool and reserved-prefix precondition on the
 * initial-import path stay InvalidBriefingInputError — publishing without a
 * prior briefing simply delegates to importBriefing and inherits its
 * errors, so this type covers only the revision workflow's own checks. */
export class BriefingRevisionPreconditionError extends PipelineError {}

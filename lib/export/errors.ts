/** A byte stream that is not a readable .tmb bundle (not a ZIP, unsafe
 * entry paths, missing/unparseable manifest). Carries the diagnosis the
 * import UI and the CLI surface verbatim. */
export class BundleFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

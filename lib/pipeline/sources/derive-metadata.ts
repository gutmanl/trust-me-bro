import { InvalidSourceInputError } from "../errors";
import { requireProjectStore } from "../projects";
import { formatCitationItem, issuedYear, type ManualMetadata } from "./csl";
import {
  acquireDocument,
  extFromFilename,
  extractTextOrError,
} from "./document";
import type { HttpFetcher } from "./fetch-port";
import { nodeHttpFetcher } from "./node-http-fetcher";
import {
  CONFIDENT_THRESHOLD,
  titleSimilarity,
} from "./reference-scan/crossref-match";
import { scanRegex } from "./reference-scan/scan-regex";
import { resolveArxiv, resolveDoi } from "./resolve";

/**
 * Metadata derivation from an uploaded or downloaded document (source
 * correction, "Kennung und Dokument korrigieren"): freeze the document,
 * read its text, find the DOI/arXiv id the document states about ITSELF,
 * resolve it and check the resolved title against the line it was found
 * on — so the user who uploads the right PDF for a mis-identified source
 * does not also have to type its bibliography back in.
 *
 * This module WRITES NOTHING to the register. Every neighbouring use-case
 * opens `store.transaction(...)` and therefore guards with
 * `describeBlockingActivity` / `runner.isRunning`; this one deliberately
 * has no such guard, because it commits nothing that a concurrent run
 * could conflict with. The single side effect is a blob write, and the
 * blob store is content-addressed and append-only — writing the same
 * bytes twice is a no-op.
 *
 * The derived candidate is applied through the ordinary queued correction
 * (`enqueueSourceCorrection` → `correctSource`), which RE-RESOLVES the
 * identifier server-side. That re-resolution is what makes the frozen
 * identity trustworthy: the browser is trusted with an identifier string
 * and a blob reference, never with resolved CSL fields.
 */

/** The frozen document, addressed by reference so the confirm submit never
 * re-sends the bytes (D-15). */
export interface DerivedDocumentRef {
  blob_path: string;
  filename: string;
}

interface DerivedIdentity {
  document: DerivedDocumentRef;
  kind: "doi" | "arxiv";
  identifier: string;
  /** Human-readable citation of the resolved item, for the confirm line. */
  citation: string;
  /** The `raw_text` line the identifier was matched on — the evidence the
   * user is asked to confirm against. */
  matchedLine: string;
  /** Pre-fill for the manual fallback when the user rejects the candidate
   * (D-10). */
  manual: ManualMetadata;
}

/**
 * Outcome of one derivation attempt. `unresolved` and the `no_text` reason
 * are a deliberate extension of the three copy variants CONTEXT lists:
 * mapping a dead resolver or a scanned PDF without a text layer onto
 * "keine Kennung gefunden" would be untrue, and the user's next action
 * differs — retry later versus type the metadata in by hand.
 */
export type DerivedMetadataCandidate =
  | ({ status: "verified" } & DerivedIdentity)
  | ({ status: "unverified" } & DerivedIdentity)
  | {
      status: "unresolved";
      document: DerivedDocumentRef;
      kind: "doi" | "arxiv";
      identifier: string;
    }
  | {
      status: "not_found";
      document: DerivedDocumentRef;
      reason: "no_identifier" | "no_text";
    };

export interface DeriveMetadataInput {
  projectId: string;
  /** Uploaded document; takes precedence over any URL, as in capture. */
  upload?: { content: Buffer; filename: string };
  /** Document URL when no file was uploaded (the "url" kind). */
  documentUrl?: string;
}

export interface DeriveMetadataDependencies {
  fetcher?: HttpFetcher;
}

/**
 * How far into the extracted text the self-identifying DOI/arXiv id is
 * looked for. MEASURED, not guessed: across all five sources of the live
 * test project the document's OWN DOI appears at character offsets 329,
 * 859, 2 136, 4 892 and 5 164, while the earliest FOREIGN DOI — the first
 * bibliography entry — appears at 20 897. 12 000 sits in that gap; the
 * 4 000-character "first page" proxy that suggested itself first would
 * miss two of the five.
 *
 * Note that this is a character budget, not a page restriction, and cannot
 * be made into one: `extractPdfText` calls unpdf with `mergePages: true`
 * (fulltext/extract-pdf.ts), so real page boundaries do not survive
 * extraction. The number is an honest proxy for "the front matter", and
 * excluding the bibliography is the whole job it does — see
 * `verifyDerivedCandidate` for why that exclusion carries the weight.
 */
const DERIVE_SCAN_WINDOW_CHARS = 12_000;

/**
 * Shortest normalized title for which containment counts as evidence.
 * Below this, a title is short enough that its appearance inside a line is
 * coincidence rather than identification ("Fairness", "Deep Learning").
 */
const MIN_CONTAINMENT_TITLE_CHARS = 20;

function normalizeForContainment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the resolved title and the line the identifier was matched on
 * describe the same work (D-14): containment first, bigram similarity at
 * `CONFIDENT_THRESHOLD` as the fallback for a title the extraction broke
 * across a line or hyphenated.
 *
 * Deliberately scored against the DOCUMENT's own text, never against a
 * user-typed title — the point of this flow is that the user uploads a PDF
 * and the app works out what it is; requiring a title to score against
 * would give the user back exactly the job being automated.
 *
 * Known limit, stated because it is load-bearing: containment cannot
 * distinguish the document's own identity from a well-formed citation OF
 * another work, because a reference-list entry contains its own title too.
 * `DERIVE_SCAN_WINDOW_CHARS` is what keeps bibliographies out of range and
 * the mandatory human confirm step (D-09) is the backstop, so this check
 * biases toward recall: a wrong `verified` costs one rejected confirmation,
 * a wrong `unverified` costs the user the manual entry this flow exists to
 * avoid.
 */
function verifyDerivedCandidate(title: string, matchedLine: string): boolean {
  const normalizedTitle = normalizeForContainment(title);
  const normalizedLine = normalizeForContainment(matchedLine);
  if (
    normalizedTitle.length >= MIN_CONTAINMENT_TITLE_CHARS &&
    normalizedLine.includes(normalizedTitle)
  ) {
    return true;
  }
  return titleSimilarity(title, matchedLine) >= CONFIDENT_THRESHOLD;
}

/** The resolved CSL item as the manual form's fields (D-10) — the inverse
 * of `buildManualCslItem`, so a rejected candidate still hands the user a
 * filled form instead of an empty one. Internal: the pre-fill is a detail
 * of this derivation, not public pipeline surface. */
function cslToManualMetadata(item: Record<string, unknown>): ManualMetadata {
  const title = typeof item.title === "string" ? item.title : "";
  const container = item["container-title"];
  const year = issuedYear(item);
  const authors = Array.isArray(item.author)
    ? item.author
        .map((entry) => {
          // Schema-unvalidated `unknown` straight out of the resolver, same
          // defensive shape csl.ts's firstAuthorFamily applies.
          const author = entry as Record<string, unknown> | null | undefined;
          if (author === null || typeof author !== "object") {
            return "";
          }
          if (
            typeof author.family === "string" &&
            author.family.trim().length > 0
          ) {
            const given =
              typeof author.given === "string" ? author.given.trim() : "";
            return given
              ? `${author.family.trim()}, ${given}`
              : author.family.trim();
          }
          return typeof author.literal === "string"
            ? author.literal.trim()
            : "";
        })
        .filter((name) => name.length > 0)
        .join("; ")
    : "";
  return {
    title,
    ...(authors.length > 0 ? { authors } : {}),
    ...(year !== undefined ? { year: String(year) } : {}),
    ...(typeof container === "string" && container.trim().length > 0
      ? { container_title: container }
      : {}),
  };
}

/**
 * Filename to carry back with the frozen blob.
 *
 * Load-bearing, not cosmetic: the confirm submit sends this string back and
 * `toCaptureSourceInput` → `acquireDocument` re-derives the extension from
 * it via `extFromFilename`, which answers "bin" for an extension-less name.
 * A "bin" extension routes the bytes around `acquireDocument`'s `%PDF-`
 * signature check, so a document that was verified as a PDF here would
 * re-enter the corpus unverified. Whenever the name does not already carry
 * the extension the document actually resolved to, synthesize one that
 * does.
 */
function documentFilename(
  upload: { filename: string } | undefined,
  documentUrl: string | undefined,
  ext: string,
): string {
  const candidate = upload
    ? upload.filename
    : basenameOfUrl(documentUrl ?? "") || "";
  if (candidate.length > 0 && extFromFilename(candidate) === ext) {
    return candidate;
  }
  return `dokument.${ext}`;
}

function basenameOfUrl(documentUrl: string): string {
  try {
    const segments = new URL(documentUrl).pathname.split("/");
    return decodeURIComponent(segments[segments.length - 1] ?? "");
  } catch {
    return "";
  }
}

/**
 * Derives a bibliographic identity from the document itself and returns it
 * for confirmation. Nothing enters the register here (D-09).
 *
 * Order matters: the document is frozen into the blob store BEFORE the text
 * is extracted, so every outcome — including a failed derivation — can hand
 * the confirm step a blob reference and the user never uploads twice.
 *
 * Accepted debt, flagged rather than silently decided: a wizard the user
 * abandons leaves an orphaned blob behind. That is consistent with the
 * register's append-only philosophy — superseded snapshots and superseded
 * identities are kept forever too — and no garbage collection exists or is
 * wanted (threat T-l0f-05).
 */
export async function deriveMetadataFromDocument(
  input: DeriveMetadataInput,
  deps: DeriveMetadataDependencies = {},
): Promise<DerivedMetadataCandidate> {
  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const store = requireProjectStore(input.projectId);

  if (
    (input.upload === undefined || input.upload.content.length === 0) &&
    (input.documentUrl ?? "").trim().length === 0
  ) {
    throw new InvalidSourceInputError(
      "Zum Ableiten der Metadaten wird ein Dokument benötigt: " +
        "Datei hochladen oder Dokument-URL angeben.",
    );
  }

  const acquired = await acquireDocument(
    {
      ...(input.upload ? { upload: input.upload } : {}),
      ...(input.documentUrl ? { documentUrl: input.documentUrl.trim() } : {}),
    },
    fetcher,
  );
  const blob = store.blobs().put(acquired.content, acquired.ext);
  const document: DerivedDocumentRef = {
    blob_path: blob.blobPath,
    filename: documentFilename(input.upload, input.documentUrl, acquired.ext),
  };

  // A TextExtractionTimeoutError propagates by design (extractTextOrError
  // re-throws it): a document we could not finish reading is not a document
  // without an identifier, and the action must say so in its own words
  // rather than sending the user to the manual fields under a false reason.
  const extraction = await extractTextOrError(acquired.content, acquired.ext);
  if (!("text" in extraction)) {
    return { status: "not_found", document, reason: "no_text" };
  }

  const hits = scanRegex(extraction.text.slice(0, DERIVE_SCAN_WINDOW_CHARS));
  // DOI first, arXiv second, `url` hits never: a bare URL resolves to no CSL
  // identity, so it cannot answer the question this step asks.
  const hit =
    hits.find((candidate) => candidate.method === "doi") ??
    hits.find((candidate) => candidate.method === "arxiv");
  if (!hit) {
    return { status: "not_found", document, reason: "no_identifier" };
  }
  const kind = hit.method === "doi" ? "doi" : "arxiv";
  const identifier = (kind === "doi" ? hit.doi : hit.arxiv_id) ?? "";

  let item: Record<string, unknown>;
  try {
    const resolved =
      kind === "doi"
        ? await resolveDoi(identifier, fetcher)
        : await resolveArxiv(identifier, fetcher);
    item = resolved.item;
  } catch {
    // Fail open, following reference-scan/identity-crosscheck.ts: a dead
    // identifier or a network hiccup degrades to the manual fallback and
    // never blocks the correction the user came here to make.
    return { status: "unresolved", document, kind, identifier };
  }

  const title = typeof item.title === "string" ? item.title : "";
  const identity: DerivedIdentity = {
    document,
    kind,
    identifier,
    citation: formatCitationItem(item, identifier),
    matchedLine: hit.raw_text,
    manual: cslToManualMetadata(item),
  };
  return verifyDerivedCandidate(title, hit.raw_text)
    ? { status: "verified", ...identity }
    : { status: "unverified", ...identity };
}

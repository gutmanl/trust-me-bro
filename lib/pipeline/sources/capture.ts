import type { Source, SourceType } from "../../register";
import { InvalidSourceInputError, PipelineError } from "../errors";
import { mintSourceId } from "../ids";
import { requireProjectStore } from "../projects";
import {
  buildManualCslItem,
  firstAuthorFamily,
  issuedYear,
  type ManualMetadata,
} from "./csl";
import { acquireDocument, buildSnapshot, extractTextOrError } from "./document";
import type { HttpFetcher } from "./fetch-port";
import { isHttpUrl, normalizeArxivId, normalizeDoi } from "./identifiers";
import { nodeHttpFetcher } from "./node-http-fetcher";
// Leaf module: pure identifier helpers, no import back into the capture
// path, so sharing them here closes no cycle.
import {
  identifierMatches,
  sourceIdentifiers,
} from "./reference-scan/candidate";
import { resolveArxiv, resolveDoi, type ResolvedMetadata } from "./resolve";

export type CaptureKind = "doi" | "arxiv" | "url" | "upload";

export interface CaptureSourceInput {
  projectId: string;
  kind: CaptureKind;
  /** DOI, arXiv id or URL as pasted; unused for uploads. */
  identifier?: string;
  sourceType: SourceType;
  /** Manual bibliographic metadata; required for url/upload captures. */
  manual?: ManualMetadata;
  /** Document URL when the identifier does not determine one (DOI). */
  documentUrl?: string;
  /** Corpus-integrity guard passed through to acquireDocument (reference
   * auto-import, Task 3b) — see document.ts's DocumentRequest.expectedExt.
   * Manual capture never sets this. */
  expectedExt?: string;
  /** Uploaded document; takes precedence over any URL. */
  upload?: { content: Buffer; filename: string };
  /** Provenance when this capture originates from the reference
   * auto-import flow; absent for manual captures. Written verbatim to
   * `custom.auto_capture`. */
  autoCapture?: {
    raw_text: string;
    method: "doi" | "arxiv" | "url" | "crossref_title" | "unresolved";
    score?: number;
  };
  /** Work-item id of the capture attempt (source work items): written to
   * `custom.capture_attempt_id`, where it resolves an earlier
   * `source_capture_failed` event of the same work item. Absent for
   * captures that never went through the asynchronous queue. */
  captureAttemptId?: string;
}

export interface CaptureDependencies {
  fetcher?: HttpFetcher;
}

function requireManual(manual: ManualMetadata | undefined): ManualMetadata {
  if (!manual || manual.title.trim().length === 0) {
    throw new InvalidSourceInputError(
      "Für URL- und Datei-Quellen ist mindestens ein Titel erforderlich.",
    );
  }
  return manual;
}

/** Identity resolution shared by capture and correction (source
 * correction): DOI/arXiv resolve to CSL metadata (verified), URL/upload
 * carry manual metadata (unverified). Internal — not on the barrel. */
export async function resolveMetadata(
  input: Pick<CaptureSourceInput, "kind" | "identifier" | "manual">,
  fetcher: HttpFetcher,
): Promise<{ resolved: ResolvedMetadata; verified: boolean }> {
  switch (input.kind) {
    case "doi": {
      const doi = normalizeDoi(input.identifier ?? "");
      if (!doi) {
        throw new InvalidSourceInputError(
          `"${input.identifier ?? ""}" ist keine erkennbare DOI.`,
        );
      }
      return { resolved: await resolveDoi(doi, fetcher), verified: true };
    }
    case "arxiv": {
      const arxivId = normalizeArxivId(input.identifier ?? "");
      if (!arxivId) {
        throw new InvalidSourceInputError(
          `"${input.identifier ?? ""}" ist keine erkennbare arXiv-Id.`,
        );
      }
      return { resolved: await resolveArxiv(arxivId, fetcher), verified: true };
    }
    case "url": {
      const url = (input.identifier ?? "").trim();
      if (!isHttpUrl(url)) {
        throw new InvalidSourceInputError(`"${url}" ist keine http(s)-URL.`);
      }
      const manual = requireManual(input.manual);
      return {
        resolved: {
          item: buildManualCslItem({ ...manual, url }),
          documentUrl: url,
        },
        verified: false,
      };
    }
    case "upload": {
      const manual = requireManual(input.manual);
      return {
        resolved: { item: buildManualCslItem(manual) },
        verified: false,
      };
    }
  }
}

/** The identifiers of a freshly resolved CSL item, in the shape
 * `identifierMatches` compares against a source's own. */
function identifiersOf(item: Record<string, unknown>): {
  doi?: string;
  arxiv_id?: string;
  url?: string;
} {
  const ids = sourceIdentifiers(item as unknown as Source);
  return {
    ...(ids.doi ? { doi: ids.doi } : {}),
    ...(ids.arxivId ? { arxiv_id: ids.arxivId } : {}),
    ...(ids.url ? { url: ids.url } : {}),
  };
}

/**
 * Captures one source (TMB-23): resolves DOI/arXiv identifiers to CSL-JSON
 * metadata (URL/upload sources carry manual metadata), downloads or accepts
 * the source document, freezes it as content-addressed snapshot with
 * retrieval time, SHA-256 and revision 1, and appends the source entry to
 * the register.
 */
export async function captureSource(
  input: CaptureSourceInput,
  deps: CaptureDependencies = {},
): Promise<Source> {
  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const store = requireProjectStore(input.projectId);

  const { resolved, verified } = await resolveMetadata(input, fetcher);
  const document = await acquireDocument(
    {
      upload: input.upload,
      documentUrl: input.documentUrl?.trim() || resolved.documentUrl,
      expectedExt: input.expectedExt,
    },
    fetcher,
  );
  // TMB-24: the extracted full text is what stage 1 and the agent CLIs
  // read; failures are recorded at the source entry, never fatal.
  const extraction = await extractTextOrError(document.content, document.ext);
  const now = new Date().toISOString();

  return store.transaction((tx) => {
    // Identity-level duplicate guard: whatever path led here — a candidate
    // row, the manual modal, an automatic repair's corrected attempt — a
    // resolved identifier that already belongs to a source means this work
    // is in the corpus, and a second entry would split its claims and its
    // audit trail across two sources. Checked INSIDE the transaction, so
    // two captures racing for the same identifier cannot both pass.
    const duplicate = tx
      .listSources()
      .find((source) =>
        identifierMatches(
          identifiersOf(resolved.item),
          sourceIdentifiers(source),
        ),
      );
    if (duplicate) {
      throw new PipelineError(
        `Diese Kennung ist bereits als Quelle "${duplicate.id}" erfasst.`,
      );
    }
    const existing = new Set(tx.listSources().map((source) => source.id));
    const id = mintSourceId(
      {
        family: firstAuthorFamily(resolved.item),
        year: issuedYear(resolved.item),
        title:
          typeof resolved.item.title === "string"
            ? resolved.item.title
            : undefined,
      },
      existing,
    );
    const blob = store.blobs().put(document.content, document.ext);
    const source: Source = {
      ...resolved.item,
      id,
      type: String(resolved.item.type ?? "document"),
      custom: {
        source_type: input.sourceType,
        ...(verified ? { identifier_verified: { status: true, at: now } } : {}),
        snapshot: buildSnapshot(store.blobs(), blob, extraction, 1, now),
        ...(input.autoCapture ? { auto_capture: input.autoCapture } : {}),
        ...(input.captureAttemptId
          ? { capture_attempt_id: input.captureAttemptId }
          : {}),
      },
    };
    tx.addSource(source);
    return structuredClone(source);
  });
}

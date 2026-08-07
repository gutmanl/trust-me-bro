import type { ClaimsRegister, Source, SourceType } from "../../register";
import { getCurrentActor } from "../../identity";
import {
  DocumentFetchError,
  EmptySourceSetError,
  InvalidSourceInputError,
  SourceSetFrozenError,
} from "../errors";
import { mintSourceId } from "../ids";
import { requireProjectStore } from "../projects";
import {
  buildManualCslItem,
  firstAuthorFamily,
  issuedYear,
  type ManualMetadata,
} from "./csl";
import { extractFullText } from "../fulltext/extract";
import type { HttpFetcher } from "./fetch-port";
import { isHttpUrl, normalizeArxivId, normalizeDoi } from "./identifiers";
import { nodeHttpFetcher } from "./node-http-fetcher";
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
  /** Uploaded document; takes precedence over any URL. */
  upload?: { content: Buffer; filename: string };
}

export interface CaptureDependencies {
  fetcher?: HttpFetcher;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/plain": "txt",
  "text/markdown": "md",
};

function extFromFilename(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  const ext = match ? match[1].toLowerCase() : "bin";
  return ext === "htm" ? "html" : ext;
}

/** The one place that knows how "frozen" is encoded in the event log. */
function hasFreezeEvent(events: readonly { event: string }[]): boolean {
  return events.some((event) => event.event === "source_set_frozen");
}

/** True once the source_set_frozen event exists — every verification then
 * references exactly this corpus state. */
export function isSourceSetFrozen(register: ClaimsRegister): boolean {
  return hasFreezeEvent(register.project_events);
}

function requireManual(manual: ManualMetadata | undefined): ManualMetadata {
  if (!manual || manual.title.trim().length === 0) {
    throw new InvalidSourceInputError(
      "Für URL- und Datei-Quellen ist mindestens ein Titel erforderlich.",
    );
  }
  return manual;
}

async function resolveMetadata(
  input: CaptureSourceInput,
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

async function acquireDocument(
  input: CaptureSourceInput,
  resolved: ResolvedMetadata,
  fetcher: HttpFetcher,
): Promise<{ content: Buffer; ext: string }> {
  if (input.upload && input.upload.content.length > 0) {
    return {
      content: input.upload.content,
      ext: extFromFilename(input.upload.filename),
    };
  }
  const documentUrl = input.documentUrl?.trim() || resolved.documentUrl;
  if (!documentUrl) {
    throw new InvalidSourceInputError(
      "Zum Einfrieren wird das Quellendokument benötigt: " +
        "Dokument-URL angeben oder Datei hochladen.",
    );
  }
  if (!isHttpUrl(documentUrl)) {
    throw new InvalidSourceInputError(
      `"${documentUrl}" ist keine http(s)-URL.`,
    );
  }
  let resource;
  try {
    resource = await fetcher.fetch(documentUrl);
  } catch (error) {
    throw new DocumentFetchError(
      `Quellendokument konnte nicht geladen werden (${documentUrl}).`,
      { cause: error },
    );
  }
  if (resource.status !== 200 || resource.body.length === 0) {
    throw new DocumentFetchError(
      `Quellendokument konnte nicht geladen werden (HTTP ${resource.status}, ${documentUrl}).`,
    );
  }
  const ext =
    (resource.contentType && EXT_BY_CONTENT_TYPE[resource.contentType]) ??
    extFromFilename(new URL(documentUrl).pathname);
  return { content: resource.body, ext };
}

/**
 * Captures one source (TMB-23): resolves DOI/arXiv identifiers to CSL-JSON
 * metadata (URL/upload sources carry manual metadata), downloads or accepts
 * the source document, freezes it as content-addressed snapshot with
 * retrieval time, SHA-256 and revision 1, and appends the source entry to
 * the register. Rejected once the source set is frozen.
 */
export async function captureSource(
  input: CaptureSourceInput,
  deps: CaptureDependencies = {},
): Promise<Source> {
  const fetcher = deps.fetcher ?? nodeHttpFetcher;
  const store = requireProjectStore(input.projectId);

  const { resolved, verified } = await resolveMetadata(input, fetcher);
  const document = await acquireDocument(input, resolved, fetcher);
  // TMB-24: the extracted full text is what stage 1 and the agent CLIs
  // read. Extraction failures are recorded at the source entry — a source
  // without text layer is captured visibly, not rejected.
  let extraction: { text: string } | { error: string };
  try {
    extraction = {
      text: await extractFullText(document.content, document.ext),
    };
  } catch (error) {
    extraction = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const now = new Date().toISOString();

  return store.transaction((tx) => {
    if (hasFreezeEvent(tx.listProjectEvents())) {
      throw new SourceSetFrozenError(input.projectId);
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
        snapshot: {
          retrieved_at: now,
          sha256: blob.sha256,
          blob_path: blob.blobPath,
          ...("text" in extraction
            ? {
                text_blob_path: store.blobs().put(extraction.text, "txt")
                  .blobPath,
              }
            : { text_extraction_error: extraction.error }),
          revision: 1,
        },
      },
    };
    tx.addSource(source);
    return structuredClone(source);
  });
}

/**
 * Freezes the source set (TMB-23): appends the source_set_frozen event —
 * afterwards captures are rejected and every verification references this
 * corpus state. One-way in this epic; revising reopens in a later epic.
 */
export async function freezeSourceSet(projectId: string): Promise<void> {
  const store = requireProjectStore(projectId);
  await store.transaction((tx) => {
    if (hasFreezeEvent(tx.listProjectEvents())) {
      throw new SourceSetFrozenError(projectId);
    }
    const sources = tx.listSources();
    if (sources.length === 0) {
      throw new EmptySourceSetError(projectId);
    }
    tx.recordProjectEvent({
      event: "source_set_frozen",
      reason: `Quellenbestand eingefroren: ${sources.length} Quelle(n), Revision ${tx.getProject().source_set_revision}.`,
      actor: getCurrentActor(),
    });
  });
}

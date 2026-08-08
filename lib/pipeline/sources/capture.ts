import type { ClaimsRegister, Source, SourceType } from "../../register";
import { getCurrentActor } from "../../identity";
import {
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
import { acquireDocument, buildSnapshot, extractTextOrError } from "./document";
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
  const document = await acquireDocument(
    {
      upload: input.upload,
      documentUrl: input.documentUrl?.trim() || resolved.documentUrl,
    },
    fetcher,
  );
  // TMB-24: the extracted full text is what stage 1 and the agent CLIs
  // read; failures are recorded at the source entry, never fatal.
  const extraction = await extractTextOrError(document.content, document.ext);
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
        snapshot: buildSnapshot(store.blobs(), blob, extraction, 1, now),
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

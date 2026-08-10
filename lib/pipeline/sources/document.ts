import type { BlobRef, BlobStore, SourceSnapshot } from "../../register";
import { InvalidSourceInputError, DocumentFetchError } from "../errors";
import { extractFullText } from "../fulltext/extract";
import type { HttpFetcher } from "./fetch-port";
import { isHttpUrl } from "./identifiers";

/**
 * Document handling shared by source capture (TMB-23) and source revision
 * (TMB-44): accept an uploaded file or download from a URL, extract the
 * full text (failures recorded, never fatal — TMB-24), and build the
 * snapshot block.
 */

export interface DocumentRequest {
  /** Uploaded document; takes precedence over any URL. */
  upload?: { content: Buffer; filename: string };
  /** Document URL used when no upload is given. */
  documentUrl?: string;
  /** Corpus-integrity guard (reference auto-import, Task 3b): when set, the
   * acquired document's resolved extension must equal this value, or
   * acquisition fails with a German DocumentFetchError instead of silently
   * storing whatever was fetched. Auto-import passes "pdf" for every
   * derived (arXiv/Crossref-PDF-link/Unpaywall) document URL, so a
   * paywall/abstract HTML page fails the item visibly rather than entering
   * the frozen corpus as if it were the paper. Manual capture never sets
   * this — unset is a complete no-op, existing behavior unchanged. */
  expectedExt?: string;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/plain": "txt",
  "text/markdown": "md",
};

export function extFromFilename(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  const ext = match ? match[1].toLowerCase() : "bin";
  return ext === "htm" ? "html" : ext;
}

export async function acquireDocument(
  request: DocumentRequest,
  fetcher: HttpFetcher,
): Promise<{ content: Buffer; ext: string }> {
  let content: Buffer;
  let ext: string;

  if (request.upload && request.upload.content.length > 0) {
    content = request.upload.content;
    ext = extFromFilename(request.upload.filename);
  } else {
    const documentUrl = request.documentUrl?.trim();
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
    content = resource.body;
    ext =
      (resource.contentType && EXT_BY_CONTENT_TYPE[resource.contentType]) ??
      extFromFilename(new URL(documentUrl).pathname);
  }

  // Corpus-integrity guard (reference auto-import, Task 3b): see the
  // DocumentRequest.expectedExt doc comment. Checked uniformly for both
  // acquisition paths, though in practice only auto-import's URL-derived
  // downloads ever set it.
  if (request.expectedExt && ext !== request.expectedExt) {
    throw new DocumentFetchError(
      `Quellendokument ist kein ${request.expectedExt.toUpperCase()} ` +
        `(erkannt: "${ext}"): Dokument-URL prüfen oder Datei manuell hochladen.`,
    );
  }

  return { content, ext };
}

export type TextExtraction = { text: string } | { error: string };

/** Full-text extraction with the TMB-24 fallback: a source without a text
 * layer is captured visibly (text_extraction_error), not rejected. */
export async function extractTextOrError(
  content: Buffer,
  ext: string,
): Promise<TextExtraction> {
  try {
    return { text: await extractFullText(content, ext) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The snapshot block from a stored document blob and its text extraction;
 * the text blob is written here so capture and revision cannot drift. */
export function buildSnapshot(
  blobs: BlobStore,
  documentBlob: BlobRef,
  extraction: TextExtraction,
  revision: number,
  retrievedAt: string,
): SourceSnapshot {
  return {
    retrieved_at: retrievedAt,
    sha256: documentBlob.sha256,
    blob_path: documentBlob.blobPath,
    ...("text" in extraction
      ? { text_blob_path: blobs.put(extraction.text, "txt").blobPath }
      : { text_extraction_error: extraction.error }),
    revision,
  };
}

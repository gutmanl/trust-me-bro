import path from "node:path";

import { UnknownBlobError } from "./errors";
import { requireProjectStore } from "./projects";

/**
 * Read access to a project's frozen snapshots for the web layer (TMB-34:
 * jump from an evidence card into the source snapshot). The blob store's
 * path validation rules out traversal structurally; this use-case only adds
 * project resolution, existence mapping and the content type.
 */

export interface ProjectBlob {
  buffer: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/** Content type by blob extension; opaque bytes otherwise. */
export function blobContentType(relativePath: string): string {
  const ext = path.extname(relativePath).replace(".", "").toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export async function getProjectBlob(
  projectId: string,
  relativePath: string,
): Promise<ProjectBlob> {
  const store = requireProjectStore(projectId);
  const blobs = store.blobs();
  let buffer: Buffer;
  try {
    if (!blobs.exists(relativePath)) {
      throw new UnknownBlobError(relativePath);
    }
    buffer = blobs.read(relativePath);
  } catch (error) {
    if (error instanceof UnknownBlobError) {
      throw error;
    }
    // Malformed paths are rejected by the store's shape validation — map
    // them to the same not-found error instead of leaking path internals.
    throw new UnknownBlobError(relativePath, { cause: error });
  }
  return { buffer, contentType: blobContentType(relativePath) };
}

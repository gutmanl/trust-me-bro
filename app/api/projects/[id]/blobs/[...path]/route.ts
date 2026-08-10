import {
  getProjectBlob,
  UnknownBlobError,
  UnknownProjectError,
} from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/**
 * Anything the browser would execute as a document on this origin. Today
 * only text/html can actually reach this — the blob store maps just
 * pdf/html/htm/md/txt and serves everything else as opaque bytes — but the
 * list is written for the type, not for today's map, so a later entry does
 * not silently open the hole again.
 */
function isActiveContent(contentType: string): boolean {
  const essence = contentType.split(";")[0].trim().toLowerCase();
  return (
    essence === "text/html" ||
    essence === "application/xhtml+xml" ||
    essence === "image/svg+xml"
  );
}

/**
 * S-03: a frozen snapshot is evidence to be inspected, not a page to be
 * rendered. Served with only content-type and cache-control, a captured
 * HTML snapshot executed its scripts as same-origin content of the
 * application — reading and acting on everything the user's session can.
 *
 * Three headers on this one response close that:
 *
 * - `X-Content-Type-Options: nosniff` stops the browser from upgrading a
 *   blob we labelled as inert into something executable.
 * - A sandbox CSP with `default-src 'none'` neutralises active content even
 *   if it is rendered anyway — no scripts, no origin, no outbound requests.
 * - `Content-Disposition: attachment` keeps such a blob out of the
 *   rendering path in the first place.
 *
 * The latter two apply to active content only: PDFs and plain text keep
 * behaving exactly as before, because the source viewer displays them
 * inline and depends on it.
 */
function securityHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
  };
  if (isActiveContent(contentType)) {
    headers["content-security-policy"] =
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";
    headers["content-disposition"] = "attachment";
  }
  return headers;
}

/**
 * Serves a project's frozen snapshot blobs (TMB-34: the detail panel's jump
 * to the Fundstelle). Path shape validation happens in the blob store —
 * anything not matching blobs/<prefix>/<sha256>.<ext> is a 404, traversal
 * is ruled out by construction.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/blobs/[...path]">,
) {
  const { id, path: segments } = await context.params;
  try {
    const blob = await getProjectBlob(id, segments.join("/"));
    return new Response(new Uint8Array(blob.buffer), {
      headers: {
        "content-type": blob.contentType,
        // Content-addressed: the bytes behind a path can never change.
        "cache-control": "private, max-age=31536000, immutable",
        ...securityHeaders(blob.contentType),
      },
    });
  } catch (error) {
    if (
      error instanceof UnknownProjectError ||
      error instanceof UnknownBlobError
    ) {
      return new Response("not found", { status: 404 });
    }
    throw error;
  }
}

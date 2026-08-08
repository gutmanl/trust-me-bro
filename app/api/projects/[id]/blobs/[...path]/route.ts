import {
  getProjectBlob,
  UnknownBlobError,
  UnknownProjectError,
} from "@/lib/pipeline";

export const dynamic = "force-dynamic";

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

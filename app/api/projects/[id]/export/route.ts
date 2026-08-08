import { exportProjectBundle, UnknownProjectError } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/**
 * Download of the .tmb export bundle (TMB-39). `?blobs=0` requests the lean
 * variant that lists blobs with checksum references only. Built
 * synchronously in memory — adequate at the prototype's project sizes.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[id]/export">,
) {
  const { id } = await context.params;
  const includeBlobs = new URL(request.url).searchParams.get("blobs") !== "0";
  try {
    const bundle = await exportProjectBundle(id, { includeBlobs });
    return new Response(new Uint8Array(bundle.bytes), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${bundle.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      return new Response("not found", { status: 404 });
    }
    throw error;
  }
}

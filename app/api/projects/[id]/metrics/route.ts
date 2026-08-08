import {
  getProjectMetrics,
  metricsToCsv,
  UnknownProjectError,
} from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/**
 * Metrics export (TMB-45): always freshly computed from the register, never
 * persisted — deliberately NOT part of the .tmb bundle's derived/ directory,
 * since the metrics are an evaluation instrument, not archival format.
 * `?format=csv` serves the raw per-claim rows; the default JSON carries
 * aggregates plus the same rows.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[id]/metrics">,
) {
  const { id } = await context.params;
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  try {
    const metrics = await getProjectMetrics(id);
    if (format === "csv") {
      return new Response(metricsToCsv(metrics), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${id}-metrics.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    return new Response(`${JSON.stringify(metrics, null, 2)}\n`, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${id}-metrics.json"`,
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

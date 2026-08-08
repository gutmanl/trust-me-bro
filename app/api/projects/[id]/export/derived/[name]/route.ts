import {
  getProvDocument,
  getReferencesCsl,
  getTracesAggregate,
  UnknownProjectError,
} from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/**
 * Standalone downloads of the three derived export files (TMB-41). Fixed
 * allowlist — the same builders also fill the bundle's derived/ directory,
 * so both paths can never drift apart.
 */
const DERIVED: Record<
  string,
  { load: (projectId: string) => Promise<unknown>; contentType: string }
> = {
  "references.csl.json": {
    load: getReferencesCsl,
    contentType: "application/vnd.citationstyles.csl+json",
  },
  "prov.jsonld": { load: getProvDocument, contentType: "application/ld+json" },
  "traces.json": { load: getTracesAggregate, contentType: "application/json" },
};

export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]/export/derived/[name]">,
) {
  const { id, name } = await context.params;
  const derived = DERIVED[name];
  if (!derived) {
    return new Response("not found", { status: 404 });
  }
  try {
    const document = await derived.load(id);
    return new Response(`${JSON.stringify(document, null, 2)}\n`, {
      headers: {
        "content-type": derived.contentType,
        "content-disposition": `attachment; filename="${name}"`,
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

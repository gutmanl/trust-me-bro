import Link from "next/link";
import { notFound } from "next/navigation";

import { getBriefing, UnknownProjectError } from "@/lib/pipeline";
import { formatTimestamp } from "../../status-labels";
import { BriefingForm } from "./BriefingForm";

export const dynamic = "force-dynamic";

export default async function BriefingPage(
  props: PageProps<"/projects/[id]/briefing">,
) {
  const { id } = await props.params;
  let briefing;
  try {
    briefing = await getBriefing(id);
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${id}`}
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← Zurück zum Projekt
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Briefing</h1>
      </div>

      {briefing ? (
        <div className="space-y-4">
          <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm">
            <p className="font-medium text-green-800">
              Originalfassung eingefroren
            </p>
            <dl className="mt-2 grid gap-1 text-green-900 sm:grid-cols-2">
              <div>
                <dt className="inline text-green-700">Importiert: </dt>
                <dd className="inline">
                  {formatTimestamp(briefing.meta.imported_at)}
                </dd>
              </div>
              <div>
                <dt className="inline text-green-700">Werkzeug: </dt>
                <dd className="inline">{briefing.meta.tool}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="inline text-green-700">SHA-256: </dt>
                <dd className="inline font-mono text-xs">
                  {briefing.meta.sha256}
                </dd>
              </div>
            </dl>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">
              Eingefrorener Originaltext
            </h2>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-800">
              {briefing.text}
            </pre>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-white p-6">
          <BriefingForm projectId={id} />
        </div>
      )}
    </div>
  );
}

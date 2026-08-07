import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { SubpageHeader } from "@/app/components/ui";
import { formatCitation, isSourceSetFrozen, readProject } from "@/lib/pipeline";
import { formatTimestamp } from "../../status-labels";
import { CaptureSourceForm, FreezeSourceSetForm } from "./SourceForms";

export const dynamic = "force-dynamic";

const SOURCE_TYPE_LABELS: Record<string, string> = {
  begutachtete_publikation: "Begutachtete Publikation",
  preprint: "Preprint",
  grauliteratur: "Grauliteratur",
  herstellerdokumentation: "Herstellerdokumentation",
};

export default async function SourcesPage(
  props: PageProps<"/projects/[id]/sources">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const frozen = isSourceSetFrozen(register);

  return (
    <div className="space-y-6">
      <SubpageHeader projectId={id} title="Quellen" />

      {frozen ? (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <p className="font-medium">Quellenbestand eingefroren</p>
          <p className="mt-1">
            Revision {register.project.source_set_revision} ·{" "}
            {register.sources.length} Quelle(n). Alle Prüfungen referenzieren
            diesen Stand.
          </p>
        </div>
      ) : null}

      <section className="rounded-md border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-700">
          Erfasste Quellen ({register.sources.length})
        </h2>
        {register.sources.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            Noch keine Quellen erfasst.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {register.sources.map((source) => {
              const snapshot = source.custom.snapshot;
              return (
                <li key={source.id} className="px-5 py-4">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-medium">
                      {formatCitation(source)}
                    </span>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {SOURCE_TYPE_LABELS[source.custom.source_type]}
                    </span>
                  </div>
                  {typeof source.title === "string" ? (
                    <p className="mt-0.5 text-sm text-slate-600">
                      {source.title}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span className="font-mono">{source.id}</span>
                    {source.custom.identifier_verified?.status ? (
                      <span className="text-green-600">
                        ✓ Identifier verifiziert
                      </span>
                    ) : null}
                    {snapshot ? (
                      <>
                        <span>
                          Snapshot: {formatTimestamp(snapshot.retrieved_at)}{" "}
                          (Revision {snapshot.revision})
                        </span>
                        <span className="font-mono">
                          {snapshot.sha256.slice(0, 12)}…
                        </span>
                        {snapshot.text_blob_path ? (
                          <span className="text-green-600">
                            ✓ Volltext extrahiert
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  {snapshot?.text_extraction_error ? (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      ⚠ {snapshot.text_extraction_error}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!frozen ? (
        <>
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-700">
              Quelle erfassen
            </h2>
            <CaptureSourceForm projectId={id} />
          </section>
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">
              Quellenbestand einfrieren
            </h2>
            <FreezeSourceSetForm
              projectId={id}
              sourceCount={register.sources.length}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}

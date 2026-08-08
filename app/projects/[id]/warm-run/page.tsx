import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { SubpageHeader } from "@/app/components/ui";
import {
  getProjectSummary,
  isSourceSetFrozen,
  readProject,
} from "@/lib/pipeline";
import { WarmRunForm } from "./WarmRunForm";

export const dynamic = "force-dynamic";

export default async function WarmRunPage(
  props: PageProps<"/projects/[id]/warm-run">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const summary = await getProjectSummary(id);
  const frozen = isSourceSetFrozen(register);
  const settled =
    summary.claim_counts.bestaetigt +
    summary.claim_counts.automatisch_bestaetigt +
    summary.claim_counts.verworfen;

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Folgefrage (warmer Lauf)" />
        <p className="mt-1 text-sm text-slate-600">
          Ein warmer Lauf legt ein Folgeprojekt auf demselben eingefrorenen
          Quellenbestand an: abgeschlossene Claims werden mit Herkunftsvermerk
          übernommen, neu bewertet wird nur ihre Einschlägigkeit für die neue
          Frage – nicht erneut Existenz und Attribution.
        </p>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-5 text-sm">
        <p>
          Ursprungsprojekt: <span className="font-mono">{id}</span>
        </p>
        <p className="mt-1 text-slate-600">{summary.research_question}</p>
        <p className="mt-2 text-xs text-slate-500">
          {settled} abgeschlossene(r) Claim(s) übernehmbar (
          {summary.claim_counts.bestaetigt} bestätigt,{" "}
          {summary.claim_counts.automatisch_bestaetigt} automatisch bestätigt,{" "}
          {summary.claim_counts.verworfen} verworfen) · {summary.source_count}{" "}
          Quelle(n), Bestandsrevision {register.project.source_set_revision}.
        </p>
      </div>

      {!frozen ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Der Quellenbestand ist noch nicht eingefroren – warme Läufe setzen
          einen eingefrorenen Bestand voraus.
        </p>
      ) : settled === 0 ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Noch keine abgeschlossenen Claims (bestätigt, automatisch bestätigt
          oder verworfen) – es gibt nichts zu übernehmen.
        </p>
      ) : (
        <section className="rounded-md border border-slate-200 bg-white p-5">
          <WarmRunForm originProjectId={id} />
        </section>
      )}
    </div>
  );
}

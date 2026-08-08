import { loadProjectOrNotFound } from "@/app/lib/load-project";
import { SubpageHeader } from "@/app/components/ui";
import { readProject } from "@/lib/pipeline";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage(
  props: PageProps<"/projects/[id]/settings">,
) {
  const { id } = await props.params;
  const register = await loadProjectOrNotFound(() => readProject(id));

  return (
    <div className="space-y-6">
      <div>
        <SubpageHeader projectId={id} title="Einstellungen" />
        <p className="mt-1 text-sm text-slate-600">
          Konfiguration des Projekts (config-Block von claims.json). Jede
          Änderung wird als Projektereignis mit vollständigem Vorher/Nachher in
          der Hash-Kette protokolliert – wer, wann, welcher Wert.
        </p>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <SettingsForm projectId={id} config={register.config} />
      </section>
    </div>
  );
}

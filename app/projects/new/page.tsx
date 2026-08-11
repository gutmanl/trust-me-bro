import { isApiBackendEnabled } from "@/lib/pipeline";

import { CreateProjectForm } from "./CreateProjectForm";

export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Projekt anlegen</h1>
      <p className="text-sm text-slate-600">
        Ein Projekt bindet ein recherchiertes Briefing an eine Recherchefrage
        und einen Quellenbestand. Die Anlage schreibt das Projektverzeichnis
        nach Anhangsformat mit dem Projektanlage-Ereignis als erstem
        Kettenglied.
      </p>
      <div className="rounded-md border border-slate-200 bg-white p-6">
        <CreateProjectForm apiBackendEnabled={isApiBackendEnabled()} />
      </div>
    </div>
  );
}

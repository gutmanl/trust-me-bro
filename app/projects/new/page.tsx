import type { Metadata } from "next";
import {
  getInstallationBackendsHealth,
  isApiBackendEnabled,
  usableRealBackends,
} from "@/lib/pipeline";

import { CreateProjectForm } from "./CreateProjectForm";

/**
 * Async because the form needs the installation's backend diagnosis: the
 * choice of model family is the one decision on this page that can be made
 * unusable by something outside the form, and it is cheap to answer here
 * (stages 1+2 are a `--version` spawn, the same call the wizard and the
 * settings page already make).
 */
export const metadata: Metadata = { title: "Projekt anlegen" };

export default async function NewProjectPage() {
  const health = await getInstallationBackendsHealth();
  const usableRealCliIds = usableRealBackends(health).map(
    (backend) => backend.cli,
  );

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
        <CreateProjectForm
          apiBackendEnabled={isApiBackendEnabled()}
          usableRealCliIds={usableRealCliIds}
        />
      </div>
    </div>
  );
}

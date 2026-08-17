import type { Metadata } from "next";
import Link from "next/link";

import { BackendHealthCards } from "@/app/components/BackendHealthCards";
import {
  getActorHandleSetting,
  getInstallationBackendsHealth,
  getUnpaywallSetting,
  getWorkspaceRootSetting,
  usableRealBackends,
} from "@/lib/pipeline";

import { ActorHandleForm, UnpaywallForm } from "./InstallationSettingsForms";

export const metadata: Metadata = { title: "Einstellungen" };

export const dynamic = "force-dynamic";

/**
 * Installation settings (TMB-54, D6/D7) — deliberately distinct from the
 * per-project settings at /projects/[id]/settings: what lives here applies
 * to the installation as a whole and exists before any project does.
 */
export default async function InstallationSettingsPage() {
  const health = await getInstallationBackendsHealth();
  const workspace = getWorkspaceRootSetting();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Einstellungen</h1>
        <p className="mt-2 text-sm text-slate-600">
          Gilt für diese Installation, nicht für ein einzelnes Projekt. Die
          Konfiguration eines Projekts (Backends, Stichprobenrate,
          Bewertungsschema) steht in dessen eigenen Einstellungen.
        </p>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">Akteur</h2>
        <div className="mt-3">
          <ActorHandleForm setting={getActorHandleSetting()} />
        </div>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Arbeitsverzeichnis
        </h2>
        <p className="mt-2 font-mono text-sm text-slate-700">
          {workspace.root}
        </p>
        <p className="mt-2 text-sm text-slate-500">
          {workspace.source === "env" ? (
            <>
              Über die Umgebungsvariable{" "}
              <code className="font-mono">TMB_WORKSPACE</code> gesetzt.
            </>
          ) : (
            <>
              Nach dem Anlegen des ersten Projekts nicht mehr änderbar: ein
              Wechsel würde die vorhandenen Projekte zurücklassen, und die
              Anwendung verschiebt sie nicht. Ein anderer Ort lässt sich
              erreichen, indem die Projektordner von Hand verschoben und{" "}
              <code className="font-mono">TMB_WORKSPACE</code> gesetzt wird.
            </>
          )}
        </p>
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Referenz-Import
        </h2>
        <div className="mt-3">
          <UnpaywallForm setting={getUnpaywallSetting()} />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            Bereitschaftsprüfung
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Dreistufige Prüfung je Backend, unabhängig von einem Projekt. Stufe
            3 ist ein echter Testaufruf und kostet einen kleinen
            Kontingentanteil – deshalb nur auf Knopfdruck.
          </p>
        </div>
        <BackendHealthCards health={health} />
        {usableRealBackends(health).length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Zurzeit ist kein Backend einsatzbereit. Mit dem Demo-Backend lässt
            sich der Ablauf trotzdem ansehen – seine Ergebnisse sind
            vorgefertigt und keine echte Verifikation.
          </p>
        ) : null}
      </section>

      <p className="text-sm text-slate-500">
        <Link href="/setup?step=1" className="underline">
          Einrichtungsassistent erneut öffnen
        </Link>
      </p>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";

import { BackendHealthCards } from "@/app/components/BackendHealthCards";
import { ResearchGuidance } from "@/app/components/ResearchGuidance";
import { primaryButtonClass } from "@/app/components/ui";
import {
  getInstallationBackendsHealth,
  getUnpaywallSetting,
  getWorkspaceRootSetting,
  isSetupComplete,
} from "@/lib/pipeline";

import {
  CreateDemoProjectButton,
  HandleStep,
  UnpaywallStep,
  WorkspaceStep,
} from "./SetupForm";

export const dynamic = "force-dynamic";

/**
 * First-run wizard (TMB-54, D4). One route with the step in a query
 * parameter, not one route per step: proxy.ts exempts exactly `/setup`
 * while the identity is unconfigured, so every extra route would have to be
 * added to that exemption.
 *
 * The installation counts as set up as soon as the actor handle exists —
 * unchanged from before. Steps 2 to 5 are optional, so a tab closed halfway
 * through leaves a usable installation instead of locking the user out.
 */

const STEPS = [
  "Kürzel",
  "Arbeitsverzeichnis",
  "Backends",
  "Unpaywall",
  "Loslegen",
] as const;

function StepRail({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                step === current
                  ? "font-medium text-slate-900"
                  : done
                    ? "text-slate-600"
                    : "text-slate-400"
              }
            >
              {step}. {label}
            </span>
            {step < STEPS.length ? <span aria-hidden>·</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function parseStep(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(value) && value >= 1 && value <= STEPS.length
    ? value
    : 1;
}

export default async function SetupPage(props: PageProps<"/setup">) {
  const searchParams = await props.searchParams;
  const requested = parseStep(searchParams.step);
  const complete = isSetupComplete();

  // No step given and already configured: nothing to do here.
  if (searchParams.step === undefined && complete) {
    redirect("/projects");
  }
  // Later steps write installation settings, which need an identity to
  // attach to — send an unconfigured installation back to step 1.
  const step = complete ? requested : 1;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Ersteinrichtung</h1>
        <div className="mt-2">
          <StepRail current={step} />
        </div>
      </div>

      {step === 1 ? (
        <>
          <p className="text-sm text-slate-600">
            Willkommen bei TrustMeBro. Vor dem ersten Projekt braucht die
            Werkstatt genau eine Angabe: das Akteurskürzel, unter dem Ihre
            Entscheidungen im revisionssicheren Verlauf erscheinen. Alles
            Weitere ist optional und lässt sich überspringen.
          </p>
          <HandleStep />
        </>
      ) : null}

      {step === 2 ? (
        <WorkspaceStep setting={getWorkspaceRootSetting()} />
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Für die Prüfung nutzt die Anwendung eine Agenten-CLI. Hier steht,
            welche gefunden wurde und ob sie einsatzbereit ist –{" "}
            <strong>vor</strong> dem ersten Projekt, damit sich das nicht erst
            mitten in einem Lauf herausstellt.
          </p>
          <BackendHealthCards health={await getInstallationBackendsHealth()} />
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Ist keine CLI einsatzbereit, geht es trotzdem weiter: das
            Demo-Backend braucht weder Installation noch Konto. Es liefert
            vorgefertigte Ergebnisse – gut, um den Ablauf kennenzulernen, aber
            keine echte Verifikation.
          </p>
          <Link href="/setup?step=4" className={primaryButtonClass}>
            Weiter
          </Link>
        </div>
      ) : null}

      {step === 4 ? <UnpaywallStep setting={getUnpaywallSetting()} /> : null}

      {step === 5 ? (
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            Die Einrichtung ist abgeschlossen. Ein Projekt besteht aus einer
            Recherchefrage, einem importierten Briefing und dessen Quellen –
            geprüft wird von dort aus schrittweise.
          </p>
          <ResearchGuidance />
          <div className="flex flex-wrap items-start gap-3">
            <Link href="/projects/new" className={primaryButtonClass}>
              Erstes Projekt anlegen
            </Link>
            <CreateDemoProjectButton />
          </div>
          <p className="text-xs text-slate-500">
            Das Beispielprojekt ist ein gefülltes Demo-Register mit
            synthetischen Quellen. Es ist überall als Demo gekennzeichnet und
            seine Herkunft steht dauerhaft in der Hash-Kette.
          </p>
        </div>
      ) : null}
    </div>
  );
}

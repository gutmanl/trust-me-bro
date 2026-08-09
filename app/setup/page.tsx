import { redirect } from "next/navigation";

import { isSetupComplete } from "@/lib/pipeline";

import { SetupForm } from "./SetupForm";

export const dynamic = "force-dynamic";

/**
 * First-run setup (TMB-47/48): asks the one question the prototype needs
 * answered before any history entry can be written — the actor handle.
 * proxy.ts redirects every request here until the configuration exists.
 */
export default function SetupPage() {
  if (isSetupComplete()) {
    redirect("/projects");
  }
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Ersteinrichtung</h1>
        <p className="mt-2 text-sm text-slate-600">
          Willkommen bei TrustMeBro. Vor dem ersten Projekt braucht die
          Werkstatt genau eine Angabe: das Akteurskürzel, unter dem Ihre
          Entscheidungen im revisionssicheren Verlauf erscheinen.
        </p>
      </div>
      <SetupForm />
    </div>
  );
}

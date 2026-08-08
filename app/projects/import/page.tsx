import { ImportBundleForm } from "./ImportBundleForm";

export default function ImportBundlePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Bundle importieren</h1>
      <p className="text-sm text-slate-600">
        Ein erhaltenes .tmb-Export-Bundle wird als neues Projektverzeichnis in
        den Workspace entpackt. Vorher werden Manifest-Prüfsummen und Hash-Kette
        verifiziert; danach ist das Projekt regulär nutzbar und die Kette wird
        ab dem letzten Glied fortgesetzt.
      </p>
      <div className="rounded-md border border-slate-200 bg-white p-6">
        <ImportBundleForm />
      </div>
    </div>
  );
}

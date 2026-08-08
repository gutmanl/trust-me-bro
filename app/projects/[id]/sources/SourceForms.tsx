"use client";

import { useActionState, useState } from "react";

import {
  ErrorBanner,
  fileInputClass,
  inputClass,
  primaryButtonClass,
  SuccessBanner,
} from "@/app/components/ui";
import type { ReviseFormState, SourceFormState } from "./actions";
import {
  captureSourceAction,
  freezeSourceSetAction,
  reviseSourceAction,
} from "./actions";

const initialState: SourceFormState = { error: null };

const KIND_TABS = [
  { kind: "doi", label: "DOI" },
  { kind: "arxiv", label: "arXiv" },
  { kind: "url", label: "URL" },
  { kind: "upload", label: "Datei" },
] as const;

type Kind = (typeof KIND_TABS)[number]["kind"];

function ManualFields({ required }: { required: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="title" className="mb-1 block text-sm font-medium">
          Titel {required ? "" : "(optional)"}
        </label>
        <input
          id="title"
          name="title"
          required={required}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="authors" className="mb-1 block text-sm font-medium">
          Autor(en)
        </label>
        <input
          id="authors"
          name="authors"
          placeholder="Nachname, Vorname; Nachname, Vorname"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="year" className="mb-1 block text-sm font-medium">
          Jahr
        </label>
        <input
          id="year"
          name="year"
          placeholder="2026"
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label
          htmlFor="container_title"
          className="mb-1 block text-sm font-medium"
        >
          Erschienen in
        </label>
        <input
          id="container_title"
          name="container_title"
          placeholder="Zeitschrift, Konferenz, Reihe …"
          className={inputClass}
        />
      </div>
    </div>
  );
}

export function CaptureSourceForm({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<Kind>("doi");
  const [state, formAction, pending] = useActionState(
    captureSourceAction.bind(null, projectId),
    initialState,
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md bg-slate-100 p-1">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            onClick={() => setKind(tab.kind)}
            className={`flex-1 rounded px-3 py-1.5 text-sm font-medium ${
              kind === tab.kind
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="kind" value={kind} />

        {kind === "doi" || kind === "arxiv" ? (
          <div>
            <label
              htmlFor="identifier"
              className="mb-1 block text-sm font-medium"
            >
              {kind === "doi" ? "DOI" : "arXiv-Id"}
            </label>
            <input
              id="identifier"
              name="identifier"
              required
              placeholder={
                kind === "doi"
                  ? "10.1109/TSE.2025.3489012 oder doi.org-Link"
                  : "2401.12345 oder arxiv.org-Link"
              }
              className={`${inputClass} font-mono`}
            />
            <p className="mt-1 text-xs text-slate-500">
              Bibliografische Metadaten werden automatisch aufgelöst (CSL-JSON).
            </p>
          </div>
        ) : null}

        {kind === "url" ? (
          <div>
            <label
              htmlFor="identifier"
              className="mb-1 block text-sm font-medium"
            >
              URL der Quelle
            </label>
            <input
              id="identifier"
              name="identifier"
              type="url"
              required
              placeholder="https://…"
              className={`${inputClass} font-mono`}
            />
          </div>
        ) : null}

        {kind === "doi" ? (
          <div>
            <label
              htmlFor="document_url"
              className="mb-1 block text-sm font-medium"
            >
              Dokument-URL (PDF/HTML)
            </label>
            <input
              id="document_url"
              name="document_url"
              type="url"
              placeholder="Direktlink zum Volltext – oder unten Datei hochladen"
              className={`${inputClass} font-mono`}
            />
          </div>
        ) : null}

        {kind === "url" || kind === "upload" ? <ManualFields required /> : null}

        {kind !== "url" ? (
          <div>
            <label htmlFor="file" className="mb-1 block text-sm font-medium">
              {kind === "upload"
                ? "Quellendokument (PDF/HTML/Text)"
                : "… oder Quellendokument hochladen"}
            </label>
            <input
              id="file"
              name="file"
              type="file"
              required={kind === "upload"}
              accept=".pdf,.html,.htm,.txt,.md,application/pdf,text/html,text/plain"
              className={fileInputClass}
            />
          </div>
        ) : null}

        <div>
          <label
            htmlFor="source_type"
            className="mb-1 block text-sm font-medium"
          >
            Quellentyp (Rubrik-Gewichtung)
          </label>
          <select
            id="source_type"
            name="source_type"
            defaultValue={
              kind === "arxiv" ? "preprint" : "begutachtete_publikation"
            }
            className={inputClass}
          >
            <option value="begutachtete_publikation">
              Begutachtete Publikation
            </option>
            <option value="preprint">Preprint</option>
            <option value="grauliteratur">Grauliteratur</option>
            <option value="herstellerdokumentation">
              Herstellerdokumentation
            </option>
          </select>
        </div>

        <ErrorBanner message={state.error} />
        {state.captured ? (
          <SuccessBanner>
            Quelle <span className="font-mono">{state.captured}</span> erfasst
            und Snapshot eingefroren.
          </SuccessBanner>
        ) : null}

        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Wird erfasst …" : "Quelle erfassen und einfrieren"}
        </button>
      </form>
    </div>
  );
}

const initialReviseState: ReviseFormState = { error: null };

/**
 * Disclosure-style per-source revision form (TMB-44), only rendered on a
 * frozen set: re-fetch from a URL or upload the current document; identical
 * content is recognized via checksum and changes nothing.
 */
export function ReviseSourceForm({
  projectId,
  sourceId,
}: {
  projectId: string;
  sourceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    reviseSourceAction.bind(null, projectId, sourceId),
    initialReviseState,
  );

  if (!open) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs font-medium text-slate-500 underline decoration-slate-300 hover:text-slate-700"
        >
          Quelle revidieren …
        </button>
        {state.revised === true ? (
          <SuccessBanner>
            Revision {state.newRevision} erstellt – {state.recheckedCount}{" "}
            Claim(s) zur Nachprüfung markiert.
          </SuccessBanner>
        ) : null}
        {state.revised === false ? (
          <SuccessBanner>
            Inhalt unverändert (Prüfsumme identisch) – keine neue Revision.
          </SuccessBanner>
        ) : null}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <p className="text-xs text-slate-600">
        Aktualisierte Fassung der Quelle laden: Die alte Revision bleibt im
        Blob-Store erhalten; betroffene, bereits geprüfte Claims wandern zur
        Nachprüfung.
      </p>
      <div>
        <label
          htmlFor={`revise_url_${sourceId}`}
          className="mb-1 block text-xs font-medium"
        >
          Dokument-URL (PDF/HTML)
        </label>
        <input
          id={`revise_url_${sourceId}`}
          name="document_url"
          type="url"
          placeholder="https://… – oder unten Datei hochladen"
          className={`${inputClass} font-mono`}
        />
      </div>
      <div>
        <label
          htmlFor={`revise_file_${sourceId}`}
          className="mb-1 block text-xs font-medium"
        >
          … oder Quellendokument hochladen
        </label>
        <input
          id={`revise_file_${sourceId}`}
          name="file"
          type="file"
          accept=".pdf,.html,.htm,.txt,.md,application/pdf,text/html,text/plain"
          className={fileInputClass}
        />
      </div>
      <ErrorBanner message={state.error} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Wird revidiert …" : "Revision erstellen"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

export function FreezeSourceSetForm({
  projectId,
  sourceCount,
}: {
  projectId: string;
  sourceCount: number;
}) {
  const [state, formAction, pending] = useActionState(
    freezeSourceSetAction.bind(null, projectId),
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3">
      <p className="text-sm text-slate-600">
        Das Einfrieren schließt die Erfassung ab: Alle Prüfungen beziehen sich
        danach auf genau diesen Bestand ({sourceCount} Quelle(n)).
      </p>
      <ErrorBanner message={state.error} />
      <button
        type="submit"
        disabled={pending || sourceCount === 0}
        className="rounded-md border border-slate-900 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-900 hover:text-white disabled:opacity-50"
      >
        {pending ? "Wird eingefroren …" : "Quellenbestand einfrieren"}
      </button>
    </form>
  );
}

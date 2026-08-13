"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Modal } from "@/app/components/Modal";
import {
  ErrorBanner,
  fileInputClass,
  inputClass,
  primaryButtonClass,
  SuccessBanner,
} from "@/app/components/ui";
import { SOURCE_TYPE_LABELS } from "../../status-labels";
import type { ReviseFormState, SourceFormState } from "./actions";
import { enqueueCaptureSourceAction, reviseSourceAction } from "./actions";

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

/**
 * "+ Quelle erfassen" in the sources-list header: opens the capture modal
 * (source work items). Mounting the modal is opening it; a successful
 * submit closes it and the queued work item appears as a list row.
 */
export function CaptureSourceButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
      >
        + Quelle erfassen
      </button>
      {open ? (
        <CaptureSourceModal
          projectId={projectId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CaptureSourceModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("doi");
  const [state, formAction, pending] = useActionState(
    enqueueCaptureSourceAction.bind(null, projectId),
    initialState,
  );
  // Close exactly once per successful submit (state identity change), from
  // an effect — closing also unmounts this component, so it must not happen
  // during render.
  const adopted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.queued !== undefined && adopted.current !== state.queued) {
      adopted.current = state.queued;
      onClose();
    }
  }, [state.queued, onClose]);

  return (
    <Modal title="Quelle erfassen" onClose={onClose}>
      <CaptureSourceFields
        kind={kind}
        onKindChange={setKind}
        formAction={formAction}
        pending={pending}
        error={state.error}
      />
    </Modal>
  );
}

function CaptureSourceFields({
  kind,
  onKindChange,
  formAction,
  pending,
  error,
}: {
  kind: Kind;
  onKindChange: (kind: Kind) => void;
  formAction: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md bg-slate-100 p-1">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            onClick={() => onKindChange(tab.kind)}
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
              kind === "arxiv" ? "preprint" : "peer_reviewed_publication"
            }
            className={inputClass}
          >
            {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <ErrorBanner message={error} />

        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Wird eingereiht …" : "Erfassung starten"}
        </button>
        <p className="text-xs text-slate-500">
          Die Erfassung läuft im Hintergrund und reiht sich hinter laufende
          Schritte des Projekts ein; der Fortschritt erscheint direkt in der
          Quellenliste. Ein Server-Neustart verwirft eine noch wartende
          Erfassung – begonnene oder fehlgeschlagene Versuche bleiben erhalten.
        </p>
      </form>
    </div>
  );
}

const initialReviseState: ReviseFormState = { error: null };

/**
 * Per-source revision (TMB-44), now behind a modal like the capture form:
 * re-fetch from a URL or upload the current document; identical content is
 * recognized via checksum and changes nothing. The outcome banners render
 * under the trigger, where the row shows them after the modal closed.
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
  // Close on a successful submit (state identity change), like the capture
  // modal: `revised` is set on success in both of its variants.
  const adopted = useRef<ReviseFormState | undefined>(undefined);
  useEffect(() => {
    if (state.revised !== undefined && adopted.current !== state) {
      adopted.current = state;
      setOpen(false);
    }
  }, [state]);

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
      {open ? (
        <Modal title="Quelle revidieren" onClose={() => setOpen(false)}>
          <form action={formAction} className="space-y-3">
            <p className="text-xs text-slate-600">
              Aktualisierte Fassung der Quelle laden: Die alte Revision bleibt
              im Blob-Store erhalten; betroffene, bereits geprüfte Claims
              wandern zur Nachprüfung.
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
              <button
                type="submit"
                disabled={pending}
                className={primaryButtonClass}
              >
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
        </Modal>
      ) : null}
    </div>
  );
}

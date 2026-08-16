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
import type { SourceType } from "@/lib/register";
import { SOURCE_TYPE_LABELS } from "../../status-labels";
import type { CorrectSourceFormState, SourceFormState } from "./actions";
import { correctSourceAction, enqueueCaptureSourceAction } from "./actions";

const initialState: SourceFormState = { error: null };

const KIND_TABS = [
  { kind: "doi", label: "DOI" },
  { kind: "arxiv", label: "arXiv" },
  { kind: "url", label: "URL" },
  { kind: "upload", label: "Datei" },
] as const;

type Kind = (typeof KIND_TABS)[number]["kind"];

/** The segmented tab bar both modals use — one renderer, so the kind tabs
 * and the correction form's mode toggle can never drift apart visually. */
function SegmentedTabs<Value extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md bg-slate-100 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={`flex-1 rounded px-3 py-1.5 text-sm font-medium ${
            value === tab.value
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

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
 * The identity half both modals share (source correction): kind tabs plus
 * the identifier/document-URL/metadata/file inputs of that kind. Renders
 * INSIDE the caller's form — the caller owns the hidden `kind` input, the
 * submit button and whatever else its use-case needs around this.
 */
function IdentityFields({
  kind,
  onKindChange,
}: {
  kind: Kind;
  onKindChange: (kind: Kind) => void;
}) {
  return (
    <>
      <SegmentedTabs
        tabs={KIND_TABS.map((tab) => ({ value: tab.kind, label: tab.label }))}
        value={kind}
        onChange={onKindChange}
      />

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
    </>
  );
}

function SourceTypeSelect({ defaultValue }: { defaultValue: SourceType }) {
  return (
    <div>
      <label htmlFor="source_type" className="mb-1 block text-sm font-medium">
        Quellentyp (Gewichtung im Bewertungsschema)
      </label>
      <select
        id="source_type"
        name="source_type"
        defaultValue={defaultValue}
        className={inputClass}
      >
        {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
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
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="kind" value={kind} />
        <IdentityFields kind={kind} onKindChange={setKind} />
        <SourceTypeSelect
          key={kind}
          defaultValue={
            kind === "arxiv" ? "preprint" : "peer_reviewed_publication"
          }
        />
        <ErrorBanner message={state.error} />
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
    </Modal>
  );
}

const initialCorrectState: CorrectSourceFormState = { error: null };

/**
 * Per-source "Quelle korrigieren" (TMB-44 revision + source correction),
 * behind one modal with two modes: document mode re-freezes the current
 * document (identical content is recognized via checksum and changes
 * nothing); identity mode replaces a wrong — typically hallucinated —
 * DOI/URL by re-capturing the identity on the same source id, queued as a
 * work item whose progress the row shows. The outcome banners render under
 * the trigger, where the row shows them after the modal closed.
 */
export function CorrectSourceForm({
  projectId,
  sourceId,
  currentKind,
  currentSourceType,
}: {
  projectId: string;
  sourceId: string;
  /** Prefill for the identity tabs, derived from the source's current
   * identifier shape. */
  currentKind: Kind;
  currentSourceType: SourceType;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"document" | "identity">("document");
  const [kind, setKind] = useState<Kind>(currentKind);
  const [state, formAction, pending] = useActionState(
    correctSourceAction.bind(null, projectId, sourceId),
    initialCorrectState,
  );
  // Close on a successful submit (state identity change), like the capture
  // modal — either mode's success marker counts.
  const adopted = useRef<CorrectSourceFormState | undefined>(undefined);
  useEffect(() => {
    if (
      (state.revised !== undefined || state.queuedCorrection !== undefined) &&
      adopted.current !== state
    ) {
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
        Quelle korrigieren …
      </button>
      {state.revised === true ? (
        <SuccessBanner>
          Revision {state.newRevision} erstellt – {state.recheckedCount}{" "}
          Aussage(n) zur Nachprüfung markiert.
        </SuccessBanner>
      ) : null}
      {state.revised === false ? (
        <SuccessBanner>
          Inhalt unverändert (Prüfsumme identisch) – keine neue Revision.
        </SuccessBanner>
      ) : null}
      {open ? (
        <Modal title="Quelle korrigieren" onClose={() => setOpen(false)}>
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="mode" value={mode} />
            <SegmentedTabs
              tabs={[
                { value: "document", label: "Dokument aktualisieren" },
                { value: "identity", label: "Kennung korrigieren" },
              ]}
              value={mode}
              onChange={setMode}
            />

            {mode === "identity" ? (
              <>
                <p className="text-xs text-amber-700">
                  Für eine falsch aufgelöste Kennung (z.&nbsp;B. eine
                  halluzinierte DOI): Die Quelle behält ihre Id und alle
                  Aussagen-Verweise; Metadaten und Dokument werden aus der
                  korrigierten Kennung neu eingefroren, die bisherige Kennung
                  bleibt in der Historie erhalten. Betroffene Aussagen – auch
                  bereits wegen der falschen Kennung in der manuellen
                  Überprüfung gestrandete – wandern zur Nachprüfung.
                </p>
                <input type="hidden" name="kind" value={kind} />
                <IdentityFields kind={kind} onKindChange={setKind} />
                <SourceTypeSelect defaultValue={currentSourceType} />
              </>
            ) : (
              <>
                <p className="text-xs text-slate-600">
                  Aktualisierte Fassung der Quelle laden: Die alte Revision
                  bleibt im Blob-Store erhalten; betroffene, bereits geprüfte
                  Aussagen wandern zur Nachprüfung.
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
              </>
            )}
            <ErrorBanner message={state.error} />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={pending}
                className={primaryButtonClass}
              >
                {pending
                  ? mode === "identity"
                    ? "Wird eingereiht …"
                    : "Wird revidiert …"
                  : mode === "identity"
                    ? "Korrektur starten"
                    : "Revision erstellen"}
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

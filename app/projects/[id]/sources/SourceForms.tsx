"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Modal } from "@/app/components/Modal";
import {
  ErrorBanner,
  compactButtonClass,
  fileInputClass,
  inputClass,
  primaryButtonClass,
  SuccessBanner,
} from "@/app/components/ui";
import type { DerivedMetadataCandidate } from "@/lib/pipeline";
import type { SourceType } from "@/lib/register";
import { SOURCE_TYPE_LABELS } from "../../status-labels";
import type {
  CorrectSourceFormState,
  DeriveMetadataFormState,
  SourceFormState,
} from "./actions";
import {
  correctSourceAction,
  deriveMetadataAction,
  enqueueCaptureSourceAction,
} from "./actions";

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

/** Pre-fill for the manual fields — what a derivation worked out before the
 * user rejected it, so the fallback starts filled rather than empty (D-10). */
interface ManualFieldDefaults {
  title?: string;
  authors?: string;
  year?: string;
  container_title?: string;
}

function ManualFields({
  required,
  defaults,
}: {
  required: boolean;
  defaults?: ManualFieldDefaults;
}) {
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
          defaultValue={defaults?.title}
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
          defaultValue={defaults?.authors}
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
          defaultValue={defaults?.year}
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
          defaultValue={defaults?.container_title}
          className={inputClass}
        />
      </div>
    </div>
  );
}

/**
 * The identity half every modal mode shares (source correction): kind tabs
 * plus the identifier/document-URL/metadata/file inputs of that kind.
 * Renders INSIDE the caller's form — the caller owns the hidden `kind`
 * input, the submit button and whatever else its use-case needs around this.
 *
 * `withDocument={false}` keeps the full kind tabs but drops every input
 * that would acquire a document — the document-URL field and the file
 * picker, for EVERY kind including `upload`. That is what lets the
 * metadata-only mode correct a bibliographic identity without asking for
 * the document again.
 */
function IdentityFields({
  kind,
  onKindChange,
  withDocument = true,
}: {
  kind: Kind;
  onKindChange: (kind: Kind) => void;
  withDocument?: boolean;
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

      {kind === "doi" && withDocument ? (
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

      {kind !== "url" && withDocument ? (
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
        className={compactButtonClass}
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

const initialDeriveState: DeriveMetadataFormState = { error: null };

/**
 * The ONE German result line a derived candidate gets (D-17). Four
 * outcomes, four sentences: what was found, whether it can be trusted, and
 * what the user's next move is. Nothing here has entered the register —
 * this is a proposal.
 */
function CandidateSummary({
  candidate,
}: {
  candidate: DerivedMetadataCandidate;
}) {
  if (candidate.status === "verified") {
    return (
      <p className="text-xs break-words text-emerald-700">
        Im Dokument gefunden: {candidate.citation} –{" "}
        {candidate.kind === "doi" ? "DOI" : "arXiv-Id"} {candidate.identifier}.
        Fundstelle: „{candidate.matchedLine}“.
      </p>
    );
  }
  if (candidate.status === "unverified") {
    return (
      <p className="text-xs break-words text-amber-700">
        Im Dokument wurde eine Kennung gefunden ({candidate.identifier}), doch
        die aufgelösten Metadaten stimmen nicht sicher mit dem Dokumenttext
        überein – bitte prüfen und bei Bedarf korrigieren.
      </p>
    );
  }
  if (candidate.status === "unresolved") {
    return (
      <p className="text-xs break-words text-amber-700">
        Im Dokument wurde eine Kennung gefunden ({candidate.identifier}), sie
        ließ sich aber gerade nicht auflösen – bitte die Metadaten prüfen oder
        von Hand eingeben.
      </p>
    );
  }
  return (
    <p className="text-xs break-words text-amber-700">
      Im Dokument wurde keine Kennung (DOI/arXiv) gefunden – bitte die Metadaten
      von Hand eingeben.
      {candidate.reason === "no_text"
        ? " (aus dem Dokument ließ sich kein Text lesen)"
        : ""}
    </p>
  );
}

/** The manual pre-fill a candidate carries, if it carries one — `not_found`
 * resolved nothing, so it has nothing to pre-fill with. */
function candidateDefaults(
  candidate: DerivedMetadataCandidate | undefined,
): ManualFieldDefaults | undefined {
  return candidate !== undefined &&
    (candidate.status === "verified" || candidate.status === "unverified")
    ? candidate.manual
    : undefined;
}

const initialCorrectState: CorrectSourceFormState = { error: null };

/** The correction modal's three modes. `both` is the historical `identity`
 * mode — renamed once metadata-only existed, because "identity" no longer
 * says which of the two it is. */
type CorrectionMode = "document" | "metadata" | "both";

const CORRECTION_MODE_TABS: readonly {
  value: CorrectionMode;
  label: string;
}[] = [
  { value: "document", label: "Dokument aktualisieren" },
  { value: "metadata", label: "Nur Metadaten korrigieren" },
  { value: "both", label: "Kennung und Dokument korrigieren" },
];

/** Submit labels per mode, idle and pending — a lookup rather than nested
 * ternaries, so a fourth mode cannot be half-labelled. */
const CORRECTION_SUBMIT_LABELS: Record<
  CorrectionMode,
  { idle: string; pending: string }
> = {
  document: { idle: "Neue Fassung erstellen", pending: "Wird revidiert …" },
  metadata: { idle: "Metadaten korrigieren", pending: "Wird korrigiert …" },
  both: { idle: "Korrektur starten", pending: "Wird eingereiht …" },
};

/** Every success discriminant of correctSourceAction, in ONE place: each
 * mode reports its outcome under its own field, and a mode missing from
 * this predicate would silently leave the modal open on success. */
function correctionSucceeded(state: CorrectSourceFormState): boolean {
  return (
    state.revised !== undefined ||
    state.metadataCorrected !== undefined ||
    state.queuedCorrection !== undefined
  );
}

/**
 * Per-source "Quelle korrigieren" (TMB-44 revision + source correction),
 * behind one modal with three modes:
 *
 * - document — re-freezes the current document (identical content is
 *   recognized via checksum and changes nothing), identity untouched;
 * - metadata — replaces a wrong — typically hallucinated — bibliographic
 *   identity and leaves the frozen document exactly as it is, synchronously;
 * - both — re-captures identity AND document on the same source id, queued
 *   as a work item whose progress the row shows. For the file and URL kinds
 *   it is a two-step wizard: "Metadaten aus Dokument ableiten" reads the
 *   document and PROPOSES the identity it states about itself, and only the
 *   confirmation writes anything (D-09). The confirmation carries the blob
 *   the derive step already froze, so the document is uploaded exactly once.
 *
 * The outcome banners render under the trigger, where the row shows them
 * after the modal closed.
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
  const [mode, setMode] = useState<CorrectionMode>("document");
  const [kind, setKind] = useState<Kind>(currentKind);
  // The "both" mode is a two-step wizard: derive what the document says it
  // is, then confirm it. Everything else is a single step.
  const [step, setStep] = useState<"input" | "confirm">("input");
  // Whether the confirm step shows the manual fields instead of adopting the
  // candidate's identifier.
  const [manualFallback, setManualFallback] = useState(false);
  const [state, formAction, pending] = useActionState(
    correctSourceAction.bind(null, projectId, sourceId),
    initialCorrectState,
  );
  const [deriveState, deriveAction, derivePending] = useActionState(
    deriveMetadataAction.bind(null, projectId),
    initialDeriveState,
  );
  // Close on a successful submit (state identity change), like the capture
  // modal — any mode's success marker counts.
  const adopted = useRef<CorrectSourceFormState | undefined>(undefined);
  useEffect(() => {
    if (correctionSucceeded(state) && adopted.current !== state) {
      adopted.current = state;
      setOpen(false);
    }
  }, [state]);
  // Advance to the confirm step once per derivation, same adopted-ref idiom.
  const adoptedDerive = useRef<DeriveMetadataFormState | undefined>(undefined);
  useEffect(() => {
    if (
      deriveState.candidate !== undefined &&
      adoptedDerive.current !== deriveState
    ) {
      adoptedDerive.current = deriveState;
      setStep("confirm");
      // A verified candidate is the one-click case the whole flow exists
      // for; every other outcome asked the user to check or type something,
      // so the fields it needs are open already rather than one click away
      // behind a button whose label repeats the instruction.
      setManualFallback(deriveState.candidate.status !== "verified");
    }
  }, [deriveState]);

  const candidate = deriveState.candidate;
  const inBothConfirm = mode === "both" && step === "confirm";
  // Derivation only makes sense where a document is actually supplied: the
  // doi and arxiv kinds already carry an identifier that determines the
  // metadata outright.
  const canDerive =
    mode === "both" &&
    step === "input" &&
    (kind === "upload" || kind === "url");
  // Which identity the confirm submit sends. Adopting the candidate means
  // sending its kind and identifier and letting correctSource re-resolve
  // them; the manual fallback sends the tab's own kind and the fields the
  // user typed.
  const adoptsCandidate =
    !manualFallback &&
    candidate !== undefined &&
    candidate.status !== "not_found";
  const confirmKind: Kind = adoptsCandidate ? candidate.kind : kind;
  const confirmIdentifier = adoptsCandidate
    ? candidate.identifier
    : // The "url" kind's identifier IS its URL, and the input that held it
      // belongs to the previous step's form body — see
      // DeriveMetadataFormState.documentUrl.
      kind === "url"
      ? deriveState.documentUrl
      : undefined;

  function leaveConfirmStep() {
    setStep("input");
    setManualFallback(false);
  }

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
          Fassung {state.newRevision} erstellt – {state.recheckedCount}{" "}
          Aussage(n) zur Nachprüfung markiert.
        </SuccessBanner>
      ) : null}
      {state.revised === false ? (
        <SuccessBanner>
          Inhalt unverändert (Prüfsumme identisch) – keine neue Revision.
        </SuccessBanner>
      ) : null}
      {state.metadataCorrected === true ? (
        <SuccessBanner>
          Metadaten korrigiert – {state.recheckedCount} Aussage(n) zur
          Nachprüfung markiert.
        </SuccessBanner>
      ) : null}
      {open ? (
        <Modal title="Quelle korrigieren" onClose={() => setOpen(false)}>
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="mode" value={mode} />
            <SegmentedTabs
              tabs={CORRECTION_MODE_TABS}
              value={mode}
              onChange={(next) => {
                setMode(next);
                // Switching away abandons a half-finished wizard; coming
                // back must start at its input step, not mid-confirm.
                leaveConfirmStep();
              }}
            />

            {mode === "metadata" ? (
              <>
                <p className="text-xs text-amber-700">
                  Nur die bibliografischen Angaben werden ersetzt – das
                  eingefrorene Dokument bleibt unverändert. Betroffene Aussagen
                  wandern zur Nachprüfung.
                </p>
                <input type="hidden" name="kind" value={kind} />
                <IdentityFields
                  kind={kind}
                  onKindChange={setKind}
                  withDocument={false}
                />
                <SourceTypeSelect defaultValue={currentSourceType} />
              </>
            ) : inBothConfirm && candidate !== undefined ? (
              <>
                <CandidateSummary candidate={candidate} />
                {/* The document is NOT re-uploaded here: the derive step
                    already froze these bytes, so the confirmation carries a
                    blob reference (D-15). There is deliberately no file
                    input on this step. */}
                <input type="hidden" name="kind" value={confirmKind} />
                {confirmIdentifier !== undefined ? (
                  <input
                    type="hidden"
                    name="identifier"
                    value={confirmIdentifier}
                  />
                ) : null}
                <input
                  type="hidden"
                  name="upload_blob_path"
                  value={candidate.document.blob_path}
                />
                <input
                  type="hidden"
                  name="upload_filename"
                  value={candidate.document.filename}
                />
                {manualFallback ? (
                  <ManualFields
                    required
                    defaults={candidateDefaults(candidate)}
                  />
                ) : null}
                <SourceTypeSelect defaultValue={currentSourceType} />
              </>
            ) : mode === "both" ? (
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
                <ErrorBanner message={deriveState.error} />
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
            {inBothConfirm ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={pending}
                  className={primaryButtonClass}
                >
                  {pending
                    ? CORRECTION_SUBMIT_LABELS.both.pending
                    : "Übernehmen und Korrektur starten"}
                </button>
                {manualFallback ? null : (
                  <button
                    type="button"
                    onClick={() => setManualFallback(true)}
                    className="rounded-md px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
                  >
                    Stattdessen von Hand eingeben
                  </button>
                )}
                <button
                  type="button"
                  onClick={leaveConfirmStep}
                  className="rounded-md px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
                >
                  Zurück
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={pending}
                  className={primaryButtonClass}
                >
                  {pending
                    ? CORRECTION_SUBMIT_LABELS[mode].pending
                    : CORRECTION_SUBMIT_LABELS[mode].idle}
                </button>
                {canDerive ? (
                  // Reads the document and PROPOSES an identity. It writes
                  // nothing to the register — despite standing next to a
                  // button labelled "korrigieren", nothing is corrected
                  // until the confirm step is submitted (D-09).
                  //
                  // formNoValidate on purpose: the url/upload kinds mark
                  // their title field required for a CORRECTION, but a
                  // derivation is what answers what the title is. The
                  // action validates what it actually needs and reports a
                  // German banner if the document is missing.
                  <button
                    type="submit"
                    formAction={deriveAction}
                    formNoValidate
                    disabled={derivePending}
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {derivePending
                      ? "Wird ermittelt …"
                      : "Metadaten aus Dokument ableiten"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
                >
                  Abbrechen
                </button>
              </div>
            )}
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

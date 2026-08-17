import type { Metadata } from "next";
import Link from "next/link";

import { SubpageHeader } from "@/app/components/ui";
import { loadProjectOrNotFound } from "@/app/lib/load-project";
import {
  buildTimeline,
  getChainVerification,
  readProject,
} from "@/lib/pipeline";
import type { ChainVerificationResult } from "@/lib/pipeline";
import type { ClaimStatus } from "@/lib/register";
import { formatTimestamp, STATUS_LABELS } from "../../status-labels";
import { COMPLAINT_CATEGORY_LABELS } from "../review/complaint-labels";
import { ROUTING_LABELS } from "../review/routing-labels";

export const metadata: Metadata = { title: "Verlauf" };

export const dynamic = "force-dynamic";

/**
 * The append-only history (TMB-38): the mixed chain from the pipeline's
 * timeline projection, fully server-rendered; the claim filter is a plain
 * query parameter. Discarded claims stay visible with their reason (A6:
 * negative decisions remain reusable).
 */

const EVENT_LABELS: Record<string, string> = {
  project_created: "Projekt angelegt",
  briefing_imported: "Briefing eingefroren",
  briefing_revised: "Briefing überarbeitet",
  claim_anchor_revised: "Textstelle korrigiert",
  source_set_frozen: "Quellenbestand eingefroren",
  source_set_revised: "Quellenbestand revidiert",
  batch_run_started: "Erfassungslauf gestartet",
  batch_run_completed: "Erfassungslauf beendet",
  verification_run_started: "KI-Prüfung gestartet",
  verification_run_completed: "KI-Prüfung beendet",
  relevance_run_started: "Relevanzprüfung gestartet",
  relevance_run_completed: "Relevanzprüfung beendet",
  config_changed: "Konfiguration geändert",
  reference_scan_started: "Referenz-Scan gestartet",
  reference_scan_completed: "Referenz-Scan beendet",
  research_run_started: "Erste Recherche gestartet",
  research_run_completed: "Erste Recherche beendet",
  source_capture_failed: "Quellenerfassung fehlgeschlagen",
  source_capture_dismissed: "Erfassungsversuch verworfen",
  source_identity_corrected: "Quellenkennung korrigiert",
  source_repair_action: "Automatische Reparatur",
  source_repair_action_dismissed: "Reparaturvorschlag verworfen",
};

/** Human-readable status for a chain-error message, German where known. */
function statusLabel(status: string): string {
  return STATUS_LABELS[status as ClaimStatus] ?? status;
}

/**
 * A chain-verification failure as one German sentence saying what broke and,
 * where it points at tampering, that the register was changed after the fact
 * — instead of a raw JSON dump of the error variant.
 */
function describeChainError(
  error: ChainVerificationResult["errors"][number],
): string {
  switch (error.type) {
    case "empty_chain":
      return "Die Kette ist leer – es gibt keine verketteten Einträge.";
    case "missing_seq_start":
      return `Die Kette beginnt nicht bei Eintrag 1 (erster Eintrag: ${error.firstSeq}).`;
    case "duplicate_seq":
      return `Eintrag ${error.seq} kommt mehrfach vor.`;
    case "gap":
      return `Lücke in der Kette: erwartet wurde Eintrag ${error.expectedSeq}, gefunden ${error.foundSeq}.`;
    case "prev_hash_mismatch":
      return `Eintrag ${error.seq} verweist nicht auf den Hash seines Vorgängers – die Kette wurde nachträglich verändert.`;
    case "hash_mismatch":
      return `Der Inhalt von Eintrag ${error.seq} passt nicht zu seinem Hash – der Eintrag wurde nachträglich verändert.`;
    case "status_mismatch":
      return `Aussage ${error.claimId} trägt den Status „${statusLabel(
        error.status,
      )}", die verkettete Historie endet aber bei „${statusLabel(
        error.lastHistoryStatus,
      )}".`;
    case "state_root_mismatch":
      return `Der Inhaltszustand (Eintrag ${error.seq}) weicht vom festgeschriebenen Prüfwert ab – Aussagen, Belege, Quellen oder Konfiguration wurden seit dem letzten Schreiben verändert.`;
  }
}

export default async function HistoryPage(
  props: PageProps<"/projects/[id]/history">,
) {
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const claimFilter =
    typeof searchParams.claim === "string" ? searchParams.claim : undefined;
  const register = await loadProjectOrNotFound(() => readProject(id));
  const verification = await getChainVerification(id);
  const timeline = buildTimeline(register, claimFilter);

  return (
    <div className="space-y-6">
      <SubpageHeader projectId={id} title="Verlauf" current="history" />

      <div
        className={`rounded-md border p-4 text-sm ${
          verification.ok
            ? "border-green-200 bg-green-50 text-green-800"
            : "border-red-200 bg-red-50 text-red-800"
        }`}
      >
        <p className="font-medium">
          {verification.ok
            ? "Kettenintegrität geprüft – die Historie ist lückenlos verkettet."
            : "Kettenintegrität GEBROCHEN"}
        </p>
        {!verification.ok ? (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {verification.errors.map((error, index) => (
              <li key={index}>{describeChainError(error)}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">Ansicht:</span>
        <Link
          href={`/projects/${id}/history`}
          className={`rounded-full px-2 py-0.5 ${
            claimFilter
              ? "bg-slate-100 text-slate-600 hover:bg-slate-200"
              : "bg-slate-900 text-white"
          }`}
        >
          Gesamtes Projekt
        </Link>
        {register.claims.map((claim) => (
          <Link
            key={claim.id}
            href={`/projects/${id}/history?claim=${claim.id}`}
            className={`rounded-full px-2 py-0.5 font-mono ${
              claimFilter === claim.id
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {claim.id}
          </Link>
        ))}
      </div>

      <ol className="space-y-2">
        {timeline.map((item) => (
          <li
            key={item.entry.seq}
            className="rounded-md border border-slate-200 bg-white p-4 text-sm"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="font-mono">#{item.entry.seq}</span>
              <span>{formatTimestamp(item.entry.at)}</span>
              <span className="font-mono">{item.entry.actor}</span>
              {item.kind === "claim" ? (
                <Link
                  href={`/projects/${id}/history?claim=${item.claimId}`}
                  className="font-mono text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
                >
                  {item.claimId}
                </Link>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5">
                  Projekt
                </span>
              )}
            </div>

            <p className="mt-1 font-medium text-slate-800">
              {item.kind === "claim"
                ? `${
                    item.entry.from_status
                      ? STATUS_LABELS[item.entry.from_status]
                      : "erzeugt"
                  } → ${STATUS_LABELS[item.entry.to_status]}`
                : (EVENT_LABELS[item.entry.event] ?? item.entry.event)}
              {item.kind === "claim" && item.entry.routing ? (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-800">
                  {ROUTING_LABELS[item.entry.routing]}
                </span>
              ) : null}
            </p>

            <p className="mt-1 text-xs text-slate-600">{item.entry.reason}</p>

            {item.kind === "claim" && item.entry.decision ? (
              <p className="mt-1 text-xs text-slate-600">
                <span className="font-medium text-slate-500">
                  Entscheidung:{" "}
                </span>
                {item.entry.decision.categories.length === 0
                  ? "bestätigt"
                  : item.entry.decision.categories
                      .map((category) => COMPLAINT_CATEGORY_LABELS[category])
                      .join(", ")}
                {" · "}
                {item.entry.decision.duration_s} s
              </p>
            ) : null}

            {item.kind === "claim" && item.entry.revision ? (
              <div className="mt-2 rounded-md border border-slate-100 bg-slate-50 p-2 text-xs">
                <p className="text-slate-500">
                  Vorfassung: „{item.entry.revision.previous_text}“
                </p>
                <p className="mt-1 text-slate-700">
                  Neufassung: „{item.entry.revision.new_text}“
                </p>
              </div>
            ) : null}

            {item.kind === "project" && item.entry.config_change ? (
              <details className="mt-2 rounded-md border border-slate-100 bg-slate-50 p-2 text-xs">
                <summary className="cursor-pointer text-slate-500">
                  Konfiguration vorher/nachher (vollständig)
                </summary>
                <pre className="mt-1 overflow-x-auto text-slate-700">
                  {JSON.stringify(item.entry.config_change, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

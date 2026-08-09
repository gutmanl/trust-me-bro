"use client";

import type { Claim, Evidence } from "@/lib/pipeline";
import {
  CALIBRATION_LABELS,
  RELATION_LABELS,
  SOURCE_TYPE_LABELS,
  STATUS_LABELS,
  statusBadgeClassName,
  SUPPORT_LABELS,
} from "../../status-labels";
import type { EvidenceDisplay } from "@/lib/pipeline";
import { ComplaintDialog } from "./ComplaintDialog";
import { RepairPanel } from "./RepairPanel";

/**
 * Evidence detail panel (TMB-34): Leitsatz, source, Fundstelle and verbatim
 * excerpt side by side — the empirically best-supported design element. The
 * automatic pre-check (judgments, support degree, calibration) is
 * deliberately SUBORDINATE to the excerpt: collapsed below it, expanded only
 * on divergence, because LLM explanations invite unwarranted deference.
 */
export function ClaimPanel({
  projectId,
  claim,
  selectedEvidenceId,
  evidenceNumbers,
  evidenceDisplay,
  currentSeconds,
}: {
  projectId: string;
  claim: Claim | null;
  selectedEvidenceId: string | null;
  evidenceNumbers: Record<string, number>;
  evidenceDisplay: Record<string, EvidenceDisplay>;
  currentSeconds: () => number;
}) {
  if (!claim) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
        Claim oder Beleg im Briefing auswählen, um Details zu sehen.
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-xs text-slate-500">{claim.id}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusBadgeClassName(claim.status)}`}
        >
          {STATUS_LABELS[claim.status]}
        </span>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Leitsatz (Claim)
        </h3>
        <p className="mt-1 text-sm text-slate-800">{claim.text}</p>
      </div>

      {claim.evidence.length === 0 ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Ohne Fundstelle extrahiert – dieser Claim hat keinen Beleg.
        </p>
      ) : (
        claim.evidence.map((evidence) => (
          <EvidenceCard
            key={evidence.id}
            evidence={evidence}
            number={evidenceNumbers[`${claim.id}/${evidence.id}`]}
            display={evidenceDisplay[`${claim.id}/${evidence.id}`]}
            highlighted={evidence.id === selectedEvidenceId}
          />
        ))
      )}

      {claim.support_degree || claim.calibration_result ? (
        <details className="rounded-md border border-slate-200">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
            Automatische Vorprüfung des Claims
          </summary>
          <dl className="space-y-1 px-3 pb-3 text-xs text-slate-700">
            {claim.support_degree ? (
              <div>
                <dt className="inline text-slate-500">Unterstützungsgrad: </dt>
                <dd className="inline">
                  {SUPPORT_LABELS[claim.support_degree]}
                </dd>
              </div>
            ) : null}
            {claim.calibration_result ? (
              <div>
                <dt className="inline text-slate-500">
                  Kalibrierung (Rubrik):{" "}
                </dt>
                <dd className="inline">
                  {CALIBRATION_LABELS[claim.calibration_result]}
                </dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}

      <p className="text-xs text-slate-400">{claim.history.at(-1)?.reason}</p>

      {claim.status === "pending_adjudication" ? (
        <ComplaintDialog
          projectId={projectId}
          claim={claim}
          currentSeconds={currentSeconds}
        />
      ) : null}

      {claim.status === "contested" ? (
        <RepairPanel projectId={projectId} claim={claim} />
      ) : null}

      {claim.status === "revised" ? (
        <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Überarbeitet – die Neufassung durchläuft die betroffenen Prüfstufen im
          nächsten Prüflauf.
        </p>
      ) : null}
    </div>
  );
}

function EvidenceCard({
  evidence,
  number,
  display,
  highlighted,
}: {
  evidence: Evidence;
  number: number | undefined;
  display: EvidenceDisplay | undefined;
  highlighted: boolean;
}) {
  const sourceTypeLabel =
    display &&
    SOURCE_TYPE_LABELS[display.sourceType as keyof typeof SOURCE_TYPE_LABELS];
  return (
    <div
      className={`rounded-md border p-3 ${
        highlighted ? "border-blue-300 bg-blue-50/40" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-700">
          {number !== undefined ? (
            <span className="mr-1 font-mono text-blue-700">[{number}]</span>
          ) : null}
          {display?.citation ?? evidence.source_id}
        </p>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {sourceTypeLabel ?? display?.sourceType}
        </span>
      </div>

      <p className="mt-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-500">Fundstelle: </span>
        {display?.locatorText || "ohne Angabe"}
        {display?.snapshotHref ? (
          <>
            {" · "}
            <a
              href={display.snapshotHref}
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 underline decoration-blue-300 hover:decoration-blue-600"
            >
              Im Snapshot öffnen
            </a>
          </>
        ) : null}
      </p>

      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold text-slate-500">
          Wortlaut aus der Quelle
        </p>
        <p className="mt-1 text-sm text-slate-800">
          „{evidence.verbatim_excerpt}“
        </p>
        {evidence.existence_check ? (
          <p
            className={`mt-2 text-xs ${
              evidence.existence_check.status === "passed"
                ? "text-green-700"
                : "text-red-700"
            }`}
          >
            Existenzprüfung:{" "}
            {evidence.existence_check.status === "passed"
              ? "bestanden"
              : "nicht bestanden"}
          </p>
        ) : null}
      </div>

      {evidence.judgments.length > 0 ? (
        <details className="mt-2" open={display?.divergent}>
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            Automatische Vorprüfung ({evidence.judgments.length} Urteil(e))
            {display?.divergent ? (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-red-800">
                Divergenz
              </span>
            ) : evidence.relation_type ? (
              <span className="ml-2 text-slate-500">
                Relation: {RELATION_LABELS[evidence.relation_type]}
              </span>
            ) : null}
          </summary>
          <ul className="mt-2 space-y-2">
            {evidence.judgments.map((judgment, index) => (
              <li
                key={`${judgment.backend}-${judgment.at}-${index}`}
                className="rounded-md border border-slate-200 p-2 text-xs"
              >
                <p className="font-medium text-slate-700">
                  {RELATION_LABELS[judgment.relation_type]} ·{" "}
                  {Math.round(judgment.confidence * 100)} %
                  <span className="ml-2 font-normal text-slate-500">
                    {judgment.backend} ({judgment.model})
                  </span>
                </p>
                <p className="mt-1 text-slate-600">{judgment.reasoning}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

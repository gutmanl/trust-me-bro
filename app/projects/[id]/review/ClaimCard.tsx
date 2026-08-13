"use client";

import type { ClaimMarkerVM, Evidence, EvidenceDisplay } from "@/lib/pipeline";
import type { RoutingReason } from "@/lib/register";
import {
  isCaveatParagraph,
  splitReasoningParagraphs,
} from "../../reasoning-paragraphs";
import {
  CALIBRATION_LABELS,
  formatModel,
  formatTimestamp,
  RELATION_LABELS,
  SOURCE_TYPE_LABELS,
  STATUS_LABELS,
  statusBadgeClassName,
  SUPPORT_LABELS,
} from "../../status-labels";
import {
  deriveVerdict,
  relationBadgeClassName,
  verdictBadgeClassName,
} from "../../verdict-labels";
import { ComplaintDialog } from "./ComplaintDialog";
import { RepairPanel, type ParagraphOption } from "./RepairPanel";
import { ROUTING_LABELS } from "./routing-labels";

/**
 * A claim as a margin card beside its anchor paragraph. Collapsed: identity,
 * status, routing reason and the evidence numbers. Selected, it expands in
 * place to the full detail (TMB-34): Leitsatz, source, Fundstelle and
 * verbatim excerpt. The automatic pre-check (judgments, support degree,
 * calibration) is deliberately SUBORDINATE to the excerpt: collapsed below
 * it, expanded only on divergence, because LLM explanations invite
 * unwarranted deference.
 */
export function ClaimCard({
  projectId,
  marker,
  routing,
  queuedAt,
  selected,
  linked,
  selectedEvidenceId,
  evidenceDisplay,
  currentSeconds,
  onSelect,
  showAnchor = false,
  paragraphs,
  anchoredParagraph,
}: {
  projectId: string;
  marker: ClaimMarkerVM;
  routing: RoutingReason | null;
  queuedAt?: string;
  selected: boolean;
  linked: boolean;
  selectedEvidenceId: string | null;
  evidenceDisplay: Record<string, EvidenceDisplay>;
  currentSeconds: () => number;
  onSelect: (claimId: string, evidenceId?: string) => void;
  showAnchor?: boolean;
  /** The briefing's paragraphs, passed through to the repair panel's anchor
   * picker. */
  paragraphs?: ParagraphOption[];
  /** The paragraph this card sits beside, seeding the passage editor. */
  anchoredParagraph?: ParagraphOption;
}) {
  const { claim } = marker;
  // The repair panel is reachable for a contested claim (all three repairs)
  // and for a claim whose anchor drifted (the two anchor repairs) — a
  // misplaced anchor is a defect in any status, not a verification verdict.
  const showRepair = claim.status === "contested" || marker.anchorDrifted;
  // Combined pre-check verdict (verdict redesign): one phrase from
  // support × calibration; divergence — where both enums stay unset by
  // construction — is detected from the evidence-level judgments.
  const divergent = claim.evidence.some(
    (evidence) => evidenceDisplay[`${claim.id}/${evidence.id}`]?.divergent,
  );
  const verdict = deriveVerdict(
    claim.support_degree,
    claim.calibration_result,
    divergent,
  );
  return (
    <div
      id={`claim-card-${claim.id}`}
      className={`rounded-md border border-l-2 bg-white transition-colors ${
        selected
          ? "border-blue-300 border-l-blue-500"
          : linked
            ? "border-blue-200 border-l-blue-400"
            : "border-slate-200 border-l-slate-300"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(claim.id)}
        aria-expanded={selected}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-xs text-slate-500">{claim.id}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClassName(claim.status)}`}
        >
          {STATUS_LABELS[claim.status]}
        </span>
        {verdict ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${verdictBadgeClassName(verdict.severity)}`}
          >
            {verdict.phrase}
          </span>
        ) : null}
        {routing ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
            {ROUTING_LABELS[routing]}
          </span>
        ) : null}
        {marker.anchorDrifted ? (
          // The explanation is visually-hidden text rather than a `title`:
          // a tooltip only exists for a pointer that hovers it, and this is
          // the badge that tells a reviewer the position beside the text is
          // a guess.
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-800">
            Anker verschoben
            <span className="sr-only">
              {" "}
              – der zitierte Wortlaut steht nicht mehr an der Stelle, auf die
              der Anker zeigt; die Position ist nur noch geschätzt.
            </span>
          </span>
        ) : null}
        <span className="ml-auto text-xs text-slate-400">
          {selected ? "▴" : "▾"}
        </span>
      </button>

      {selected ? (
        <div className="space-y-4 border-t border-slate-100 px-3 pt-3 pb-3">
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Leitsatz (Claim)
            </h3>
            <p className="mt-1 text-sm text-slate-800">{claim.text}</p>
          </div>

          {claim.evidence.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Ohne Fundstelle extrahiert – dieser Claim hat keinen Beleg.
            </p>
          ) : (
            claim.evidence.map((evidence, index) => (
              <EvidenceCard
                key={evidence.id}
                evidence={evidence}
                number={marker.evidenceNumbers[index]}
                display={evidenceDisplay[`${claim.id}/${evidence.id}`]}
                highlighted={evidence.id === selectedEvidenceId}
              />
            ))
          )}

          {claim.support_degree || claim.calibration_result ? (
            <details className="rounded-md border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
                Automatische Vorprüfung des Claims
                {verdict ? (
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 ${verdictBadgeClassName(verdict.severity)}`}
                  >
                    {verdict.phrase}
                  </span>
                ) : null}
              </summary>
              <dl className="space-y-1 px-3 pb-3 text-xs text-slate-700">
                {claim.support_degree ? (
                  <div>
                    <dt className="inline text-slate-500">
                      Unterstützungsgrad:{" "}
                    </dt>
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
              {claim.calibration_reasoning ? (
                <div className="space-y-1 border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                  {splitReasoningParagraphs(claim.calibration_reasoning).map(
                    (paragraph, index) => (
                      <p
                        key={index}
                        className={
                          isCaveatParagraph(paragraph)
                            ? "border-l-2 border-amber-300 pl-2 text-amber-800"
                            : undefined
                        }
                      >
                        {paragraph}
                      </p>
                    ),
                  )}
                </div>
              ) : null}
            </details>
          ) : null}

          <p className="text-xs break-words text-slate-400">
            {queuedAt
              ? `In der Warteschlange seit ${formatTimestamp(queuedAt)}. `
              : ""}
            {claim.history.at(-1)?.reason}
          </p>

          {claim.status === "pending_adjudication" ? (
            <ComplaintDialog
              projectId={projectId}
              claim={claim}
              currentSeconds={currentSeconds}
            />
          ) : null}

          {showRepair ? (
            <RepairPanel
              projectId={projectId}
              claim={claim}
              paragraphs={paragraphs}
              anchoredParagraph={anchoredParagraph}
            />
          ) : null}

          {claim.status === "revised" ? (
            <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              Überarbeitet – die Neufassung durchläuft die betroffenen
              Prüfstufen im nächsten Prüflauf.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="px-3 pb-2">
          <p className="line-clamp-2 text-xs text-slate-600">{claim.text}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {claim.evidence.length === 0 ? (
              <span className="text-xs text-slate-400">ohne Beleg</span>
            ) : (
              marker.evidenceNumbers.map((number, index) => (
                <button
                  key={number}
                  type="button"
                  onClick={() => onSelect(claim.id, claim.evidence[index]?.id)}
                  className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs text-blue-700 hover:bg-blue-100"
                >
                  [{number}]
                </button>
              ))
            )}
            {showAnchor ? (
              <span className="text-xs text-slate-400">
                Anker: {claim.briefing_anchor}
              </span>
            ) : null}
          </div>
        </div>
      )}
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
              <span
                className={`ml-2 rounded-full px-2 py-0.5 ${relationBadgeClassName(evidence.relation_type)}`}
              >
                {RELATION_LABELS[evidence.relation_type]}
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
                  <span
                    className={`rounded-full px-2 py-0.5 ${relationBadgeClassName(judgment.relation_type)}`}
                  >
                    {RELATION_LABELS[judgment.relation_type]}
                  </span>{" "}
                  · {Math.round(judgment.confidence * 100)} %
                  <span className="ml-2 font-normal text-slate-500">
                    {judgment.backend} ({formatModel(judgment.model)})
                  </span>
                </p>
                <div className="mt-1 space-y-1 text-slate-600">
                  {splitReasoningParagraphs(judgment.reasoning).map(
                    (paragraph, paragraphIndex) => (
                      <p
                        key={paragraphIndex}
                        className={
                          isCaveatParagraph(paragraph)
                            ? "border-l-2 border-amber-300 pl-2 text-amber-800"
                            : undefined
                        }
                      >
                        {paragraph}
                      </p>
                    ),
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

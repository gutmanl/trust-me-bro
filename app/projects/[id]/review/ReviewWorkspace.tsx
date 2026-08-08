"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { SuccessBanner } from "@/app/components/ui";
import { useJobStream } from "@/app/lib/useJobStream";
import type { BriefingViewModel, ClaimsRegister } from "@/lib/pipeline";
import { BriefingPane } from "./BriefingPane";
import { ClaimPanel } from "./ClaimPanel";
import type { EvidenceDisplay } from "./evidence-display";

/**
 * Client shell of the review workspace: owns the claim selection, keeps the
 * briefing and panel in sync, and refreshes the server-rendered data while
 * a verification run streams progress (TMB-33: status markers update
 * without a reload). Durable truth stays in the register — this component
 * never mutates anything itself.
 */
export function ReviewWorkspace({
  projectId,
  register,
  briefing,
  evidenceDisplay,
  verificationActive,
}: {
  projectId: string;
  register: ClaimsRegister;
  briefing: BriefingViewModel;
  evidenceDisplay: Record<string, EvidenceDisplay>;
  verificationActive: boolean;
}) {
  const router = useRouter();
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
    null,
  );

  // Live refresh during a verification run: every finished claim updates the
  // durable register, so re-render the server components per item instead of
  // waiting for the run to end.
  useJobStream({
    streamUrl: `/api/projects/${projectId}/verification/stream`,
    active: verificationActive,
    describe: () => null,
    onEvent: (event) => {
      if (event.type === "item_completed") {
        router.refresh();
      }
    },
    onDone: () => {
      router.refresh();
    },
  });

  const selectClaim = (claimId: string, evidenceId?: string): void => {
    setSelectedClaimId(claimId);
    setSelectedEvidenceId(evidenceId ?? null);
  };

  const selectedClaim =
    register.claims.find((claim) => claim.id === selectedClaimId) ?? null;

  return (
    <div className="space-y-4">
      {briefing.isGeprueft ? (
        <SuccessBanner>
          Briefing geprüft – kein Claim zur Adjudikation offen
          {briefing.unconfirmedCount > 0
            ? ` (${briefing.unconfirmedCount} Claim(s) nicht bestätigt)`
            : ""}
          .
        </SuccessBanner>
      ) : (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          In Prüfung – {briefing.openCount} Claim(s) zur Adjudikation offen.
        </p>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <section className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            Briefing mit Belegen
          </h2>
          <BriefingPane
            briefing={briefing}
            selectedClaimId={selectedClaimId}
            onSelect={selectClaim}
          />
        </section>

        <aside className="w-full lg:w-[26rem] lg:shrink-0">
          <ClaimPanel
            claim={selectedClaim}
            selectedEvidenceId={selectedEvidenceId}
            evidenceNumbers={briefing.evidenceNumbers}
            evidenceDisplay={evidenceDisplay}
          />
        </aside>
      </div>
    </div>
  );
}

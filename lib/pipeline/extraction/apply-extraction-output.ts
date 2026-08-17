import type { ExtractedEvidence, ExtractionOutput } from "../../adapters";
import {
  containsNormalized,
  isAtomicClaimText,
  normalizeForSearch,
} from "../../register";
import type {
  Claim,
  ClaimStatus,
  Evidence,
  RegisterTransaction,
} from "../../register";
import { evidenceIdAt, nextClaimId } from "../ids";
import { RECHECK_STATUSES } from "../verification/recheck-statuses";
import { EXTRACTION_ACTOR, EXTRACTION_COMPLETED_PREFIX } from "./derive-state";

const ACTOR = EXTRACTION_ACTOR;

/**
 * Anchor of a claim whose `anchor_quote` occurs nowhere in the briefing.
 * Deliberately NOT a valid `p<N>`: the briefing view model resolves such a
 * claim neither by hint nor by quote and therefore lists it in its
 * `unanchored` bucket, where a human can repair the anchor — far better than
 * pinning the claim to a guessed paragraph.
 */
const SENTINEL_ANCHOR = "p0";

/** The additional-evidence channel carries no claim type; a fallback claim
 * built from an unresolvable `claim_text_match` gets the least specific one
 * and a reason that marks it for human correction. */
const FALLBACK_CLAIM_TYPE = "effectiveness_statement" as const;

export interface ApplyMeta {
  backendId: string;
  model: string;
  runId: string;
  /** The source this pass was scoped to; null for the unevidenced sweep. */
  targetSourceId: string | null;
}

export interface ApplySummary {
  created: number;
  escalated: number;
  /** Evidence entries attached to claims that already existed. */
  merged: number;
  /** Ids of the claims this pass pulled into recheck_required. */
  recheckPulled: string[];
  /** Evidence entries dropped because their source_id names no captured
   * source (extraction salvage): a hallucinated reference no longer
   * rejects the whole pass — the bad entry is filtered, counted here and
   * named in the pass's closing event, while everything legitimate
   * commits. */
  droppedUnknownSourceEvidence: number;
}

/** Mutable bookkeeping per known claim, so one pass can attach several
 * evidence entries to the same claim and still mint unique evidence ids. */
interface KnownClaim {
  id: string;
  status: ClaimStatus;
  /** `(source_id, normalized excerpt)` pairs already on the claim. */
  evidencePairs: Set<string>;
  /** Index the next minted evidence id is derived from. */
  nextEvidenceIndex: number;
  /** Sources whose evidence this pass actually added — empty means nothing
   * changed for the claim and it is left alone. */
  addedSourceIds: string[];
}

const pairKey = (evidence: {
  source_id: string;
  verbatim_excerpt: string;
}): string =>
  `${evidence.source_id}\u0000${normalizeForSearch(evidence.verbatim_excerpt)}`;

function trackClaim(claim: Claim): KnownClaim {
  let highest = 0;
  for (const evidence of claim.evidence) {
    const match = /^ev_(\d+)$/.exec(evidence.id);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return {
    id: claim.id,
    status: claim.status,
    evidencePairs: new Set(claim.evidence.map(pairKey)),
    // evidenceIdAt is 0-based, so the highest existing number is exactly the
    // index of the next free id.
    nextEvidenceIndex: highest,
    addedSourceIds: [],
  };
}

/** First paragraph containing the quote wins; nothing found → the sentinel. */
function resolveAnchor(quote: string, briefingParagraphs: string[]): string {
  const index = briefingParagraphs.findIndex((paragraph) =>
    containsNormalized(paragraph, quote),
  );
  return index === -1 ? SENTINEL_ANCHOR : `p${index + 1}`;
}

/**
 * Commits one extraction pass. Dedupe runs IN the transaction against fresh
 * claims: a candidate whose normalizeForSearch(text) equals an existing
 * non-discarded claim's normalized text is treated as additional evidence for
 * it instead of a new claim (evidence entries whose (source_id,
 * verbatim_excerpt) pair already exists are skipped). additional_evidence
 * entries resolve claim_text_match the same way; unresolvable matches become
 * new claims via the creation gate (never dropped). New evidence on a claim
 * in a settled status pulls it to recheck_required (TMB-44 edges, actor
 * system:extraction). anchor_quote → briefing_anchor is resolved here via
 * splitBriefingParagraphs + containsNormalized (hint-free scan; unresolvable
 * quote ⇒ briefing_anchor "p0" sentinel — invalid format lands the claim in
 * the unanchored bucket — and anchor_quote preserved for later repair).
 *
 * Why dedupe belongs inside the transaction: the LLM call happens on a
 * register snapshot read minutes earlier, and per-source passes are meant to
 * be run repeatedly and concurrently with human adjudication. Deduping
 * against that stale snapshot would let a claim committed in the meantime be
 * created a second time. `tx.listClaims()` under the write lock is the only
 * view that cannot go stale between the check and the write — the same
 * TOCTOU reasoning as the briefing revision's in-transaction re-anchor pass.
 */
export function applyExtractionOutput(
  tx: RegisterTransaction,
  output: ExtractionOutput,
  briefingParagraphs: string[],
  meta: ApplyMeta,
): ApplySummary {
  const now = new Date().toISOString();
  const scope = meta.targetSourceId
    ? `Quelle ${meta.targetSourceId}`
    : "Sweep nachweisloser Aussagen";

  const committed = tx.listClaims();
  const claimIds = committed.map((claim) => claim.id);
  const byNormalizedText = new Map<string, KnownClaim>();
  for (const claim of committed) {
    // A discarded claim is a settled negative: re-extraction of the same
    // wording starts a fresh claim rather than reviving the rejected one.
    if (claim.status === "discarded") {
      continue;
    }
    const key = normalizeForSearch(claim.text);
    if (!byNormalizedText.has(key)) {
      byNormalizedText.set(key, trackClaim(claim));
    }
  }

  let created = 0;
  let escalated = 0;
  let merged = 0;

  // Extraction salvage: an LLM-hallucinated source_id must not reject the
  // whole pass (the register's integrity check would, at commit). Filter
  // per evidence entry BEFORE anything reaches the transaction's writes —
  // a claim losing all its evidence this way falls through the ordinary
  // no-evidence gate to adjudication instead of vanishing with the batch.
  const knownSourceIds = new Set(tx.listSources().map((source) => source.id));
  let droppedUnknownSourceEvidence = 0;
  const droppedSourceIds = new Set<string>();
  const keepKnownSources = (
    entries: readonly ExtractedEvidence[],
  ): ExtractedEvidence[] => {
    const kept: ExtractedEvidence[] = [];
    for (const entry of entries) {
      if (knownSourceIds.has(entry.source_id)) {
        kept.push(entry);
      } else {
        droppedUnknownSourceEvidence += 1;
        droppedSourceIds.add(entry.source_id);
      }
    }
    return kept;
  };

  const attach = (known: KnownClaim, entry: ExtractedEvidence): void => {
    const key = pairKey(entry);
    if (known.evidencePairs.has(key)) {
      return;
    }
    known.evidencePairs.add(key);
    tx.addEvidence(known.id, {
      id: evidenceIdAt(known.nextEvidenceIndex),
      source_id: entry.source_id,
      locator: entry.locator,
      verbatim_excerpt: entry.verbatim_excerpt,
      judgments: [],
    });
    known.nextEvidenceIndex += 1;
    known.addedSourceIds.push(entry.source_id);
    merged += 1;
  };

  const create = (input: {
    text: string;
    claim_type: Claim["claim_type"];
    quote: string;
    evidence: readonly ExtractedEvidence[];
    reason: string;
  }): void => {
    const claimId = nextClaimId(claimIds);
    claimIds.push(claimId);
    const evidence: Evidence[] = input.evidence.map((entry, index) => ({
      id: evidenceIdAt(index),
      source_id: entry.source_id,
      locator: entry.locator,
      verbatim_excerpt: entry.verbatim_excerpt,
      judgments: [],
    }));
    const claim = tx.addClaim({
      claim: {
        id: claimId,
        text: input.text,
        claim_type: input.claim_type,
        briefing_anchor: resolveAnchor(input.quote, briefingParagraphs),
        anchor_quote: input.quote,
        provenance: {
          tool: meta.backendId,
          model: meta.model,
          extracted_at: now,
          search_path: `Erfassungslauf ${meta.runId}`,
        },
        evidence,
      },
      actor: ACTOR,
      reason: input.reason,
      at: now,
    });
    created += 1;
    if (claim.status === "pending_adjudication") {
      escalated += 1;
    }
    // Registered right away so a second candidate with the same wording —
    // in this very output — merges into it instead of duplicating it.
    byNormalizedText.set(normalizeForSearch(claim.text), trackClaim(claim));
  };

  for (const extracted of output.claims) {
    const evidence = keepKnownSources(extracted.evidence);
    const known = byNormalizedText.get(normalizeForSearch(extracted.text));
    if (known) {
      for (const entry of evidence) {
        attach(known, entry);
      }
      continue;
    }
    // The creation gate decides the status; the reason classifies the
    // routing for the history (unevidenced vs. bundled vs. filtered vs.
    // regular).
    const reason =
      evidence.length === 0
        ? extracted.evidence.length > 0
          ? "Alle Belege nannten unbekannte Quellen-Ids " +
            "(mutmaßlich halluzinierte Referenzen) und wurden verworfen – " +
            "unbelegte Aussage zur manuellen Überprüfung."
          : "Kein Beleg erfassbar – unbelegte Aussage zur manuellen Überprüfung."
        : isAtomicClaimText(extracted.text)
          ? `Aus dem Briefing erfasst (${scope}).`
          : "Erfassungsergebnis bündelt mehrere Aussagen – zur manuellen Überprüfung.";
    create({
      text: extracted.text,
      claim_type: extracted.claim_type,
      quote: extracted.anchor_quote,
      evidence,
      reason,
    });
  }

  for (const additional of output.additional_evidence) {
    if (!knownSourceIds.has(additional.evidence.source_id)) {
      // A stray finding whose ONLY evidence names an unknown source has
      // nothing verifiable to contribute — skip it entirely (counted and
      // named in the closing event) instead of minting an unbelegter
      // claim from a hallucinated reference.
      droppedUnknownSourceEvidence += 1;
      droppedSourceIds.add(additional.evidence.source_id);
      continue;
    }
    const known = byNormalizedText.get(
      normalizeForSearch(additional.claim_text_match),
    );
    if (known) {
      attach(known, additional.evidence);
      continue;
    }
    // Unresolvable reference: the finding is never dropped. It becomes a
    // claim of its own — typed neutrally, since the channel carries no claim
    // type — and the reason tells the reviewer where it came from. The quote
    // is the matched wording itself, which usually still anchors.
    create({
      text: additional.claim_text_match,
      claim_type: FALLBACK_CLAIM_TYPE,
      quote: additional.claim_text_match,
      evidence: [additional.evidence],
      reason:
        `Zusatzfundstelle ohne zuordenbare Aussage (${scope}) – ` +
        "als neue Aussage aufgenommen; Wortlaut und Aussagen-Typ prüfen.",
    });
  }

  const recheckPulled: string[] = [];
  for (const known of new Set(byNormalizedText.values())) {
    if (
      known.addedSourceIds.length === 0 ||
      !RECHECK_STATUSES.has(known.status)
    ) {
      continue;
    }
    const sources = [...new Set(known.addedSourceIds)].join(", ");
    tx.transitionClaim(known.id, {
      to: "recheck_required",
      actor: ACTOR,
      reason: `Neuer Beleg aus Quelle ${sources} – erneute Prüfung erforderlich.`,
      at: now,
    });
    recheckPulled.push(known.id);
  }

  tx.recordProjectEvent({
    event: "batch_run_completed",
    reason:
      `${EXTRACTION_COMPLETED_PREFIX} (${scope}, Lauf ${meta.runId}): ` +
      `${created} neue Aussage(n), davon ${escalated} zur manuellen Überprüfung; ` +
      `${merged} zusätzliche Beleg(e) an bestehenden Aussagen; ` +
      `${recheckPulled.length} Aussage(n) zur Nachprüfung.` +
      (droppedUnknownSourceEvidence > 0
        ? ` ${droppedUnknownSourceEvidence} Beleg(e) mit unbekannter ` +
          `Quellen-Id verworfen (${[...droppedSourceIds].join(", ")}).`
        : ""),
    actor: ACTOR,
    // Structured per-source attribution (source work items): absent for the
    // sweep, so per-row status never misreads a sweep as a source pass.
    ...(meta.targetSourceId !== null ? { source_id: meta.targetSourceId } : {}),
    at: now,
  });

  return {
    created,
    escalated,
    merged,
    recheckPulled,
    droppedUnknownSourceEvidence,
  };
}

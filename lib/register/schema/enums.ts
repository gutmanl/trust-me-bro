import { z } from "zod";

/**
 * Closed enumerations of the claims.json field schema. Values are
 * ASCII-transliterated forms of the German terms from the concept chapter
 * (file format appendix: the mapping is one-to-one and normative).
 */

/** Claim lifecycle per the status model table in the concept chapter. */
export const ClaimStatus = z.enum([
  "erfasst",
  "existenzgeprueft",
  "vorgeprueft",
  "automatisch_bestaetigt",
  "zur_adjudikation",
  "bestaetigt",
  "beanstandet",
  "ueberarbeitet",
  "verworfen",
]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Claim classification steering the evidence rubric (SE-Evidenz-Rubrik). */
export const ClaimType = z.enum([
  "quantitativer_einzelbefund",
  "vergleichende_aussage",
  "wirksamkeitsaussage",
  "empfehlung",
]);
export type ClaimType = z.infer<typeof ClaimType>;

/**
 * Four-level support degree per SemanticCite; kept in English as in the
 * originating scheme (and the appendix example).
 */
export const SupportDegree = z.enum([
  "supported",
  "partially_supported",
  "unsupported",
  "uncertain",
]);
export type SupportDegree = z.infer<typeof SupportDegree>;

/** Relation of one piece of evidence to its claim (Artefaktmodell). */
export const RelationType = z.enum([
  "stuetzt",
  "stuetzt_teilweise",
  "widerspricht",
  "nicht_einschlaegig",
]);
export type RelationType = z.infer<typeof RelationType>;

/** Source typing per the MLR-informed rubric weighting (Artefaktmodell). */
export const SourceType = z.enum([
  "begutachtete_publikation",
  "preprint",
  "grauliteratur",
  "herstellerdokumentation",
]);
export type SourceType = z.infer<typeof SourceType>;

/** Result of the deterministic existence check (stage 1). */
export const ExistenceCheckStatus = z.enum(["bestanden", "nicht_bestanden"]);
export type ExistenceCheckStatus = z.infer<typeof ExistenceCheckStatus>;

/**
 * Complaint categories of the adjudication dialog, translating the error
 * taxonomy into reviewer language (concept chapter, Adjudikations-Interface);
 * "sonstiges" requires a substantive reason on the history entry.
 */
export const ComplaintCategory = z.enum([
  "wortlaut_nicht_in_quelle",
  "leitsatz_nicht_herleitbar",
  "aus_dem_kontext_gerissen",
  "quelle_nicht_vertrauenswuerdig",
  "quelle_veraltet",
  "sonstiges",
]);
export type ComplaintCategory = z.infer<typeof ComplaintCategory>;

/** Project-wide events without a claim reference (file format appendix). */
export const ProjectEventType = z.enum([
  "project_created",
  "briefing_imported",
  "source_set_frozen",
  "source_set_revised",
  "batch_run_started",
  "batch_run_completed",
]);
export type ProjectEventType = z.infer<typeof ProjectEventType>;

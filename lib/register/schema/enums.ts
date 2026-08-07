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
 * taxonomy into reviewer language (concept chapter, Adjudikations-Interface).
 * The mandatory free-text justification for "sonstiges" is enforced by the
 * adjudication dialog (later epic); the register only requires the generic
 * non-empty reason.
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

/**
 * Outcome of the stage-3 calibration check (SE-Evidenz-Rubrik): is the
 * strength of the formulation licensed by the evidence? The concept chapter
 * names a rubric complaint as a routing condition to adjudication; the field
 * schema of the format appendix left the outcome unmodeled, so this enum is
 * a documented extension introduced with the register core.
 */
export const CalibrationResult = z.enum([
  "lizenziert",
  "abschwaechen",
  "zur_adjudikation",
]);
export type CalibrationResult = z.infer<typeof CalibrationResult>;

/**
 * Project-wide events without a claim reference (file format appendix).
 * `verification_run_started`/`verification_run_completed` bracket a
 * TMB-4 verification run; the extraction bracket keeps its own pair so each
 * feature's run state derives from its own events structurally instead of
 * sniffing reason strings (documented extension, additive).
 */
export const ProjectEventType = z.enum([
  "project_created",
  "briefing_imported",
  "source_set_frozen",
  "source_set_revised",
  "batch_run_started",
  "batch_run_completed",
  "verification_run_started",
  "verification_run_completed",
]);
export type ProjectEventType = z.infer<typeof ProjectEventType>;

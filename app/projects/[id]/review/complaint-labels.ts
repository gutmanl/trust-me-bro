import type { ComplaintCategory } from "@/lib/register";

/** The complaint categories in examiner language (TMB-35): the error
 * taxonomy translated so no verification vocabulary is needed to file a
 * precise complaint. Order = display order of the dialog. */
export const COMPLAINT_CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  source_not_trustworthy: "Quelle nicht vertrauenswürdig",
  source_outdated: "Quelle veraltet",
  wording_not_in_source: "Wortlaut so nicht in Quelle enthalten",
  claim_not_derivable: "Kernaussage nicht aus Wortlaut herleitbar",
  taken_out_of_context: "Aus dem Kontext gerissen",
  other: "Sonstiges",
};

export const COMPLAINT_CATEGORY_ORDER: ComplaintCategory[] = [
  "source_not_trustworthy",
  "source_outdated",
  "wording_not_in_source",
  "claim_not_derivable",
  "taken_out_of_context",
  "other",
];

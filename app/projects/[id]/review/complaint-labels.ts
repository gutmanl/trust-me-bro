import type { ComplaintCategory } from "@/lib/register";

/** The complaint categories in examiner language (TMB-35): the error
 * taxonomy translated so no verification vocabulary is needed to file a
 * precise complaint. Order = display order of the dialog. */
export const COMPLAINT_CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  quelle_nicht_vertrauenswuerdig: "Quelle nicht vertrauenswürdig",
  quelle_veraltet: "Quelle veraltet",
  wortlaut_nicht_in_quelle: "Wortlaut so nicht in Quelle enthalten",
  leitsatz_nicht_herleitbar: "Leitsatz nicht aus Wortlaut herleitbar",
  aus_dem_kontext_gerissen: "Aus dem Kontext gerissen",
  sonstiges: "Sonstiges",
};

export const COMPLAINT_CATEGORY_ORDER: ComplaintCategory[] = [
  "quelle_nicht_vertrauenswuerdig",
  "quelle_veraltet",
  "wortlaut_nicht_in_quelle",
  "leitsatz_nicht_herleitbar",
  "aus_dem_kontext_gerissen",
  "sonstiges",
];

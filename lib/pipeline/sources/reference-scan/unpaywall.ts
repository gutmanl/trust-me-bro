import type { HttpFetcher } from "../fetch-port";

/**
 * Unpaywall client of the reference scan's document-url derivation
 * (reference auto-import, Task 3b): the last step of the fixed derivation
 * order (arXiv PDF > Crossref's own PDF link > Unpaywall), consulted only
 * when a DOI is present and neither earlier step found a PDF.
 *
 * The e-mail is Unpaywall's required per-request identification (its API
 * contract, not optional query sugar) — sourced exclusively from the
 * identity layer (lib/identity's getUnpaywallEmail/getUnpaywallSetting),
 * never read here. `email === null` means "not configured": the step is
 * skipped ENTIRELY, no network call at all, mirroring the no-CLI graceful
 * degradation elsewhere in the pipeline — never an error.
 *
 * Never throws otherwise either: a network error, a non-200 response, or an
 * answer with no open-access location all resolve to `undefined`, same as
 * "Unpaywall had nothing" — the caller (derive-document-url.ts) treats that
 * exactly like every other failed derivation step, simply no document_url.
 */
export async function fetchUnpaywallPdfUrl(
  doi: string,
  email: string | null,
  fetcher: HttpFetcher,
): Promise<string | undefined> {
  if (!email) {
    return undefined;
  }
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  let resource;
  try {
    resource = await fetcher.fetch(url, { accept: "application/json" });
  } catch {
    return undefined;
  }
  if (resource.status !== 200) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resource.body.toString("utf8"));
  } catch {
    return undefined;
  }
  const data = parsed as Record<string, unknown> | null;

  const best = data?.best_oa_location as
    Record<string, unknown> | null | undefined;
  const bestPdfUrl = best?.url_for_pdf;
  if (typeof bestPdfUrl === "string" && bestPdfUrl.length > 0) {
    return bestPdfUrl;
  }

  const locations = data?.oa_locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const pdfUrl = (location as Record<string, unknown> | null)?.url_for_pdf;
      if (typeof pdfUrl === "string" && pdfUrl.length > 0) {
        return pdfUrl;
      }
    }
  }

  return undefined;
}

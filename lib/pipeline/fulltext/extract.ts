import { FullTextExtractionError, TextExtractionTimeoutError } from "../errors";
import { extractHtmlText } from "./extract-html";
import { extractPdfText } from "./extract-pdf";

/**
 * Extracted full text of a source snapshot (TMB-24): the text stage 1's
 * deterministic Wortlaut-Verifikation and the agent CLIs read. PDF via
 * unpdf, HTML via Readability + linkedom, plain-text formats pass through.
 * Every failure surfaces as FullTextExtractionError — the capture records
 * it at the source entry instead of failing the capture.
 */
export async function extractFullText(
  content: Buffer,
  ext: string,
): Promise<string> {
  let text: string;
  try {
    switch (ext) {
      case "pdf":
        text = await extractPdfText(content);
        break;
      case "html":
        text = extractHtmlText(content);
        break;
      case "txt":
      case "md":
        text = content.toString("utf8");
        break;
      default:
        throw new FullTextExtractionError(
          `Format ".${ext}" wird für die Volltextextraktion nicht unterstützt.`,
        );
    }
  } catch (error) {
    // A parse TIMEOUT is fatal (fails the capture item); a parse FAILURE is
    // soft (recorded, source still captured). Let both propagate as their own
    // type so extractTextOrError can tell them apart.
    if (
      error instanceof FullTextExtractionError ||
      error instanceof TextExtractionTimeoutError
    ) {
      throw error;
    }
    throw new FullTextExtractionError(
      "Volltextextraktion fehlgeschlagen (Dokument nicht lesbar).",
      { cause: error },
    );
  }
  if (text.trim().length === 0) {
    throw new FullTextExtractionError(
      "Volltextextraktion ergab keinen Text (z. B. gescanntes PDF ohne Textebene).",
    );
  }
  return text;
}

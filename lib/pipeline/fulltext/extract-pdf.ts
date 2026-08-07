import { extractText, getDocumentProxy } from "unpdf";

/**
 * PDF → text via unpdf (serverless build of pdf.js). Deterministic for
 * identical bytes: no OCR, no clock, no randomness in the text pipeline.
 */
export async function extractPdfText(content: Buffer): Promise<string> {
  const document = await getDocumentProxy(new Uint8Array(content));
  const { text } = await extractText(document, { mergePages: true });
  return text;
}

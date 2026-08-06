/**
 * Shared by the CLI backends: the prompts demand a bare JSON object, but
 * models wrap it in a markdown fence often enough that failing the whole
 * attempt over the fence would waste quota. Strips an optional fence and
 * parses the remainder; throws SyntaxError on non-JSON — the calling
 * backend wraps that in its own AdapterOutputError with CLI-specific
 * wording.
 */
const FENCED = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

export function parseFencedJson(text: string): unknown {
  const fenced = FENCED.exec(text.trim());
  return JSON.parse(fenced ? fenced[1] : text.trim());
}

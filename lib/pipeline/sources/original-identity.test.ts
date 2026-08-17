import { describe, expect, it } from "vitest";

import type { ClaimsRegister, Source } from "../../register";
import exampleProject from "../../register/schema/__fixtures__/example-project.json";
import { formatCitation } from "./csl";
import { deriveOriginalIdentity } from "./original-identity";

function register(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

/**
 * The bibliographic core the source originally carried. Shaped like the
 * register's archive entry, which is `toPlainCsl(source)` — the full item minus
 * `custom`, so `id` and `type` are retained.
 */
const ORIGINAL_ITEM: Record<string, unknown> = {
  id: "src_meyer2025",
  type: "article-journal",
  title: "Effects of AI Assistants on Code Review Time",
  author: [{ family: "Mayer", given: "A." }],
  issued: { "date-parts": [[2024]] },
  "container-title": "ACM TOSEM",
};

/**
 * A source corrected once. Every identity correction revises the snapshot
 * before it archives the identity, so a corrected source always carries both a
 * `previous_identities` and a `previous_snapshots` entry. Capture time
 * (2026-07-20) and correction time (2026-08-14, mirrored by the current
 * snapshot's 2026-07-28) deliberately differ: that gap is what separates the
 * original capture date from the current snapshot's `retrieved_at`.
 */
function correctedSource(): Source {
  const source = register().sources[0];
  source.custom.previous_identities = [
    { replaced_at: "2026-08-14T10:15:00Z", item: { ...ORIGINAL_ITEM } },
  ];
  source.custom.previous_snapshots = [
    {
      retrieved_at: "2026-07-20T09:00:00Z",
      sha256: "a".repeat(64),
      blob_path: `blobs/aa/${"a".repeat(64)}.pdf`,
      revision: 1,
    },
  ];
  return source;
}

describe("deriveOriginalIdentity", () => {
  it("returns undefined for a source whose identity was never corrected", () => {
    const source = register().sources[0];
    expect(source.custom.previous_identities).toBeUndefined();
    expect(deriveOriginalIdentity(source)).toBeUndefined();
  });

  it("projects citation and original capture date for a manual capture", () => {
    const source = correctedSource();
    expect(deriveOriginalIdentity(source)).toEqual({
      citation: "Mayer (2024), ACM TOSEM",
      capturedAt: "2026-07-20T09:00:00Z",
    });
    // The current snapshot's retrieved_at is the correction's revision, not
    // the original capture — asserting the gap keeps that confusion out.
    expect(source.custom.snapshot?.retrieved_at).toBe("2026-07-28T08:05:12Z");
  });

  it("omits the auto-capture block entirely when the source was captured manually", () => {
    const projected = deriveOriginalIdentity(correctedSource());
    expect(projected).toBeDefined();
    expect(Object.hasOwn(projected as object, "autoCapture")).toBe(false);
  });

  it("carries the original entry's auto-capture method and raw text", () => {
    const source = correctedSource();
    source.custom.auto_capture = {
      raw_text: 'Mayer, A. (2024): „Effects of AI Assistants“, ACM TOSEM.',
      method: "crossref_title",
      score: 0.87,
    };
    expect(deriveOriginalIdentity(source)?.autoCapture).toEqual({
      method: "crossref_title",
      rawText: 'Mayer, A. (2024): „Effects of AI Assistants“, ACM TOSEM.',
    });
  });

  it("formats the archived identity through the same path as a current one", () => {
    const source = correctedSource();
    const asCurrentIdentity = {
      ...ORIGINAL_ITEM,
      custom: source.custom,
    } as unknown as Source;
    // One formatter, two callers: a second citation formatter would drift and
    // the original identity would stop reading like the current one.
    expect(deriveOriginalIdentity(source)?.citation).toBe(
      formatCitation(asCurrentIdentity),
    );
    // Pin the shared value too, so the equality above cannot be satisfied by
    // both sides collapsing to the id fallback.
    expect(deriveOriginalIdentity(source)?.citation).toBe(
      "Mayer (2024), ACM TOSEM",
    );
  });
});

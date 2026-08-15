/**
 * Identifier handling against the thesis's own real search output.
 *
 * `identifiers/ids_<block>_<system>.txt` are the raw identifier lists two
 * agentic research systems (ChatGPT Deep Research, Claude Research) returned
 * for the six thematic search blocks of the literature review — 675 lines of
 * genuine LLM output, not a fixture anyone shaped to pass.
 * `korpus-manifest.csv` is the frozen corpus, `exclusion-log-2026-07-26.md`
 * the archived log of identifiers that resolved to nothing.
 *
 * Why this suite exists at all: the thesis's methodology appendix reports
 * that every entry in that exclusion log came from a defect in the ingest
 * tool — arXiv patterns wrongly extracted out of DOI strings — and not from
 * a fabricated reference. That is a parsing failure, this repository has the
 * same two normalizers, and nothing here had ever run them against real
 * identifiers.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeArxivId,
  normalizeDoi,
} from "../../lib/pipeline/sources/identifiers";
import { scanRegex } from "../../lib/pipeline/sources/reference-scan/scan-regex";
import { listIdentifierFiles, readIdentifierFile } from "./corpus-store";

interface CorpusIdentifier {
  readonly raw: string;
  readonly file: string;
  /** Which research system produced it. */
  readonly system: "chatgpt" | "claude";
  readonly looksLikeDoi: boolean;
}

function loadResearchIdentifiers(): CorpusIdentifier[] {
  const identifiers: CorpusIdentifier[] = [];
  for (const file of listIdentifierFiles(/^ids_[a-f]_(chatgpt|claude)\.txt$/)) {
    const system = file.includes("chatgpt") ? "chatgpt" : "claude";
    for (const line of readIdentifierFile(file).split(/\r?\n/)) {
      const raw = line.trim();
      if (raw.length === 0) {
        continue;
      }
      identifiers.push({
        raw,
        file,
        system,
        looksLikeDoi: raw.startsWith("10."),
      });
    }
  }
  return identifiers;
}

const RESEARCH_IDENTIFIERS = loadResearchIdentifiers();

describe("real research-system identifier lists", () => {
  it("are actually present and non-trivial", () => {
    // Guards the corpus itself: a silently truncated copy would turn every
    // assertion below into a green no-op over an empty array.
    expect(RESEARCH_IDENTIFIERS.length).toBeGreaterThan(300);
    expect(new Set(RESEARCH_IDENTIFIERS.map((id) => id.file)).size).toBe(12);
    for (const system of ["chatgpt", "claude"] as const) {
      expect(
        RESEARCH_IDENTIFIERS.filter((id) => id.system === system).length,
      ).toBeGreaterThan(100);
    }
  });

  it("normalize every DOI to itself", () => {
    const dois = RESEARCH_IDENTIFIERS.filter((id) => id.looksLikeDoi);
    expect(dois.length).toBeGreaterThan(50);
    for (const { raw, file } of dois) {
      expect(normalizeDoi(raw), `${file}: ${raw}`).toBe(raw);
    }
  });

  it("normalize every arXiv id to its bare form", () => {
    const arxiv = RESEARCH_IDENTIFIERS.filter((id) => /^arxiv:/i.test(id.raw));
    expect(arxiv.length).toBeGreaterThan(200);
    for (const { raw, file } of arxiv) {
      const expected = raw.replace(/^arxiv:/i, "").replace(/v\d+$/, "");
      expect(normalizeArxivId(raw), `${file}: ${raw}`).toBe(expected);
    }
  });

  it("never mistake a real DOI for an arXiv id in the reference scan", () => {
    // The scan channel is the one that runs unattended over a briefing, so
    // this is the property that actually protects the corpus: an arXiv id is
    // recognized only behind an explicit "arXiv:" prefix or an arxiv.org
    // URL, which no DOI string carries.
    for (const { raw, looksLikeDoi } of RESEARCH_IDENTIFIERS) {
      if (!looksLikeDoi) {
        continue;
      }
      const hits = scanRegex(`Siehe dazu die Arbeit unter ${raw} (2026).`);
      expect(
        hits.map((hit) => hit.method),
        raw,
      ).not.toContain("arxiv");
      expect(
        hits.map((hit) => hit.method),
        raw,
      ).toContain("doi");
    }
  });

  /**
   * KNOWN GAP — pinned, not fixed (deliberate: see the findings note in
   * `tests/corpus/README.md`).
   *
   * `normalizeArxivId` looks for `\b\d{4}\.\d{4,5}\b` anywhere in the input,
   * so a DOI whose suffix embeds a year-like number satisfies it. Two of the
   * 83 real DOIs in the research lists do:
   *
   *   10.1109/eScience65000.2025.00093  →  "2025.00093"
   *   10.1109/ESEM64174.2025.00053      →  "2025.00053"
   *
   * This is the same shape of defect the thesis's own ingest tool had, and
   * the reason its exclusion log filled up with identifiers that were never
   * fabricated in the first place.
   *
   * It is not currently reachable from the reference scan (the assertion
   * above proves that) and not from a DOI capture (`capture.ts` selects the
   * normalizer by the caller's `kind`). It IS reachable from a manual
   * capture where a human picks "arXiv" in the form and pastes a DOI: the
   * work-item guard at `sources/work-items/queue.ts` accepts it, and the
   * capture then resolves a number arXiv has never heard of.
   *
   * This test asserts the CURRENT behaviour, so the count cannot grow
   * unnoticed and a future fix has to come here and say so.
   */
  it("pins the DOIs that the bare arXiv normalizer still misreads", () => {
    const misread = RESEARCH_IDENTIFIERS.filter(
      (id) => id.looksLikeDoi && normalizeArxivId(id.raw) !== null,
    ).map((id) => `${id.raw} -> ${normalizeArxivId(id.raw)}`);

    expect(misread.sort()).toEqual([
      "10.1109/ESEM64174.2025.00053 -> 2025.00053",
      "10.1109/eScience65000.2025.00093 -> 2025.00093",
    ]);
  });
});

describe("the frozen corpus manifest", () => {
  const rows = readIdentifierFile("korpus-manifest.csv")
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(",")[0]);

  it("lists arXiv identifiers the capture path can resolve", () => {
    const arxiv = rows.filter((id) => /^arxiv:/i.test(id));
    expect(arxiv.length).toBeGreaterThan(20);
    for (const id of arxiv) {
      expect(normalizeArxivId(id), id).not.toBeNull();
    }
  });

  /**
   * The manifest's `doi:` rows are NOT wire-form DOIs. `corpus_extract.py`
   * writes a path-safe encoding — both `/` and `-` collapse to `_` — because
   * the same string names a file on disk:
   *
   *   doi:10.18653_v1_2025.acl_demo.47   (manifest)
   *   10.18653/v1/2025.acl-demo.47       (the actual DOI)
   *
   * The encoding is lossy: nothing in the string says which `_` was a slash
   * and which was a hyphen, so it cannot be reversed mechanically. Pinned
   * here because the manifest is otherwise an obvious thing to feed into the
   * capture path, and doing so would fail — correctly, but confusingly.
   */
  it("stores DOIs path-encoded, which is deliberately not resolvable", () => {
    const dois = rows.filter((id) => id.startsWith("doi:"));
    expect(dois.length).toBeGreaterThan(0);
    for (const id of dois) {
      expect(id).toMatch(/^doi:10\.\d{4,9}_/);
      expect(normalizeDoi(id), `${id} must not masquerade as a wire DOI`).toBe(
        null,
      );
    }
  });

  it("pins a SHA-256 per document, which is what makes it auditable", () => {
    for (const line of readIdentifierFile("korpus-manifest.csv")
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim().length > 0)) {
      expect(line.split(",")[3]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("the archived exclusion log", () => {
  const ids = [
    ...new Set(
      [
        ...readIdentifierFile("exclusion-log-2026-07-26.md").matchAll(
          /`([^`]+)`/g,
        ),
      ].map((match) => match[1]),
    ),
  ];

  it("holds identifiers that PARSE but do not resolve", () => {
    // The distinction the pipeline has to preserve: these are syntactically
    // fine, so the failure belongs to resolution (capture work item fails,
    // durable register event) and not to input validation (rejected at the
    // form). Conflating the two is how a real citation problem gets reported
    // as a typo.
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      expect(normalizeArxivId(id), id).not.toBeNull();
    }
  });
});

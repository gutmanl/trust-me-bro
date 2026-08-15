/**
 * Regenerates the SYNTHETIC half of the real-world corpus.
 *
 *   npx tsx scripts/seed-corpus.ts
 *
 * The corpus has to be useful before anyone has run the recorder, otherwise
 * the end-to-end specs would ship dormant and nobody would notice them
 * rotting. So every interaction the specs need exists here as a synthetic
 * cassette, shaped after the response the production parser actually reads,
 * and marked `provenance.kind = "synthetic"` so the integrity test can say
 * out loud how much of the corpus is still made up.
 *
 * `npm run corpus:record` overwrites these files in place with real
 * recordings and flips the provenance. No spec changes when it does — that
 * is the entire point of keeping the scenario definitions
 * (`tests/corpus/scenarios.ts`) apart from the answers.
 *
 * This script writes only under `tests/corpus/`. It spends no quota and
 * touches no network; it is safe to re-run at any time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";

import { cleanReferenceTitle } from "../lib/pipeline/sources/reference-scan/reference-title";
import type { CorpusDocument, HttpCassette } from "../tests/corpus/cassette";
import { httpCassetteKey } from "../tests/corpus/cassette";
import {
  AUDIT_TRAILS_DOCUMENT,
  AUDIT_TRAILS_PDF_URL,
  CITATION_WITHOUT_IDENTIFIER,
  FOOTNOTES,
  SOURCE_AUDIT_TRAILS,
  SOURCE_MISATTRIBUTED,
  SOURCE_UNRESOLVABLE,
} from "../tests/corpus/scenarios";

const corpusRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "corpus",
);

const CSL_ACCEPT = "application/vnd.citationstyles.csl+json";
const ATOM_ACCEPT = "application/atom+xml";
const JSON_ACCEPT = "application/json";

/**
 * SHA-256 of the archived copy in the thesis's frozen corpus
 * (`identifiers/korpus-manifest.csv`). Pinned here so `corpus:fetch` has
 * something real to compare a fresh download against, with the caveat the
 * manifest itself carries: it describes the local archive, and arXiv can
 * re-stamp a PDF, so a mismatch is a warning rather than a failure until the
 * recorder observes its own hash.
 */
const THESIS_CORPUS_SHA256 =
  "4e2243656bb0bb7529e46de41603d651622c7e3bd04cc9b001d8eb29ccf0f149";

function synthetic(note: string) {
  return { kind: "synthetic", note } as const;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeHttpCassette(
  cassette: Omit<HttpCassette, "key"> & { key?: string },
): void {
  const key = httpCassetteKey(cassette.url, cassette.accept);
  writeJson(path.join(corpusRoot, "http", `${key}.json`), {
    ...cassette,
    key,
  });
  console.log(`  http  ${key}  ${cassette.url}`);
}

/**
 * A minimal but genuinely valid PDF carrying `text`, built the same way as
 * `lib/pipeline/fulltext/__fixtures__/sample.pdf`. It has to be a real PDF,
 * not a stub: the seed corpus is worth having only if `unpdf` parses it, so
 * that stage 1's wording proof runs against actually extracted text rather
 * than against a string the test handed itself.
 *
 * The text is split across two lines at a hyphen on purpose — cross-line
 * hyphenation is the normalization case real academic PDFs produce
 * constantly, and the one a naive substring check fails.
 */
function minimalPdf(text: string): Buffer {
  // Wrapped to a width that fits the MediaBox: pdf.js drops glyphs that run
  // off the page, so one long line would silently truncate the extracted
  // text and make every wording assertion downstream meaningless.
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > 58) {
      lines.push(current);
      current = word;
    } else {
      current = current.length === 0 ? word : `${current} ${word}`;
    }
  }
  lines.push(current);

  // Break the last word of the first line at a hyphen, the way a typeset PDF
  // does. Stage 1 has to see through it, and a fixture without it would let
  // a naive substring check pass.
  if (lines.length > 1 && lines[0].length > 12) {
    const split = lines[0].lastIndexOf(" ");
    const tail = lines[0].slice(split + 1);
    if (tail.length > 3) {
      const cut = Math.ceil(tail.length / 2);
      lines[0] = `${lines[0].slice(0, split + 1)}${tail.slice(0, cut)}-`;
      lines[1] = `${tail.slice(cut)} ${lines[1]}`;
    }
  }

  const escape = (value: string) => value.replace(/([()\\])/g, "\\$1");
  const content =
    "BT /F1 12 Tf 72 720 Td " +
    lines
      .map(
        (line, index) =>
          `${index === 0 ? "" : "0 -16 Td "}(${escape(line)}) Tj `,
      )
      .join("") +
    "ET";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function seedDocuments(): CorpusDocument[] {
  const seedRelative = path.join("documents-seed", AUDIT_TRAILS_DOCUMENT);
  const bytes = minimalPdf(SOURCE_AUDIT_TRAILS.documentText ?? "");
  const absolute = path.join(corpusRoot, seedRelative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  console.log(
    `  seed  ${seedRelative}  (${bytes.length} bytes, ` +
      `sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}…)`,
  );

  return [
    {
      name: AUDIT_TRAILS_DOCUMENT,
      url: AUDIT_TRAILS_PDF_URL,
      sha256: THESIS_CORPUS_SHA256,
      sha256_source: "thesis-corpus",
      bytes: null,
      file: path.join("documents", AUDIT_TRAILS_DOCUMENT),
      seedFile: seedRelative,
      note:
        "arXiv preprint, redistributable under the submitter's licence but " +
        "kept out of git for size; the committed seed stand-in is a " +
        "generated PDF carrying the quoted sentence.",
    },
  ];
}

function main(): void {
  console.log("Seeding synthetic corpus cassettes…");

  // --- arXiv: the clean resolution -------------------------------------
  writeHttpCassette({
    url: `https://export.arxiv.org/api/query?id_list=${SOURCE_AUDIT_TRAILS.canonical}&max_results=1`,
    accept: ATOM_ACCEPT,
    status: 200,
    contentType: "application/atom+xml",
    bodyText: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      "  <entry>",
      `    <id>http://arxiv.org/abs/${SOURCE_AUDIT_TRAILS.canonical}v1</id>`,
      // Wrapped across lines exactly as the real API emits long titles —
      // resolveArxiv collapses the whitespace, and a fixture that pre-flattens
      // it would never exercise that.
      `    <title>Audit Trails for Accountability in`,
      `      Large Language Models</title>`,
      `    <published>${SOURCE_AUDIT_TRAILS.year}-01-28T09:14:00Z</published>`,
      "    <author><name>Elena Rivera</name></author>",
      "    <author><name>Kenji Nakamura</name></author>",
      "  </entry>",
      "</feed>",
    ].join("\n"),
    provenance: synthetic(
      "Atom feed shaped for resolveArxiv (entry/title/published/author).",
    ),
  });

  // --- arXiv: the identifier that resolves to nothing --------------------
  writeHttpCassette({
    url: `https://export.arxiv.org/api/query?id_list=${SOURCE_UNRESOLVABLE.canonical}&max_results=1`,
    accept: ATOM_ACCEPT,
    status: 200,
    contentType: "application/atom+xml",
    // A 200 with an empty feed, NOT a 404: this is what arXiv actually does
    // for a well-formed id it does not know, and the distinction decides
    // whether the pipeline reports "unknown work" or "service unreachable".
    bodyText: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    ].join("\n"),
    provenance: synthetic(
      "Empty Atom feed — arXiv answers 200 for an unknown id, not 404.",
    ),
  });

  // --- doi.org: resolves, but to a different work ------------------------
  writeHttpCassette({
    url: `https://doi.org/${SOURCE_MISATTRIBUTED.canonical}`,
    accept: CSL_ACCEPT,
    status: 200,
    contentType: "application/vnd.citationstyles.csl+json",
    bodyText: JSON.stringify({
      id: "https://doi.org/10.18653/v1/2024.inlg-main.35",
      type: "paper-conference",
      title: SOURCE_MISATTRIBUTED.resolvedTitle,
      author: [
        { family: "Willemsen", given: "Bram" },
        { family: "Skantze", given: "Gabriel" },
      ],
      issued: { "date-parts": [[2024, 9]] },
      "container-title":
        "Proceedings of the 17th International Natural Language Generation Conference",
      publisher: "Association for Computational Linguistics",
      DOI: SOURCE_MISATTRIBUTED.canonical,
    }),
    provenance: synthetic(
      "CSL-JSON via doi.org content negotiation; title deliberately differs " +
        "from the briefing's attribution.",
    ),
  });

  // --- Crossref: the same work's PDF link --------------------------------
  writeHttpCassette({
    url: `https://api.crossref.org/works/${encodeURIComponent(SOURCE_MISATTRIBUTED.canonical)}`,
    accept: JSON_ACCEPT,
    status: 200,
    contentType: "application/json",
    bodyText: JSON.stringify({
      status: "ok",
      message: {
        DOI: SOURCE_MISATTRIBUTED.canonical,
        title: [SOURCE_MISATTRIBUTED.resolvedTitle],
        author: [{ family: "Willemsen", given: "Bram" }],
        issued: { "date-parts": [[2024]] },
        "container-title": ["Proceedings of INLG 2024"],
        link: [
          {
            URL: "https://aclanthology.org/2024.inlg-main.35/",
            "content-type": "text/html",
            "intended-application": "similarity-checking",
          },
          {
            URL: "https://aclanthology.org/2024.inlg-main.35.pdf",
            "content-type": "application/pdf",
            "intended-application": "text-mining",
          },
        ],
      },
    }),
    provenance: synthetic(
      "Crossref /works/<doi> with a text/html and an application/pdf link[].",
    ),
  });

  // --- Crossref: the title searches the scan will actually issue ---------
  //
  // The query strings are built with the SAME helpers the pipeline uses
  // (cleanReferenceTitle, then title + authors), not transcribed by hand —
  // a cassette keyed on a URL the code never requests is a cassette that
  // silently does nothing, and the miss would surface as a confusing
  // "Crossref unavailable" rather than as a missing recording.
  const titleQueries = [
    // The competing hypothesis fetched after an identity conflict: the scan
    // asks what the CITED title resolves to. Regex seeds carry no authors,
    // so the query is the cleaned footnote title alone.
    {
      query: cleanReferenceTitle(
        FOOTNOTES.misattributed.replace(/^\[\^\d+\]:\s*/, ""),
      ),
      note: "Identity-conflict follow-up: what does the cited title point at?",
    },
    // The prose-only citation the LLM channel reports, resolved by title.
    {
      query: [
        cleanReferenceTitle(CITATION_WITHOUT_IDENTIFIER.title),
        CITATION_WITHOUT_IDENTIFIER.authors.join(" "),
      ].join(" "),
      note: "Identifier-less citation from the LLM channel.",
    },
  ];
  for (const { query, note } of titleQueries) {
    writeHttpCassette({
      url:
        "https://api.crossref.org/works?query.bibliographic=" +
        `${encodeURIComponent(query)}&rows=5`,
      accept: JSON_ACCEPT,
      status: 200,
      contentType: "application/json",
      // Crossref answered; it simply has no work under that title. The
      // `unavailable` flag has to stay false here — "nothing found" and
      // "service down" take different branches, and only one of them is
      // allowed to leave a durable failure on the work item.
      bodyText: JSON.stringify({ status: "ok", message: { items: [] } }),
      provenance: synthetic(
        `Healthy 200 with zero items — distinct from a Crossref outage. ${note}`,
      ),
    });
  }

  // --- Unpaywall --------------------------------------------------------
  writeHttpCassette({
    url:
      `https://api.unpaywall.org/v2/${encodeURIComponent(SOURCE_MISATTRIBUTED.canonical)}` +
      "?email=REDACTED",
    accept: JSON_ACCEPT,
    status: 200,
    contentType: "application/json",
    bodyText: JSON.stringify({
      doi: SOURCE_MISATTRIBUTED.canonical,
      is_oa: true,
      best_oa_location: {
        url_for_pdf: "https://aclanthology.org/2024.inlg-main.35.pdf",
      },
      oa_locations: [
        { url_for_pdf: "https://aclanthology.org/2024.inlg-main.35.pdf" },
      ],
    }),
    provenance: synthetic(
      "Unpaywall best_oa_location; the recorder redacts the contact address.",
    ),
  });

  // --- The document itself ----------------------------------------------
  writeHttpCassette({
    url: AUDIT_TRAILS_PDF_URL,
    status: 200,
    contentType: "application/pdf",
    bodyDocument: AUDIT_TRAILS_DOCUMENT,
    provenance: synthetic("PDF body served from documents.json."),
  });

  const documents = seedDocuments();
  writeJson(path.join(corpusRoot, "documents.json"), { documents });

  console.log(
    `\nDone. ${fs.readdirSync(path.join(corpusRoot, "http")).length} HTTP ` +
      `cassettes, ${documents.length} document(s).`,
  );
  console.log(
    "Record the real thing with:  npm run corpus:record -- --http --llm",
  );
}

main();

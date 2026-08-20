import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterStore } from "../../register";
import { InvalidSourceInputError } from "../errors";
import { createProject } from "../projects";
import {
  ARXIV_ATOM_RESPONSE,
  CSL_JSON_RESPONSE,
  fakeFetcher,
} from "./__fixtures__/fake-fetcher";
import { deriveMetadataFromDocument } from "./derive-metadata";

const PROJECT = "proj_derive-metadata";

/** The DOI and the title CSL_JSON_RESPONSE resolves to — the derivation's
 * job is to find the first inside the document and confirm it against the
 * second. */
const DOI = "10.1109/TSE.2025.3489012";
const RESOLVED_TITLE = "Effects of AI Assistants on Code Review Duration";

let workspace: string;

/** Serves the DOI resolver and the arXiv export API. */
function resolvingFetcher() {
  return fakeFetcher({
    "https://doi.org/": {
      contentType: "application/vnd.citationstyles.csl+json",
      body: Buffer.from(CSL_JSON_RESPONSE),
    },
    "https://export.arxiv.org/api/query": {
      contentType: "application/atom+xml",
      body: Buffer.from(ARXIV_ATOM_RESPONSE),
    },
  });
}

/** A plain-text "document" — the .txt path through acquireDocument and
 * extractFullText is byte-for-byte the same one a PDF takes once unpdf has
 * turned it into a string, so no PDF fixture is needed to exercise the
 * scan/resolve/verify chain. */
function textUpload(body: string, filename = "paper.txt") {
  return { content: Buffer.from(body, "utf8"), filename };
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-derive-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: PROJECT,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("deriveMetadataFromDocument", () => {
  it("verifies a DOI whose resolved title stands on the line it was found on", async () => {
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(
          `${RESOLVED_TITLE}. DOI: ${DOI}\n\nAbstract: irgendein Volltext.\n`,
        ),
      },
      { fetcher: resolvingFetcher() },
    );

    expect(candidate.status).toBe("verified");
    if (candidate.status !== "verified") {
      throw new Error("unreachable");
    }
    expect(candidate.kind).toBe("doi");
    expect(candidate.identifier).toBe(DOI);
    expect(candidate.citation).toContain("Meyer");
    expect(candidate.matchedLine).toContain(RESOLVED_TITLE);
    expect(candidate.manual).toEqual({
      title: RESOLVED_TITLE,
      authors: "Meyer, A.",
      year: "2025",
      container_title: "IEEE Transactions on Software Engineering",
    });
    expect(candidate.document.filename).toBe("paper.txt");
    expect(candidate.document.blob_path).toMatch(/^blobs\//);
  });

  it("accepts a title the extraction mangled, via bigram similarity", async () => {
    // No containment: the extraction dropped a word and swapped the dash.
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(
          `Effects of AI Assistants on Code-Review Durations ${DOI}\n`,
        ),
      },
      { fetcher: resolvingFetcher() },
    );
    expect(candidate.status).toBe("verified");
  });

  it("reports a DOI whose resolved title matches nothing on the line as unverified", async () => {
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(
          `Ein völlig anderes Thema ohne Bezug zum Papier ${DOI}\n`,
        ),
      },
      { fetcher: resolvingFetcher() },
    );

    expect(candidate.status).toBe("unverified");
    if (candidate.status !== "unverified") {
      throw new Error("unreachable");
    }
    expect(candidate.identifier).toBe(DOI);
    expect(candidate.citation).toContain("Meyer");
    expect(candidate.matchedLine).toContain("völlig anderes Thema");
    expect(candidate.manual.title).toBe(RESOLVED_TITLE);
  });

  it("refuses containment on a title too short to identify anything", async () => {
    const shortTitle = "Fairness";
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(`Fairness und andere Fragen, siehe ${DOI}\n`),
      },
      {
        fetcher: fakeFetcher({
          "https://doi.org/": {
            contentType: "application/vnd.citationstyles.csl+json",
            body: Buffer.from(JSON.stringify({ title: shortTitle })),
          },
        }),
      },
    );
    // "Fairness" IS contained in the line, and is still not evidence.
    expect(candidate.status).toBe("unverified");
  });

  it("does not see a DOI beyond the 12 000-character scan window", async () => {
    const filler = "Fülltext ohne jede Kennung. ".repeat(600);
    expect(filler.length).toBeGreaterThan(12_000);
    const candidate = await deriveMetadataFromDocument(
      { projectId: PROJECT, upload: textUpload(`${filler}\n${DOI}\n`) },
      { fetcher: resolvingFetcher() },
    );

    expect(candidate).toMatchObject({
      status: "not_found",
      reason: "no_identifier",
    });
  });

  it("reports a document without a readable text layer as no_text", async () => {
    // Whitespace only: extractFullText's "ergab keinen Text" case, which is
    // exactly what a scanned PDF produces.
    const candidate = await deriveMetadataFromDocument(
      { projectId: PROJECT, upload: textUpload("   \n \n") },
      { fetcher: resolvingFetcher() },
    );

    expect(candidate).toMatchObject({ status: "not_found", reason: "no_text" });
    expect(candidate.document.blob_path).toMatch(/^blobs\//);
  });

  it("degrades to unresolved when the identifier cannot be resolved", async () => {
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(`${RESOLVED_TITLE}. DOI: ${DOI}\n`),
      },
      // No doi.org route: the fake answers 404, resolveDoi throws.
      { fetcher: fakeFetcher({}) },
    );

    expect(candidate).toMatchObject({
      status: "unresolved",
      kind: "doi",
      identifier: DOI,
    });
  });

  it("falls back to an arXiv id when the window holds no DOI", async () => {
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(
          "Large Language Models for Code Review, arXiv:2401.12345\n",
        ),
      },
      { fetcher: resolvingFetcher() },
    );

    expect(candidate).toMatchObject({
      status: "verified",
      kind: "arxiv",
      identifier: "2401.12345",
    });
    if (candidate.status !== "verified") {
      throw new Error("unreachable");
    }
    expect(candidate.manual.authors).toBe("Meyer, Anna; Schulz, Ben");
  });

  it("ignores a bare URL, which resolves to no bibliographic identity", async () => {
    const candidate = await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload("Siehe https://example.org/papers/17 für Details\n"),
      },
      { fetcher: resolvingFetcher() },
    );
    expect(candidate).toMatchObject({
      status: "not_found",
      reason: "no_identifier",
    });
  });

  it("writes nothing to the register", async () => {
    const store = RegisterStore.forProject(PROJECT);
    const before = await store.read();
    await deriveMetadataFromDocument(
      {
        projectId: PROJECT,
        upload: textUpload(`${RESOLVED_TITLE}. DOI: ${DOI}\n`),
      },
      { fetcher: resolvingFetcher() },
    );
    const after = await store.read();

    expect(after.project_events).toHaveLength(before.project_events.length);
    expect(after.sources).toEqual(before.sources);
    expect(after.project.source_set_revision).toBe(
      before.project.source_set_revision,
    );
  });

  describe("the returned filename", () => {
    it("keeps an upload's own name", async () => {
      const candidate = await deriveMetadataFromDocument(
        {
          projectId: PROJECT,
          upload: textUpload("kein Bezeichner hier\n", "alrajeh2013.txt"),
        },
        { fetcher: resolvingFetcher() },
      );
      expect(candidate.document.filename).toBe("alrajeh2013.txt");
    });

    it("synthesizes one when the URL path carries no usable extension", async () => {
      const fetcher = fakeFetcher({
        "https://publisher.example.org/doi/pdf/10.1109": {
          contentType: "application/pdf",
          body: Buffer.from("%PDF-1.7 kein Text\n"),
        },
      });
      const candidate = await deriveMetadataFromDocument(
        {
          projectId: PROJECT,
          documentUrl: "https://publisher.example.org/doi/pdf/10.1109",
        },
        { fetcher },
      );
      // Without this the confirm submit would send "10.1109" back, whose
      // extFromFilename is "bin" — routing the bytes around the %PDF- check.
      expect(candidate.document.filename).toBe("dokument.pdf");
    });

    it("keeps a URL basename that already names the right extension", async () => {
      const fetcher = fakeFetcher({
        "https://oa.example.org/best.txt": {
          contentType: "text/plain",
          body: Buffer.from(`${RESOLVED_TITLE}. DOI: ${DOI}\n`),
        },
        "https://doi.org/": {
          contentType: "application/vnd.citationstyles.csl+json",
          body: Buffer.from(CSL_JSON_RESPONSE),
        },
      });
      const candidate = await deriveMetadataFromDocument(
        { projectId: PROJECT, documentUrl: "https://oa.example.org/best.txt" },
        { fetcher },
      );
      expect(candidate.document.filename).toBe("best.txt");
      expect(candidate.status).toBe("verified");
    });
  });

  it("rejects a call carrying neither an upload nor a URL", async () => {
    await expect(
      deriveMetadataFromDocument(
        { projectId: PROJECT },
        { fetcher: resolvingFetcher() },
      ),
    ).rejects.toThrow(InvalidSourceInputError);
  });
});

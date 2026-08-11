import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { containsNormalized, RegisterStore, Source } from "../../register";
import {
  DocumentFetchError,
  EmptySourceSetError,
  InvalidSourceInputError,
  SourceSetFrozenError,
} from "../errors";
import { createProject } from "../projects";
import {
  ARXIV_ATOM_RESPONSE,
  CSL_JSON_RESPONSE,
  fakeFetcher,
} from "./__fixtures__/fake-fetcher";
import { captureSource, freezeSourceSet, isSourceSetFrozen } from "./capture";

const PDF_BYTES = Buffer.from("%PDF-1.7 fake");
const REAL_PDF = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fulltext",
    "__fixtures__",
    "sample.pdf",
  ),
);

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-sources-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  await createProject({
    id: "proj_quellen",
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function defaultFetcher() {
  return fakeFetcher({
    "https://doi.org/": {
      contentType: "application/vnd.citationstyles.csl+json",
      body: Buffer.from(CSL_JSON_RESPONSE),
    },
    "https://export.arxiv.org/": {
      contentType: "application/atom+xml",
      body: Buffer.from(ARXIV_ATOM_RESPONSE),
    },
    "https://arxiv.org/pdf/": {
      contentType: "application/pdf",
      body: PDF_BYTES,
    },
    "https://publisher.example.org/paper.pdf": {
      contentType: "application/pdf",
      body: PDF_BYTES,
    },
    "https://blog.example.org/post": {
      contentType: "text/html",
      body: Buffer.from("<html><body>Beitrag</body></html>"),
    },
  });
}

describe("captureSource via DOI", () => {
  it("resolves metadata, freezes the snapshot and validates as source", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "doi",
        identifier: "https://doi.org/10.1109/TSE.2025.3489012",
        sourceType: "peer_reviewed_publication",
        documentUrl: "https://publisher.example.org/paper.pdf",
      },
      { fetcher: defaultFetcher() },
    );

    expect(source.id).toBe("src_meyer2025");
    expect(source.title).toBe(
      "Effects of AI Assistants on Code Review Duration",
    );
    expect(source.custom.source_type).toBe("peer_reviewed_publication");
    expect(source.custom.identifier_verified?.status).toBe(true);
    expect(source.custom.snapshot?.revision).toBe(1);
    expect(source.custom.snapshot?.blob_path).toContain(
      source.custom.snapshot?.sha256,
    );
    expect(source.custom.snapshot?.blob_path.endsWith(".pdf")).toBe(true);
    expect(Source.safeParse(source).success).toBe(true);

    const store = RegisterStore.forProject("proj_quellen");
    const register = await store.read();
    expect(register.sources).toHaveLength(1);
    expect(
      store.blobs().read(source.custom.snapshot?.blob_path as string),
    ).toEqual(PDF_BYTES);
    expect((await store.verify()).ok).toBe(true);
    // Manual capture: no reference auto-import provenance attached.
    expect(source.custom.auto_capture).toBeUndefined();
  });

  it("attaches auto_capture provenance when supplied, and it round-trips durably", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "doi",
        identifier: "https://doi.org/10.1109/TSE.2025.3489012",
        sourceType: "peer_reviewed_publication",
        documentUrl: "https://publisher.example.org/paper.pdf",
        autoCapture: {
          raw_text: "Meyer et al. (2025), doi:10.1109/TSE.2025.3489012",
          method: "doi",
          score: 0.95,
        },
      },
      { fetcher: defaultFetcher() },
    );

    expect(source.custom.auto_capture).toEqual({
      raw_text: "Meyer et al. (2025), doi:10.1109/TSE.2025.3489012",
      method: "doi",
      score: 0.95,
    });
    expect(Source.safeParse(source).success).toBe(true);

    const store = RegisterStore.forProject("proj_quellen");
    const register = await store.read();
    expect(register.sources[0]?.custom.auto_capture?.method).toBe("doi");
    expect((await store.verify()).ok).toBe(true);
  });

  it("requires a document URL or upload for DOIs", async () => {
    await expect(
      captureSource(
        {
          projectId: "proj_quellen",
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
          sourceType: "peer_reviewed_publication",
        },
        { fetcher: defaultFetcher() },
      ),
    ).rejects.toBeInstanceOf(InvalidSourceInputError);
  });

  it("rejects unrecognizable DOIs before any network call", async () => {
    const fetcher = defaultFetcher();
    await expect(
      captureSource(
        {
          projectId: "proj_quellen",
          kind: "doi",
          identifier: "kein-doi",
          sourceType: "preprint",
        },
        { fetcher },
      ),
    ).rejects.toBeInstanceOf(InvalidSourceInputError);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("surfaces document download failures as DocumentFetchError", async () => {
    await expect(
      captureSource(
        {
          projectId: "proj_quellen",
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
          sourceType: "peer_reviewed_publication",
          documentUrl: "https://publisher.example.org/gibtsnicht.pdf",
        },
        { fetcher: defaultFetcher() },
      ),
    ).rejects.toBeInstanceOf(DocumentFetchError);
  });
});

describe("captureSource: expectedExt guard (reference auto-import, Task 3b)", () => {
  it("accepts a document whose resolved extension matches expectedExt", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "doi",
        identifier: "10.1109/TSE.2025.3489012",
        sourceType: "peer_reviewed_publication",
        documentUrl: "https://publisher.example.org/paper.pdf",
        expectedExt: "pdf",
      },
      { fetcher: defaultFetcher() },
    );
    expect(source.custom.snapshot?.blob_path.endsWith(".pdf")).toBe(true);
  });

  it("fails visibly with a German DocumentFetchError when a derived URL turns out not to be a PDF, leaving the register unchanged", async () => {
    await expect(
      captureSource(
        {
          projectId: "proj_quellen",
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
          sourceType: "peer_reviewed_publication",
          documentUrl: "https://blog.example.org/post",
          expectedExt: "pdf",
        },
        { fetcher: defaultFetcher() },
      ),
    ).rejects.toThrow(DocumentFetchError);

    try {
      await captureSource(
        {
          projectId: "proj_quellen",
          kind: "doi",
          identifier: "10.1109/TSE.2025.3489012",
          sourceType: "peer_reviewed_publication",
          documentUrl: "https://blog.example.org/post",
          expectedExt: "pdf",
        },
        { fetcher: defaultFetcher() },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentFetchError);
      expect((error as Error).message).toContain("kein PDF");
      expect((error as Error).message).toContain('"html"');
    }

    const store = RegisterStore.forProject("proj_quellen");
    const register = await store.read();
    expect(register.sources).toHaveLength(0);
  });

  it("leaves manual capture (no expectedExt) completely unaffected — an HTML document still captures normally", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "url",
        identifier: "https://blog.example.org/post",
        sourceType: "grey_literature",
        manual: { title: "Blogbeitrag zu Reviews" },
      },
      { fetcher: defaultFetcher() },
    );
    expect(source.custom.snapshot?.blob_path.endsWith(".html")).toBe(true);
  });
});

describe("captureSource via arXiv", () => {
  it("derives the PDF URL from the id", async () => {
    const fetcher = defaultFetcher();
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "arxiv",
        identifier: "arXiv:2401.12345v1",
        sourceType: "preprint",
      },
      { fetcher },
    );
    expect(source.id).toBe("src_meyer2024");
    expect(source.custom.identifier_verified?.status).toBe(true);
    expect(
      fetcher.calls.some((call) =>
        call.url.startsWith("https://arxiv.org/pdf/2401.12345"),
      ),
    ).toBe(true);
  });
});

describe("captureSource via URL and upload", () => {
  it("captures a URL source with manual metadata, unverified", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "url",
        identifier: "https://blog.example.org/post",
        sourceType: "grey_literature",
        manual: { title: "Blogbeitrag zu Reviews", year: "2026" },
      },
      { fetcher: defaultFetcher() },
    );
    expect(source.type).toBe("webpage");
    expect(source.custom.identifier_verified).toBeUndefined();
    expect(source.custom.snapshot?.blob_path.endsWith(".html")).toBe(true);
  });

  it("captures an upload without any network call", async () => {
    const fetcher = defaultFetcher();
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "upload",
        sourceType: "vendor_documentation",
        manual: { title: "Produkt-Whitepaper", authors: "Meyer, Anna" },
        upload: { content: PDF_BYTES, filename: "Whitepaper.PDF" },
      },
      { fetcher },
    );
    expect(fetcher.calls).toHaveLength(0);
    expect(source.custom.snapshot?.blob_path.endsWith(".pdf")).toBe(true);
    expect(source.id).toBe("src_meyer");
  });

  it("requires manual metadata with a title", async () => {
    await expect(
      captureSource(
        {
          projectId: "proj_quellen",
          kind: "upload",
          sourceType: "grey_literature",
          manual: { title: "  " },
          upload: { content: PDF_BYTES, filename: "x.pdf" },
        },
        { fetcher: defaultFetcher() },
      ),
    ).rejects.toBeInstanceOf(InvalidSourceInputError);
  });

  it("suffixes colliding source ids", async () => {
    const input = {
      projectId: "proj_quellen",
      kind: "upload" as const,
      sourceType: "grey_literature" as const,
      manual: { title: "Bericht", authors: "Meyer, Anna", year: "2026" },
      upload: { content: PDF_BYTES, filename: "a.pdf" },
    };
    const first = await captureSource(input, { fetcher: defaultFetcher() });
    const second = await captureSource(
      {
        ...input,
        upload: { content: Buffer.from("anders"), filename: "b.pdf" },
      },
      { fetcher: defaultFetcher() },
    );
    expect(first.id).toBe("src_meyer2026");
    expect(second.id).toBe("src_meyer2026-2");
  });
});

describe("full-text extraction at capture (TMB-24)", () => {
  it("stores the extracted text as its own blob next to the snapshot", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "upload",
        sourceType: "peer_reviewed_publication",
        manual: { title: "Studie zur Reviewzeit" },
        upload: { content: REAL_PDF, filename: "studie.pdf" },
      },
      { fetcher: defaultFetcher() },
    );
    const snapshot = source.custom.snapshot;
    expect(snapshot?.text_extraction_error).toBeUndefined();
    expect(snapshot?.text_blob_path?.endsWith(".txt")).toBe(true);
    const store = RegisterStore.forProject("proj_quellen");
    const text = store.blobs().readText(snapshot?.text_blob_path as string);
    expect(containsNormalized(text, "Reviewzeit sank von 42 auf 19")).toBe(
      true,
    );
    expect((await store.verify()).ok).toBe(true);
  });

  it("records extraction failures durably at the source entry", async () => {
    const source = await captureSource(
      {
        projectId: "proj_quellen",
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Kaputtes PDF" },
        upload: { content: PDF_BYTES, filename: "kaputt.pdf" },
      },
      { fetcher: defaultFetcher() },
    );
    const snapshot = source.custom.snapshot;
    expect(snapshot?.text_blob_path).toBeUndefined();
    expect(snapshot?.text_extraction_error).toMatch(/Volltextextraktion/);

    // The failure is persisted, not UI state: it survives a re-read.
    const register = await RegisterStore.forProject("proj_quellen").read();
    expect(register.sources[0].custom.snapshot?.text_extraction_error).toMatch(
      /Volltextextraktion/,
    );
  });
});

describe("freezeSourceSet", () => {
  it("rejects freezing an empty source set", async () => {
    await expect(freezeSourceSet("proj_quellen")).rejects.toBeInstanceOf(
      EmptySourceSetError,
    );
  });

  it("appends the source_set_frozen event and blocks further captures", async () => {
    await captureSource(
      {
        projectId: "proj_quellen",
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Bericht" },
        upload: { content: PDF_BYTES, filename: "a.pdf" },
      },
      { fetcher: defaultFetcher() },
    );
    await freezeSourceSet("proj_quellen");

    const store = RegisterStore.forProject("proj_quellen");
    const register = await store.read();
    expect(isSourceSetFrozen(register)).toBe(true);
    const freezeEvent = register.project_events.find(
      (event) => event.event === "source_set_frozen",
    );
    expect(freezeEvent?.reason).toBe(
      "Quellenbestand eingefroren: 1 Quelle(n), Revision 1.",
    );
    expect((await store.verify()).ok).toBe(true);

    await expect(freezeSourceSet("proj_quellen")).rejects.toBeInstanceOf(
      SourceSetFrozenError,
    );
    await expect(
      captureSource(
        {
          projectId: "proj_quellen",
          kind: "upload",
          sourceType: "grey_literature",
          manual: { title: "Nachzügler" },
          upload: { content: PDF_BYTES, filename: "b.pdf" },
        },
        { fetcher: defaultFetcher() },
      ),
    ).rejects.toBeInstanceOf(SourceSetFrozenError);
  });
});

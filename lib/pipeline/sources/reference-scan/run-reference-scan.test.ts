import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdapterProcessError,
  AdapterRateLimitError,
  createMockBackend,
  Orchestrator,
} from "../../../adapters";
import type { MockBackend, ReferenceParseOutput } from "../../../adapters";
import { RegisterStore } from "../../../register";
import { importBriefing } from "../../briefing";
import { ReferenceScanPreconditionError } from "../../errors";
import { createProject } from "../../projects";
import { createJobRunner } from "../../runs/job-runner";
import { captureSource, freezeSourceSet } from "../capture";
import {
  CROSSREF_EMPTY_RESULTS_RESPONSE,
  CROSSREF_WORK_WITH_PDF_LINK_RESPONSE,
  fakeFetcher,
} from "../__fixtures__/fake-fetcher";
import { deriveReferenceScanState } from "./derive-state";
import {
  getReferenceScanState,
  startReferenceScan,
} from "./run-reference-scan";
import { ReferenceScanResult } from "./schema";

const PROJECT_ID = "proj_referenzscan";

const BRIEFING = [
  "LLM-Reviews reduzieren die Reviewzeit erheblich (siehe https://doi.org/10.1109/TSE.2025.3489012).",
  "",
  "Schulz et al. (2020) fanden vergleichbare Resultate in einer separaten Studie.",
].join("\n");

const REFERENCE_PARSE_OUTPUT: ReferenceParseOutput = {
  references: [
    {
      raw_text:
        "Schulz et al. (2020) fanden vergleichbare Resultate in einer separaten Studie.",
      authors: ["Team Schulz"],
      year: 2020,
      title: "Comparable Effects of AI in Software Teams",
    },
  ],
};

const CROSSREF_MATCH_RESPONSE = JSON.stringify({
  status: "ok",
  message: {
    items: [
      {
        DOI: "10.1000/schulz2020",
        title: ["Comparable Effects of AI in Software Teams"],
        author: [{ family: "Schulz", given: "Team" }],
        issued: { "date-parts": [[2020]] },
        "container-title": ["Journal of Software Teams"],
      },
    ],
  },
});

function testOrchestratorWithBackend(options?: {
  output?: ReferenceParseOutput;
  script?: ReadonlyArray<Error | "ok">;
}): { orchestrator: Orchestrator; backend: MockBackend } {
  const backend = createMockBackend({
    id: "claude",
    model: "claude-sonnet-5",
    overrides: { reference_parse: options?.output ?? REFERENCE_PARSE_OUTPUT },
    script: options?.script,
  });
  const orchestrator = new Orchestrator({
    backends: [backend],
    traceSink: { write: async () => {} },
    gate: { run: (fn) => fn() },
    policy: { maxAttempts: 2, retryBaseDelayMs: 1 },
    sleep: async () => {},
  });
  return { orchestrator, backend };
}

function testOrchestrator(options?: {
  output?: ReferenceParseOutput;
}): Orchestrator {
  return testOrchestratorWithBackend(options).orchestrator;
}

function scanFetcher() {
  return fakeFetcher({
    "https://api.crossref.org/works": {
      contentType: "application/json",
      body: Buffer.from(CROSSREF_MATCH_RESPONSE),
    },
  });
}

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-refscan-"));
  vi.stubEnv("TMB_WORKSPACE", workspace);
  vi.stubEnv("TMB_ACTOR_HANDLE", "lg");
  // Isolates getUnpaywallEmail() (document-url derivation) from whatever
  // ~/.trustmebro/config.json happens to exist on the machine running the
  // tests — points at a file that (by default) never gets created.
  vi.stubEnv("TMB_CONFIG_PATH", path.join(workspace, "identity-config.json"));
  vi.stubEnv("TMB_UNPAYWALL_EMAIL", undefined);
  await createProject({
    id: PROJECT_ID,
    research_question: "Reduzieren LLM-Reviews die Reviewzeit?",
    primaryCli: "claude",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("startReferenceScan preconditions", () => {
  it("requires an imported briefing", async () => {
    await expect(startReferenceScan(PROJECT_ID)).rejects.toBeInstanceOf(
      ReferenceScanPreconditionError,
    );
  });

  it("refuses once the source set is frozen", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    await captureSource(
      {
        projectId: PROJECT_ID,
        kind: "upload",
        sourceType: "grey_literature",
        manual: { title: "Bericht" },
        upload: { content: Buffer.from("x"), filename: "a.pdf" },
      },
      { fetcher: fakeFetcher({}) },
    );
    await freezeSourceSet(PROJECT_ID);
    await expect(startReferenceScan(PROJECT_ID)).rejects.toBeInstanceOf(
      ReferenceScanPreconditionError,
    );
  });
});

describe("startReferenceScan: regex-only degradation", () => {
  it("never blocks on an unusable backend, degrades to regex-only, and records that in the pointer's method", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const runner = createJobRunner({ generateRunId: () => "lauf-1" });
    const { orchestrator, backend } = testOrchestratorWithBackend();
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator,
      runner,
      preflight: async () => ({
        usable: false,
        hint: "claude nicht angemeldet.",
      }),
      fetcher: scanFetcher(),
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });

    // The LLM channel was never even attempted.
    expect(backend.calls).toHaveLength(0);

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.project.reference_scan?.method).toBe("regex");
    expect(register.project.reference_scan?.candidate_count).toBe(1);

    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    expect(blob.method).toBe("regex");
    expect(blob.candidates).toHaveLength(1);
    expect(blob.candidates[0]).toMatchObject({
      method: "doi",
      doi: "10.1109/TSE.2025.3489012",
    });

    const completedEvent = register.project_events.find(
      (event) => event.event === "reference_scan_completed",
    );
    expect(completedEvent?.reason).toContain("Backend nicht einsatzbereit");
    expect(completedEvent?.reason).toContain("claude nicht angemeldet");

    expect((await store.verify()).ok).toBe(true);
    expect(getReferenceScanState(PROJECT_ID, register, { runner }).status).toBe(
      "completed",
    );
  });

  it("degrades to regex-only, without throwing, when the LLM channel is rate-limited (orchestrator paused)", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const { orchestrator, backend } = testOrchestratorWithBackend({
      script: [
        new AdapterRateLimitError(
          "claude",
          "reference_parse",
          "Rate-Limit erreicht.",
        ),
      ],
    });
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator,
      runner: createJobRunner(),
      fetcher: scanFetcher(),
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });
    expect(backend.calls).toHaveLength(1);

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.project.reference_scan?.method).toBe("regex");
    expect(register.project.reference_scan?.candidate_count).toBe(1);
    const completedEvent = register.project_events.find(
      (event) => event.event === "reference_scan_completed",
    );
    expect(completedEvent?.reason).toContain("Rate-Limit");
    expect((await store.verify()).ok).toBe(true);
  });

  it("degrades to regex-only, without throwing, when the LLM channel is exhausted after retries", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const crash = new AdapterProcessError(
      "claude",
      "reference_parse",
      1,
      "boom",
    );
    const { orchestrator, backend } = testOrchestratorWithBackend({
      script: [crash, crash],
    });
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator,
      runner: createJobRunner(),
      fetcher: scanFetcher(),
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });
    expect(backend.calls).toHaveLength(2);

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.project.reference_scan?.method).toBe("regex");
    expect(register.project.reference_scan?.candidate_count).toBe(1);
    const completedEvent = register.project_events.find(
      (event) => event.event === "reference_scan_completed",
    );
    expect(completedEvent?.reason).toContain("erschöpft");
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("startReferenceScan: full path (regex + llm + crossref)", () => {
  it("merges the regex DOI hit and the Crossref-resolved textual citation", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const runner = createJobRunner({ generateRunId: () => "lauf-1" });
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner,
      fetcher: scanFetcher(),
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    expect(register.project.reference_scan?.method).toBe("regex+llm");
    expect(register.project.reference_scan?.candidate_count).toBe(2);

    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    const byMethod = Object.fromEntries(
      blob.candidates.map((candidate) => [candidate.method, candidate]),
    );
    expect(byMethod.doi).toMatchObject({
      doi: "10.1109/TSE.2025.3489012",
      suggested_source_type: "peer_reviewed_publication",
    });
    expect(byMethod.crossref_title).toMatchObject({
      doi: "10.1000/schulz2020",
      title: "Comparable Effects of AI in Software Teams",
      suggested_source_type: "peer_reviewed_publication",
    });
    expect(byMethod.crossref_title.match_score).toBeGreaterThan(0.9);

    expect((await store.verify()).ok).toBe(true);
  });

  it("marks a citation crossref_unavailable when Crossref cannot be reached", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
      fetcher: fakeFetcher({
        "https://api.crossref.org/works": { status: 500 },
      }),
    });
    await handle.done;

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    const unresolved = blob.candidates.find(
      (candidate) => candidate.method === "unresolved",
    );
    expect(unresolved?.crossref_unavailable).toBe(true);
  });

  // I3 regression: a healthy Crossref response with zero matching items is
  // "genuinely no match", NOT an outage — crossref_unavailable must stay
  // false so the review UI doesn't invite a pointless retry.
  it("does NOT mark a citation crossref_unavailable when Crossref answers 200 with zero items", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
      fetcher: fakeFetcher({
        "https://api.crossref.org/works": {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_EMPTY_RESULTS_RESPONSE),
        },
      }),
    });
    await handle.done;

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    const unresolved = blob.candidates.find(
      (candidate) => candidate.method === "unresolved",
    );
    expect(unresolved).toBeDefined();
    expect(unresolved?.crossref_unavailable).toBeUndefined();
  });
});

describe("startReferenceScan: atomicity", () => {
  it("commits the candidates blob and the pointer in ONE transaction (2 total: started + final)", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const transactionSpy = vi.spyOn(RegisterStore.prototype, "transaction");
    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
      fetcher: scanFetcher(),
    });
    await handle.done;
    expect(transactionSpy).toHaveBeenCalledTimes(2);
  });

  it("a rejected final transaction leaves the previous scan's pointer and blob intact", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });

    const first = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
      fetcher: scanFetcher(),
    });
    await first.done;
    const store = RegisterStore.forProject(PROJECT_ID);
    const before = await store.read();
    const previousPointer = before.project.reference_scan;
    expect(previousPointer).toBeDefined();

    // Force the SECOND run's blob write to fail mid-transaction (simulates
    // any failure between blobs().put and the register write committing) —
    // the whole transaction must then be rejected as a unit.
    const realBlobs = RegisterStore.prototype.blobs;
    vi.spyOn(RegisterStore.prototype, "blobs").mockImplementation(function (
      this: RegisterStore,
    ) {
      const real = realBlobs.call(this);
      return {
        ...real,
        put: () => {
          throw new Error("Simulierter Schreibfehler.");
        },
      };
    });

    const second = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
      fetcher: scanFetcher(),
    });
    const result = await second.done;
    expect(result).toEqual({ succeeded: 0, failed: 1 });

    vi.restoreAllMocks();
    const after = await store.read();
    expect(after.project.reference_scan).toEqual(previousPointer);
    expect(store.blobs().exists(previousPointer!.blob_path)).toBe(true);
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("startReferenceScan: document-url derivation (reference auto-import, Task 3b)", () => {
  it("derives an arXiv PDF URL for a regex-found arXiv id", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: "Siehe arXiv:2401.12345 für Details.",
      tool: "x",
    });
    const handle = await startReferenceScan(PROJECT_ID, {
      runner: createJobRunner(),
      preflight: async () => ({ usable: false, hint: "kein Backend." }),
      fetcher: fakeFetcher({}),
    });
    await handle.done;

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    expect(blob.candidates).toHaveLength(1);
    expect(blob.candidates[0]).toMatchObject({
      method: "arxiv",
      document_url: "https://arxiv.org/pdf/2401.12345",
      document_url_source: "arxiv",
    });
  });

  it("derives a Crossref PDF-link document_url for a regex-found DOI", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const doiWorkUrl = `https://api.crossref.org/works/${encodeURIComponent("10.1109/TSE.2025.3489012")}`;
    const handle = await startReferenceScan(PROJECT_ID, {
      runner: createJobRunner(),
      preflight: async () => ({ usable: false, hint: "kein Backend." }),
      fetcher: fakeFetcher({
        [doiWorkUrl]: {
          contentType: "application/json",
          body: Buffer.from(CROSSREF_WORK_WITH_PDF_LINK_RESPONSE),
        },
      }),
    });
    await handle.done;

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    const doiCandidate = blob.candidates.find(
      (candidate) => candidate.method === "doi",
    );
    expect(doiCandidate).toMatchObject({
      document_url: "https://publisher.example.org/paper.pdf",
      document_url_source: "crossref_pdf",
    });
  });

  it("never fails the scan when document-url derivation cannot reach Crossref", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const handle = await startReferenceScan(PROJECT_ID, {
      runner: createJobRunner(),
      preflight: async () => ({ usable: false, hint: "kein Backend." }),
      fetcher: fakeFetcher({}), // every route 404s
    });
    const result = await handle.done;
    expect(result).toEqual({ succeeded: 1, failed: 0 });

    const store = RegisterStore.forProject(PROJECT_ID);
    const register = await store.read();
    const blob = ReferenceScanResult.parse(
      JSON.parse(
        store.blobs().readText(register.project.reference_scan!.blob_path),
      ),
    );
    const doiCandidate = blob.candidates.find(
      (candidate) => candidate.method === "doi",
    );
    expect(doiCandidate?.document_url).toBeUndefined();
    expect((await store.verify()).ok).toBe(true);
  });
});

describe("startReferenceScan: interrupted run derivation", () => {
  it("derives interrupted for a dangling started bracket, and a fresh run recovers it", async () => {
    await importBriefing({
      projectId: PROJECT_ID,
      content: BRIEFING,
      tool: "x",
    });
    const store = RegisterStore.forProject(PROJECT_ID);
    await store.transaction((tx) => {
      tx.recordProjectEvent({
        event: "reference_scan_started",
        reason: "Referenz-Scan gestartet (Lauf abgebrochen).",
        actor: "system:reference_scan",
      });
    });
    const registerAfterCrash = await store.read();
    expect(deriveReferenceScanState(registerAfterCrash, false).status).toBe(
      "interrupted",
    );

    const handle = await startReferenceScan(PROJECT_ID, {
      orchestrator: testOrchestrator(),
      runner: createJobRunner(),
      fetcher: scanFetcher(),
    });
    await handle.done;
    const register = await store.read();
    expect(getReferenceScanState(PROJECT_ID, register).status).toBe(
      "completed",
    );
  });
});

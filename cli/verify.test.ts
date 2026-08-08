import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildManifest,
  bundleText,
  serializeManifest,
  unzipBundle,
  zipBundle,
} from "../lib/export";
import type { BundleFiles } from "../lib/export";
import { latestChainLink, sha256Hex } from "../lib/register";
import { ChainAppender } from "../lib/register/chain";
import type { ClaimsRegister } from "../lib/register/schema";
import exampleProject from "../lib/register/schema/__fixtures__/example-project.json";
import { runVerify } from "./verify";

let projectDir: string;

/** Deterministic blob contents whose real SHA-256 replaces the fixture's
 * placeholder checksums, so blob integrity is actually checkable. */
const BLOBS = {
  briefing: Buffer.from("Das ist das eingefrorene Briefing.\n"),
  snapshot: Buffer.from("%PDF-1.4 snapshot bytes\n"),
  text: Buffer.from("median review time dropped\n"),
};

function blobPathFor(content: Buffer, ext: string): string {
  const sha = sha256Hex(content);
  return `blobs/${sha.slice(0, 2)}/${sha}.${ext}`;
}

/** Rebuilds the fixture's chain via ChainAppender so it is gapless and closed
 * (the appendix example intentionally elides seq 3–7), with REAL blob
 * checksums for the three blob contents. */
function chainedFixture(): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;
  register.project.briefing_import = {
    ...register.project.briefing_import!,
    sha256: sha256Hex(BLOBS.briefing),
    blob_path: blobPathFor(BLOBS.briefing, "md"),
  };
  const snapshot = register.sources[0].custom.snapshot!;
  register.sources[0].custom.snapshot = {
    ...snapshot,
    sha256: sha256Hex(BLOBS.snapshot),
    blob_path: blobPathFor(BLOBS.snapshot, "pdf"),
    text_blob_path: blobPathFor(BLOBS.text, "txt"),
  };

  const historyEntries = register.claims[0].history;
  const [frozen] = register.project_events;
  register.claims[0].history = [];
  register.project_events = [];
  const appender = new ChainAppender(register);
  register.project_events.push(
    appender.append({
      ...frozen,
      seq: undefined,
      prev_hash: undefined,
      hash: undefined,
    }) as never,
  );
  for (const entry of historyEntries) {
    register.claims[0].history.push(
      appender.append({
        ...entry,
        seq: undefined,
        prev_hash: undefined,
        hash: undefined,
      }) as never,
    );
  }
  return register;
}

function blobEntries(register: ClaimsRegister): [string, Buffer][] {
  return [
    [register.project.briefing_import!.blob_path, BLOBS.briefing],
    [register.sources[0].custom.snapshot!.blob_path, BLOBS.snapshot],
    [register.sources[0].custom.snapshot!.text_blob_path!, BLOBS.text],
  ];
}

function writeClaims(register: ClaimsRegister): void {
  fs.writeFileSync(
    path.join(projectDir, "claims.json"),
    JSON.stringify(register, null, 2),
  );
}

function writeBlobs(register: ClaimsRegister): void {
  for (const [relativePath, content] of blobEntries(register)) {
    const absolute = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

/** Synthetic .tmb bundle over the register, written to a file. */
function writeBundle(
  register: ClaimsRegister,
  mutate?: (files: BundleFiles) => void,
): string {
  const files: BundleFiles = {
    "claims.json": bundleText.encode(`${JSON.stringify(register, null, 2)}\n`),
  };
  for (const [relativePath, content] of blobEntries(register)) {
    files[relativePath] = new Uint8Array(content);
  }
  const manifest = buildManifest({
    files,
    excludedBlobs: [],
    schemaVersion: register.schema_version,
    innerId: register.project.id,
    directoryName: register.project.id,
    exportedAt: "2026-08-08T12:00:00Z",
    chainHead: latestChainLink(register)!,
    includesBlobs: true,
  });
  files["manifest.json"] = bundleText.encode(serializeManifest(manifest));
  mutate?.(files);
  const bundlePath = path.join(projectDir, "export.tmb");
  fs.writeFileSync(
    bundlePath,
    Buffer.from(zipBundle(files, "2026-08-08T12:00:00Z")),
  );
  return bundlePath;
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-verify-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("tmb verify on a project directory", () => {
  it("reports a valid project with intact blobs as ok", () => {
    const register = chainedFixture();
    writeClaims(register);
    writeBlobs(register);
    const report = runVerify(projectDir);
    expect(report.messages.join("\n")).toContain("gapless");
    expect(report.messages.join("\n")).toContain("blob integrity ok");
    expect(report.ok).toBe(true);
  });

  it("reports a tampered entry as chain violation", () => {
    const register = chainedFixture();
    register.claims[0].history[0].reason = "manipuliert";
    writeClaims(register);
    writeBlobs(register);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("hash_mismatch");
  });

  it("reports a corrupted blob against its snapshot checksum", () => {
    const register = chainedFixture();
    writeClaims(register);
    writeBlobs(register);
    const blobPath = register.sources[0].custom.snapshot!.blob_path;
    fs.writeFileSync(path.join(projectDir, blobPath), "andere bytes");
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain(
      `blob missing or checksum mismatch: ${blobPath}`,
    );
  });

  it("reports a missing referenced blob", () => {
    const register = chainedFixture();
    writeClaims(register);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("blob integrity FAILED");
  });

  it("reports schema violations before chain checks", () => {
    const register = chainedFixture() as Record<string, unknown>;
    register.schema_version = "0.0.1";
    writeClaims(register as unknown as ClaimsRegister);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("schema violation");
  });

  it("fails cleanly on a missing claims.json", () => {
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("no claims.json");
  });

  it("fails cleanly on a nonexistent target", () => {
    const report = runVerify(path.join(projectDir, "gibt-es-nicht"));
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("does not exist");
  });
});

describe("tmb verify on a .tmb bundle", () => {
  it("behaves identically to directory mode for an intact project", () => {
    const register = chainedFixture();
    writeClaims(register);
    writeBlobs(register);
    const bundlePath = writeBundle(register);

    const directoryReport = runVerify(projectDir);
    const bundleReport = runVerify(bundlePath);
    expect(directoryReport.ok).toBe(true);
    expect(bundleReport.ok).toBe(true);
    // Identical substance: same chain summary line in both modes.
    const chainLine = (report: { messages: string[] }): string | undefined =>
      report.messages.find((message) => message.includes("hash chain valid"));
    expect(chainLine(bundleReport)).toBe(chainLine(directoryReport));
    expect(bundleReport.messages.join("\n")).toContain("manifest ok");
  });

  it("reports a flipped blob byte with the offending path", () => {
    const register = chainedFixture();
    const blobPath = register.sources[0].custom.snapshot!.blob_path;
    const bundlePath = writeBundle(register, (files) => {
      files[blobPath] = new Uint8Array(files[blobPath]);
      files[blobPath][0] ^= 0xff;
    });
    const report = runVerify(bundlePath);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain(blobPath);
  });

  it("reports a chain break with position and kind despite a consistent manifest", () => {
    const register = chainedFixture();
    register.claims[0].history[0].reason = "manipuliert";
    // Manifest is built OVER the tampered claims.json — checksums agree,
    // only the chain itself catches the interior edit.
    const report = runVerify(writeBundle(register));
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("hash_mismatch");
    expect(report.messages.join("\n")).toMatch(/seq \d+/);
  });

  it("reports tail truncation via the manifest checksums", () => {
    const register = chainedFixture();
    const original = writeBundle(register);
    const files = unzipBundle(new Uint8Array(fs.readFileSync(original)));
    const truncated = structuredClone(register);
    truncated.claims[0].history.pop();
    truncated.claims[0].status = "zur_adjudikation";
    files["claims.json"] = bundleText.encode(
      `${JSON.stringify(truncated, null, 2)}\n`,
    );
    fs.writeFileSync(
      original,
      Buffer.from(zipBundle(files, "2026-08-08T12:00:00Z")),
    );
    const report = runVerify(original);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("Prüfsumme");
  });

  it("fails cleanly on a file that is no ZIP", () => {
    const bogus = path.join(projectDir, "kein-bundle.tmb");
    fs.writeFileSync(bogus, "kein zip");
    const report = runVerify(bogus);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("malformed");
  });
});

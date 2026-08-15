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
import { latestChainLink } from "../lib/register";
import type { ClaimsRegister } from "../lib/register";
import { ChainAppender } from "../lib/register/chain/appender";
import {
  chainedFixture,
  fixtureBlobEntries,
} from "../lib/register/schema/__fixtures__/chained-project";
import { runVerify } from "./verify";

let projectDir: string;

function writeClaims(register: ClaimsRegister): void {
  fs.writeFileSync(
    path.join(projectDir, "claims.json"),
    JSON.stringify(register, null, 2),
  );
}

function writeBlobs(register: ClaimsRegister): void {
  for (const [relativePath, content] of fixtureBlobEntries(register)) {
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
  for (const [relativePath, content] of fixtureBlobEntries(register)) {
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

  it("reports content tampered past the chain via the state root (review S-01 reproduction)", () => {
    // The software review's reproduction: claim text, evidence excerpt and
    // source title edited in an otherwise valid register. Before the
    // state-root extension this passed schema AND chain verification.
    const register = chainedFixture();
    register.claims[0].text = "Ganz anders lautender Claim.";
    register.claims[0].evidence[0].verbatim_excerpt = "…erfundener Auszug…";
    (register.sources[0] as { title?: string }).title = "Anderer Titel";
    writeClaims(register);
    writeBlobs(register);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("state_root_mismatch");
  });

  it("names the unverified content state of a legacy register without state roots", () => {
    // A legacy chain is one minted without commit-time sealing: same entries,
    // no state_root. Rebuild the fixture's chain accordingly.
    const register = chainedFixture();
    const events = register.project_events;
    const entries = register.claims[0].history;
    register.project_events = [];
    register.claims[0].history = [];
    const appender = new ChainAppender(register);
    const strip = ({
      seq: _seq,
      prev_hash: _prev,
      hash: _hash,
      state_root: _root,
      ...entry
    }: (typeof entries)[number] | (typeof events)[number]) => entry;
    for (const event of events) {
      register.project_events.push(appender.append(strip(event)) as never);
    }
    for (const entry of entries) {
      register.claims[0].history.push(appender.append(strip(entry)) as never);
    }
    writeClaims(register);
    writeBlobs(register);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(true);
    expect(report.messages.join("\n")).toContain("content state UNVERIFIED");
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
      `blob checksum mismatch: ${blobPath}`,
    );
  });

  it("reports missing referenced blobs with the lean-import hint", () => {
    const register = chainedFixture();
    writeClaims(register);
    const report = runVerify(projectDir);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("blob integrity FAILED");
    expect(report.messages.join("\n")).toContain(
      "blob missing (lean import without blobs?)",
    );
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

  it("verifies the project directory when pointed at claims.json itself", () => {
    // The likeliest first-use mistake: the register file instead of its
    // directory. This used to be read as a ZIP bundle and reported as
    // "bundle is malformed" — misleading for a file the tool itself wrote.
    const register = chainedFixture();
    writeClaims(register);
    writeBlobs(register);
    const report = runVerify(path.join(projectDir, "claims.json"));
    expect(report.ok).toBe(true);
    expect(report.messages[0]).toContain("verifying its project directory");
    expect(report.messages.join("\n")).toContain("gapless");
    expect(report.messages.join("\n")).toContain("blob integrity ok");
  });

  it("still reports a tampered register when pointed at claims.json itself", () => {
    const register = chainedFixture();
    register.claims[0].history[0].reason = "manipuliert";
    writeClaims(register);
    writeBlobs(register);
    const report = runVerify(path.join(projectDir, "claims.json"));
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("hash_mismatch");
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
    truncated.claims[0].status = "pending_adjudication";
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

  it("fails cleanly on a file that is no ZIP, pointing at the directory alternative", () => {
    const bogus = path.join(projectDir, "kein-bundle.tmb");
    fs.writeFileSync(bogus, "kein zip");
    const report = runVerify(bogus);
    expect(report.ok).toBe(false);
    expect(report.messages.join("\n")).toContain("malformed");
    // A stray non-bundle file is usually a mistaken target — the hint names
    // the correct one instead of leaving "malformed" as the whole answer.
    expect(report.messages.join("\n")).toContain(
      "pass its directory (the folder containing claims.json)",
    );
  });
});

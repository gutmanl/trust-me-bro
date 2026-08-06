import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobPath } from "../schema/primitives";
import { blobRelativePath, createBlobStore, resolveBlobPath } from "./index";
import type { BlobStore } from "./index";

let projectDir: string;
let store: BlobStore;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmb-blobs-"));
  store = createBlobStore(projectDir);
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("BlobStore.put", () => {
  it("stores content under blobs/<prefix>/<sha256>.<ext>", () => {
    const ref = store.put("Originaltext des Briefings", "md");
    expect(ref.blobPath).toBe(blobRelativePath(ref.sha256, "md"));
    expect(ref.blobPath.startsWith(`blobs/${ref.sha256.slice(0, 2)}/`)).toBe(
      true,
    );
    expect(fs.existsSync(store.resolve(ref.blobPath))).toBe(true);
    // The produced path validates against the claims.json field schema (F6).
    expect(BlobPath.safeParse(ref.blobPath).success).toBe(true);
  });

  it("stores identical content only once and returns the same ref", () => {
    const first = store.put("same bytes", "txt");
    const before = fs.statSync(store.resolve(first.blobPath)).mtimeMs;
    const second = store.put("same bytes", "txt");
    const after = fs.statSync(store.resolve(second.blobPath)).mtimeMs;
    expect(second).toEqual(first);
    expect(after).toBe(before);
  });

  it("lets different revisions of a source coexist", () => {
    const rev1 = store.put("Fassung 1", "pdf");
    const rev2 = store.put("Fassung 2", "pdf");
    expect(rev1.blobPath).not.toBe(rev2.blobPath);
    expect(store.exists(rev1.blobPath)).toBe(true);
    expect(store.exists(rev2.blobPath)).toBe(true);
  });

  it("rejects invalid extensions", () => {
    expect(() => store.put("x", "PDF")).toThrow(/extension/);
    expect(() => store.put("x", "p.f")).toThrow(/extension/);
  });
});

describe("BlobStore.read", () => {
  it("round-trips text content", () => {
    const ref = store.put("Prüftext mit Umlauten: äöü", "txt");
    expect(store.readText(ref.blobPath)).toBe("Prüftext mit Umlauten: äöü");
  });
});

describe("BlobStore.verifyIntegrity", () => {
  it("accepts an untouched blob", () => {
    const ref = store.put("intakt", "txt");
    expect(store.verifyIntegrity(ref.blobPath)).toBe(true);
  });

  it("detects a tampered blob file", () => {
    const ref = store.put("original", "txt");
    fs.writeFileSync(store.resolve(ref.blobPath), "manipuliert");
    expect(store.verifyIntegrity(ref.blobPath)).toBe(false);
  });

  it("reports a missing blob as not intact", () => {
    const ref = store.put("da", "txt");
    fs.rmSync(store.resolve(ref.blobPath));
    expect(store.verifyIntegrity(ref.blobPath)).toBe(false);
  });
});

describe("resolveBlobPath", () => {
  it("rejects traversal and non-blob paths", () => {
    for (const bad of [
      "../../etc/passwd",
      "blobs/../claims.json",
      `blobs/zz/${"a".repeat(64)}.pdf`.replace("zz", ".."),
      "blobs/ab/short.pdf",
    ]) {
      expect(() => resolveBlobPath(projectDir, bad)).toThrow(
        /not a valid blob path/,
      );
    }
  });
});

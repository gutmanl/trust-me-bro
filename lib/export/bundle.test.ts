import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import { latestChainLink, sha256Hex } from "../register";
import type { ClaimsRegister } from "../register";
import {
  chainedFixture,
  fixtureBlobEntries,
} from "../register/schema/__fixtures__/chained-project";
import { BundleFormatError } from "./errors";
import { buildManifest, serializeManifest } from "./manifest";
import { bundleText, unzipBundle, zipBundle } from "./zip";
import type { BundleFiles } from "./zip";
import { verifyBundleFiles } from "./verify-bundle";

const testRegister = chainedFixture;

const serializeRegister = (register: ClaimsRegister): Uint8Array =>
  bundleText.encode(`${JSON.stringify(register, null, 2)}\n`);

/** Synthetic bundle over the test register; withBlobs toggles the lean
 * variant (checksum references only). */
function buildBundle(
  register: ClaimsRegister,
  options: { withBlobs: boolean },
): BundleFiles {
  const files: BundleFiles = { "claims.json": serializeRegister(register) };
  const blobPaths = fixtureBlobEntries(register);
  if (options.withBlobs) {
    for (const [path, content] of blobPaths) {
      files[path] = new Uint8Array(content);
    }
  }
  const manifest = buildManifest({
    files,
    excludedBlobs: options.withBlobs
      ? []
      : blobPaths.map(([path, content]) => ({
          path,
          sha256: sha256Hex(content),
        })),
    schemaVersion: register.schema_version,
    innerId: register.project.id,
    directoryName: "proj_llm-code-review-2026",
    exportedAt: "2026-08-08T12:00:00Z",
    chainHead: latestChainLink(register)!,
    includesBlobs: options.withBlobs,
  });
  files["manifest.json"] = bundleText.encode(serializeManifest(manifest));
  return files;
}

describe("zip roundtrip", () => {
  it("preserves every byte through pack and unpack", () => {
    const files: BundleFiles = {
      "claims.json": bundleText.encode('{"a":1}\n'),
      "blobs/9f/9f00.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]),
    };
    const roundtripped = unzipBundle(zipBundle(files, "2026-08-08T12:00:00Z"));
    expect(Object.keys(roundtripped).sort()).toEqual(Object.keys(files).sort());
    for (const [path, content] of Object.entries(files)) {
      expect(Buffer.compare(roundtripped[path], content), path).toBe(0);
    }
  });

  it("rejects bytes that are no ZIP archive", () => {
    expect(() => unzipBundle(bundleText.encode("kein zip"))).toThrow(
      BundleFormatError,
    );
  });

  it("rejects zip-slip entry paths before any content is looked at", () => {
    const malicious = zipSync({
      "../evil.txt": bundleText.encode("schlecht"),
    });
    expect(() => unzipBundle(malicious)).toThrow(BundleFormatError);
  });

  it("rejects colons anywhere in entry paths (NTFS alternate data streams)", () => {
    const malicious = zipSync({
      "blobs/aa/datei:versteckt.pdf": bundleText.encode("schlecht"),
    });
    expect(() => unzipBundle(malicious)).toThrow(BundleFormatError);
  });
});

describe("verifyBundleFiles", () => {
  it("accepts an intact bundle with blobs", () => {
    const verification = verifyBundleFiles(
      buildBundle(testRegister(), { withBlobs: true }),
    );
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.register?.project.id).toBe("proj_llm-code-review-2026");
    expect(verification.chainEntryCount).toBe(4);
  });

  it("accepts a lean bundle whose blobs are checksum references", () => {
    const verification = verifyBundleFiles(
      buildBundle(testRegister(), { withBlobs: false }),
    );
    expect(verification.problems).toEqual([]);
    expect(verification.manifest?.includes_blobs).toBe(false);
    expect(
      verification.manifest?.files.filter((entry) => !entry.included),
    ).toHaveLength(3);
  });

  it("flags a flipped blob byte as checksum and integrity violation", () => {
    const files = buildBundle(testRegister(), { withBlobs: true });
    const blobPath = Object.keys(files).find((path) =>
      path.startsWith("blobs/"),
    )!;
    files[blobPath] = new Uint8Array(files[blobPath]);
    files[blobPath][0] ^= 0xff;
    const verification = verifyBundleFiles(files);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContainEqual({
      type: "checksum_mismatch",
      path: blobPath,
    });
    expect(verification.problems).toContainEqual({
      type: "blob_checksum_mismatch",
      path: blobPath,
    });
  });

  it("detects tail truncation through the manifest commitment", () => {
    // Removing the highest-seq entries leaves an internally consistent
    // chain (documented limitation of verifyChain) — the manifest checksum
    // over claims.json is exactly the countermeasure.
    const register = testRegister();
    const files = buildBundle(register, { withBlobs: true });
    register.claims[0].history.pop();
    register.claims[0].status = "zur_adjudikation"; // keep status consistent
    files["claims.json"] = serializeRegister(register);
    const verification = verifyBundleFiles(files);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContainEqual({
      type: "checksum_mismatch",
      path: "claims.json",
    });
    // And the explicit chain-head statement diverges as well.
    expect(
      verification.problems.some(
        (problem) => problem.type === "chain_head_mismatch",
      ),
    ).toBe(true);
  });

  it("detects an interior edit even with a regenerated manifest", () => {
    const register = testRegister();
    register.claims[0].history[0].reason = "manipuliert";
    const verification = verifyBundleFiles(
      buildBundle(register, { withBlobs: true }),
    );
    expect(verification.ok).toBe(false);
    expect(
      verification.problems.some(
        (problem) =>
          problem.type === "chain_error" &&
          problem.error.type === "hash_mismatch",
      ),
    ).toBe(true);
  });

  it("flags missing and unlisted files", () => {
    const files = buildBundle(testRegister(), { withBlobs: true });
    const blobPath = Object.keys(files).find((path) =>
      path.startsWith("blobs/"),
    )!;
    delete files[blobPath];
    files["extra.txt"] = bundleText.encode("nicht gelistet");
    const verification = verifyBundleFiles(files);
    expect(verification.problems).toContainEqual({
      type: "missing_file",
      path: blobPath,
    });
    expect(verification.problems).toContainEqual({
      type: "unlisted_file",
      path: "extra.txt",
    });
  });

  it("reports a missing manifest as the sole problem", () => {
    const files = buildBundle(testRegister(), { withBlobs: true });
    delete files["manifest.json"];
    expect(verifyBundleFiles(files).problems).toEqual([
      { type: "missing_manifest" },
    ]);
  });
});

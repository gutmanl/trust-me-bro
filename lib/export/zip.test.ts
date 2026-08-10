import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { BundleFormatError } from "./errors";
import {
  bundleText,
  MAX_BUNDLE_ENTRIES,
  MAX_COMPRESSION_RATIO,
  unzipBundle,
  zipBundle,
} from "./zip";

/**
 * S-06: an imported bundle is untrusted input unpacked in memory, so the
 * archive limits have to hold BEFORE expansion happens. These tests build
 * hostile archives directly with fflate — going through zipBundle would
 * only ever produce well-behaved ones.
 */

describe("unzipBundle archive limits (S-06)", () => {
  it("round-trips an ordinary bundle unchanged", () => {
    const bytes = zipBundle(
      {
        "claims.json": bundleText.encode('{"schema_version":"1.0.0"}'),
        "blobs/aa/deadbeef.pdf": bundleText.encode("PDF-Bytes"),
      },
      "2026-08-10T00:00:00.000Z",
    );
    const files = unzipBundle(bytes);
    expect(Object.keys(files).sort()).toEqual([
      "blobs/aa/deadbeef.pdf",
      "claims.json",
    ]);
    expect(bundleText.decode(files["claims.json"])).toContain("schema_version");
  });

  it("refuses a zip bomb before decompressing it", () => {
    // 16 MB of zeroes deflates to ~16 KB — a ratio around 1000:1, an order
    // of magnitude past anything real content reaches. The point is that
    // this throws rather than materialising 16 MB in memory first.
    const original = 16_000_000;
    const bomb = zipSync({ "blobs/aa/bomb.pdf": new Uint8Array(original) });
    expect(original / bomb.byteLength).toBeGreaterThan(MAX_COMPRESSION_RATIO);
    expect(() => unzipBundle(bomb)).toThrow(BundleFormatError);
    expect(() => unzipBundle(bomb)).toThrow(/compression ratio/);
  });

  it("refuses an archive with too many entries", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_BUNDLE_ENTRIES; i += 1) {
      files[`blobs/aa/${i}.txt`] = bundleText.encode("x");
    }
    expect(() => unzipBundle(zipSync(files))).toThrow(/more than .* entries/);
  });

  it("still rejects non-ZIP input as a format error", () => {
    expect(() => unzipBundle(bundleText.encode("kein ZIP"))).toThrow(
      BundleFormatError,
    );
  });

  it("still rejects zip-slip paths", () => {
    const evil = zipSync({ "../../etc/passwd": bundleText.encode("nope") });
    expect(() => unzipBundle(evil)).toThrow();
  });

  it("does not trip the ratio check on small, highly compressible entries", () => {
    // A 1 KB entry of zeroes has an enormous ratio but is harmless — the
    // floor exists so ordinary small files are never refused.
    const small = zipSync({ "claims.json": new Uint8Array(1024) });
    expect(() => unzipBundle(small)).not.toThrow();
  });
});

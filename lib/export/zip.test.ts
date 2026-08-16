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
    // 1 MiB of zeroes deflates to ~1 KB — a ratio around 900:1, more than
    // four times the ceiling and an order of magnitude past anything real
    // content reaches. The point is that this throws rather than
    // materialising the entry in memory first.
    //
    // Sized for the guard rather than for drama: the ratio check only
    // applies above RATIO_CHECK_FLOOR_BYTES (64 KiB), so the fixture has to
    // clear that floor, and 1 MiB clears it sixteen times over. A 16 MB
    // bomb tested nothing further and cost ~650 ms to deflate against
    // ~20 ms here — which is what put this test within reach of the default
    // timeout on a loaded machine.
    const original = 1024 * 1024;
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
    // Stored, not deflated. The limit under test is counted off the central
    // directory, so the compression method is irrelevant to it — and
    // deflating ten thousand one-byte entries is pure fixture cost
    // (~900 ms against ~60 ms stored).
    const archive = zipSync(files, { level: 0 });
    expect(() => unzipBundle(archive)).toThrow(/more than .* entries/);
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

  it("refuses an entry whose compressed payload dwarfs its declared size", () => {
    // The ratio floor lets a tiny declared original through unquestioned. A
    // hostile archive abuses that: declare originalSize = 1 (under the
    // floor) but ship a large compressed payload, so every size/ratio check
    // passes yet the decode still runs over the whole stream. Build a real
    // ~200 KB incompressible entry, then patch the central directory's
    // declared uncompressed size down to 1 byte — exactly what an attacker
    // controls, since fflate reads that field from the central directory.
    const payload = new Uint8Array(200_000);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 2654435761) & 0xff; // incompressible: stays ~200 KB
    }
    const bytes = zipSync({ "blobs/aa/smuggle.pdf": payload });

    // Central directory header signature: PK\x01\x02; declared uncompressed
    // size is the 4-byte LE field at offset +24 within that record.
    const sig = [0x50, 0x4b, 0x01, 0x02];
    let cdh = -1;
    for (let i = 0; i + 4 <= bytes.length; i += 1) {
      if (sig.every((b, k) => bytes[i + k] === b)) {
        cdh = i;
        break;
      }
    }
    expect(cdh).toBeGreaterThanOrEqual(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(cdh + 24, 1, true); // declared uncompressed size := 1

    expect(() => unzipBundle(bytes)).toThrow(BundleFormatError);
    expect(() => unzipBundle(bytes)).toThrow(/stores more than it declares/);
  });

  it("does not trip the ratio check on small, highly compressible entries", () => {
    // A 1 KB entry of zeroes has an enormous ratio but is harmless — the
    // floor exists so ordinary small files are never refused.
    const small = zipSync({ "claims.json": new Uint8Array(1024) });
    expect(() => unzipBundle(small)).not.toThrow();
  });
});

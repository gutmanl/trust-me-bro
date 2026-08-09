import { ChainAppender } from "../../chain/appender";
import { sha256Hex } from "../../chain/hash";
import type { ClaimsRegister } from "../register";
import exampleProject from "./example-project.json";

/**
 * Shared test fixture for the export epic: the appendix example project with
 * a REBUILT, gapless chain (the published example intentionally elides seq
 * 3–7) and REAL blob checksums, so chain closure and blob integrity are
 * actually checkable. Used by lib/export and cli tests alike.
 */

/** Deterministic blob contents whose real SHA-256 replaces the fixture's
 * placeholder checksums. */
export const FIXTURE_BLOBS = {
  briefing: Buffer.from("Das ist das eingefrorene Briefing.\n"),
  snapshot: Buffer.from("%PDF-1.4 snapshot bytes\n"),
  text: Buffer.from("median review time dropped\n"),
};

export function blobPathFor(content: Buffer, ext: string): string {
  const sha = sha256Hex(content);
  return `blobs/${sha.slice(0, 2)}/${sha}.${ext}`;
}

/** Every blob path the chained fixture references, with its content. */
export function fixtureBlobEntries(
  register: ClaimsRegister,
): [string, Buffer][] {
  return [
    [register.project.briefing_import!.blob_path, FIXTURE_BLOBS.briefing],
    [register.sources[0].custom.snapshot!.blob_path, FIXTURE_BLOBS.snapshot],
    [register.sources[0].custom.snapshot!.text_blob_path!, FIXTURE_BLOBS.text],
  ];
}

/** Chain-valid register with real blob checksums for FIXTURE_BLOBS. */
export function chainedFixture(): ClaimsRegister {
  const register = structuredClone(exampleProject) as unknown as ClaimsRegister;

  register.project.briefing_import = {
    ...register.project.briefing_import!,
    sha256: sha256Hex(FIXTURE_BLOBS.briefing),
    blob_path: blobPathFor(FIXTURE_BLOBS.briefing, "md"),
  };
  const snapshot = register.sources[0].custom.snapshot!;
  register.sources[0].custom.snapshot = {
    ...snapshot,
    sha256: sha256Hex(FIXTURE_BLOBS.snapshot),
    blob_path: blobPathFor(FIXTURE_BLOBS.snapshot, "pdf"),
    text_blob_path: blobPathFor(FIXTURE_BLOBS.text, "txt"),
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
  // Seal like the store does at commit: the fixture represents the current
  // format, whose entries carry the content state root.
  appender.seal(register);
  return register;
}

import {
  ClaimsRegister,
  latestChainLink,
  sha256FromBlobPath,
  sha256Hex,
  verifyChain,
} from "../register";
import type { ChainVerificationError } from "../register";
import { collectBlobPaths } from "./blob-refs";
import { Manifest, MANIFEST_PATH } from "./manifest";
import { bundleText } from "./zip";
import type { BundleFiles } from "./zip";

/**
 * The shared verification core over an unpacked bundle's in-memory file map.
 * Both the CLI (`tmb verify <bundle>`) and the web import call exactly this
 * function, so "identical behavior for directory and bundle" holds by
 * construction. Checks, in order: manifest presence/shape, checksum closure
 * (every listed file present and matching, no unlisted files), claims.json
 * schema, hash chain, chain-head commitment, and — for bundles with blobs —
 * blob integrity against the path-embedded snapshot checksums.
 */

export type BundleProblem =
  | { type: "missing_manifest" }
  | { type: "invalid_manifest"; detail: string }
  | { type: "missing_file"; path: string }
  | { type: "unlisted_file"; path: string }
  | { type: "checksum_mismatch"; path: string }
  | { type: "invalid_claims_json"; detail: string }
  | { type: "schema_violation"; detail: string }
  | { type: "chain_error"; error: ChainVerificationError }
  | {
      type: "chain_head_mismatch";
      manifest: { seq: number; hash: string };
      register: { seq: number; hash: string } | null;
    }
  | { type: "blob_checksum_mismatch"; path: string }
  | { type: "blob_unreferenced"; path: string };

export interface BundleVerification {
  ok: boolean;
  problems: BundleProblem[];
  manifest?: Manifest;
  register?: ClaimsRegister;
  chainEntryCount?: number;
}

export function describeBundleProblem(problem: BundleProblem): string {
  switch (problem.type) {
    case "missing_manifest":
      return "manifest.json fehlt im Bundle";
    case "invalid_manifest":
      return `manifest.json ist ungültig: ${problem.detail}`;
    case "missing_file":
      return `im Manifest gelistete Datei fehlt: ${problem.path}`;
    case "unlisted_file":
      return `Datei ohne Manifest-Eintrag im Bundle: ${problem.path}`;
    case "checksum_mismatch":
      return `Prüfsumme weicht vom Manifest ab: ${problem.path}`;
    case "invalid_claims_json":
      return `claims.json ist kein gültiges JSON: ${problem.detail}`;
    case "schema_violation":
      return `claims.json verletzt das Feldschema: ${problem.detail}`;
    case "chain_error":
      return `Hash-Kette verletzt (${problem.error.type}${
        "seq" in problem.error ? `, seq ${problem.error.seq}` : ""
      })`;
    case "chain_head_mismatch":
      return (
        `Kettenende weicht vom Manifest ab (Manifest: seq ${problem.manifest.seq}, ` +
        `Register: ${problem.register ? `seq ${problem.register.seq}` : "leer"})`
      );
    case "blob_checksum_mismatch":
      return `Blob-Inhalt widerspricht seiner Snapshot-Prüfsumme: ${problem.path}`;
    case "blob_unreferenced":
      return `Blob ohne Referenz im Register: ${problem.path}`;
  }
}

export function verifyBundleFiles(files: BundleFiles): BundleVerification {
  const problems: BundleProblem[] = [];

  // 1. Manifest presence and shape.
  const manifestBytes = files[MANIFEST_PATH];
  if (!manifestBytes) {
    return { ok: false, problems: [{ type: "missing_manifest" }] };
  }
  let manifest: Manifest;
  try {
    manifest = Manifest.parse(JSON.parse(bundleText.decode(manifestBytes)));
  } catch (error) {
    return {
      ok: false,
      problems: [{ type: "invalid_manifest", detail: String(error) }],
    };
  }

  // 2. Checksum closure between manifest and contained files.
  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const entry of manifest.files) {
    const content = files[entry.path];
    if (entry.included) {
      if (!content) {
        problems.push({ type: "missing_file", path: entry.path });
      } else if (sha256Hex(Buffer.from(content)) !== entry.sha256) {
        problems.push({ type: "checksum_mismatch", path: entry.path });
      }
    } else if (content) {
      // Listed as excluded (lean export) but present anyway: verify like an
      // included file would be.
      if (sha256Hex(Buffer.from(content)) !== entry.sha256) {
        problems.push({ type: "checksum_mismatch", path: entry.path });
      }
    }
  }
  for (const path of Object.keys(files)) {
    if (path !== MANIFEST_PATH && !listed.has(path)) {
      problems.push({ type: "unlisted_file", path });
    }
  }

  // 3. claims.json: JSON, schema, chain, chain-head commitment.
  const claimsBytes = files["claims.json"];
  if (!claimsBytes) {
    // Already reported as missing_file via the manifest loop; stop here —
    // nothing register-based can be checked.
    return { ok: false, problems, manifest };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bundleText.decode(claimsBytes));
  } catch (error) {
    problems.push({ type: "invalid_claims_json", detail: String(error) });
    return { ok: false, problems, manifest };
  }
  const parsed = ClaimsRegister.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    problems.push({ type: "schema_violation", detail });
    return { ok: false, problems, manifest };
  }
  const register = parsed.data;

  const chainResult = verifyChain(register);
  if (!chainResult.ok) {
    for (const error of chainResult.errors) {
      problems.push({ type: "chain_error", error });
    }
  }
  const head = latestChainLink(register) ?? null;
  if (
    !head ||
    head.seq !== manifest.chain_head.seq ||
    head.hash !== manifest.chain_head.hash
  ) {
    problems.push({
      type: "chain_head_mismatch",
      manifest: manifest.chain_head,
      register: head ? { seq: head.seq, hash: head.hash } : null,
    });
  }

  // 4. Blob integrity: contained blobs must match their path-embedded
  // checksum, every register-referenced blob must at least be listed, and
  // contained blobs must be referenced by the register.
  const referenced = new Set(collectBlobPaths(register));
  for (const path of Object.keys(files)) {
    if (!path.startsWith("blobs/")) {
      continue;
    }
    let expected: string;
    try {
      expected = sha256FromBlobPath(path);
    } catch {
      problems.push({ type: "blob_checksum_mismatch", path });
      continue;
    }
    if (sha256Hex(Buffer.from(files[path])) !== expected) {
      problems.push({ type: "blob_checksum_mismatch", path });
    }
    if (!referenced.has(path)) {
      problems.push({ type: "blob_unreferenced", path });
    }
  }
  for (const path of referenced) {
    if (!listed.has(path)) {
      problems.push({ type: "missing_file", path });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    manifest,
    register,
    chainEntryCount: chainResult.entryCount,
  };
}

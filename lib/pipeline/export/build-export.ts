import fs from "node:fs";
import path from "node:path";

import {
  buildManifest,
  bundleText,
  MANIFEST_PATH,
  serializeManifest,
  verifyBundleFiles,
  zipBundle,
} from "../../export";
import type { BundleFiles } from "../../export";
import { collectBlobPaths } from "../../export";
import {
  ClaimsRegister,
  latestChainLink,
  sha256FromBlobPath,
} from "../../register";
import { requireProjectStore } from "../projects";
import { briefingRenderContext } from "../research/independence";
import { buildProvDocument } from "./prov";
import { buildReferencesCsl } from "./references";
import {
  buildTracesAggregate,
  readTraceEnvelopes,
  readTraceFiles,
} from "./traces";

/**
 * TMB-39: builds the single export artifact
 * `trustmebro-export_<project>_<timestamp>.tmb` (ZIP container) with
 * manifest.json, claims.json, briefing.md, schema/, traces/, derived/ and —
 * unless a lean export is requested — blobs/. claims.json travels as the
 * verbatim on-disk bytes (never re-serialized), which is what makes the
 * export→import roundtrip byte-identical. Before zipping, the bundle is
 * checked with the same verification core imports and the CLI use — a
 * failing self-check is a bug, not user input, and crashes accordingly.
 */

export interface ExportBundleResult {
  filename: string;
  bytes: Uint8Array;
}

/** A bundle that fails its own verification was mis-built — programming
 * error, deliberately NOT a PipelineError (no user-facing mapping). */
export class ExportIntegrityError extends Error {
  constructor(details: string[]) {
    super(`export bundle failed its self-check: ${details.join("; ")}`);
    this.name = new.target.name;
  }
}

const serializeJson = (value: unknown): Uint8Array =>
  bundleText.encode(`${JSON.stringify(value, null, 2)}\n`);

export async function exportProjectBundle(
  projectId: string,
  options: { includeBlobs: boolean },
): Promise<ExportBundleResult> {
  const store = requireProjectStore(projectId);

  // claims.json is read ONCE and the register parsed from those exact bytes
  // — no window for a divergent second read between raw bytes and register.
  const claimsBytes = fs.readFileSync(store.claimsPath);
  const register = ClaimsRegister.parse(
    JSON.parse(claimsBytes.toString("utf8")),
  );

  const files: BundleFiles = {
    "claims.json": new Uint8Array(claimsBytes),
    "schema/claims.schema.json": new Uint8Array(
      fs.readFileSync(
        path.join(store.projectDir, "schema", "claims.schema.json"),
      ),
    ),
  };
  if (register.project.briefing_import) {
    files["briefing.md"] = bundleText.encode(
      await store.renderBriefingFile(briefingRenderContext(register)),
    );
  }

  for (const { name, content } of readTraceFiles(store.projectDir)) {
    files[`traces/${name}`] = new Uint8Array(content);
  }

  const blobPaths = collectBlobPaths(register);
  const excludedBlobs: { path: string; sha256: string }[] = [];
  if (options.includeBlobs) {
    const blobs = store.blobs();
    for (const blobPath of blobPaths) {
      files[blobPath] = new Uint8Array(blobs.read(blobPath));
    }
  } else {
    for (const blobPath of blobPaths) {
      excludedBlobs.push({
        path: blobPath,
        sha256: sha256FromBlobPath(blobPath),
      });
    }
  }

  const envelopes = readTraceEnvelopes(store.projectDir);
  files["derived/references.csl.json"] = serializeJson(
    buildReferencesCsl(register),
  );
  files["derived/prov.jsonld"] = serializeJson(
    buildProvDocument(register, envelopes),
  );
  files["derived/traces.json"] = serializeJson(
    buildTracesAggregate(register, envelopes),
  );

  const chainHead = latestChainLink(register);
  if (!chainHead) {
    throw new ExportIntegrityError(["register has an empty chain"]);
  }
  const exportedAt = new Date().toISOString();
  const manifest = buildManifest({
    files,
    excludedBlobs,
    schemaVersion: register.schema_version,
    innerId: register.project.id,
    directoryName: projectId,
    exportedAt,
    chainHead,
    includesBlobs: options.includeBlobs,
  });
  const bundle: BundleFiles = {
    ...files,
    [MANIFEST_PATH]: bundleText.encode(serializeManifest(manifest)),
  };

  const verification = verifyBundleFiles(bundle);
  if (!verification.ok) {
    throw new ExportIntegrityError(
      verification.problems.map((problem) => JSON.stringify(problem)),
    );
  }

  return {
    filename: buildExportFilename(projectId, exportedAt),
    bytes: zipBundle(bundle, exportedAt),
  };
}

/** `trustmebro-export_<project>_<timestamp>.tmb`, timestamp compacted the
 * same way trace filenames are (NTFS-safe, sorts chronologically). */
export function buildExportFilename(
  projectId: string,
  exportedAt: string,
): string {
  const compact = exportedAt.replace(/[-:.]/g, "");
  return `trustmebro-export_${projectId}_${compact}.tmb`;
}

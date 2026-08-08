/**
 * Public surface of the .tmb bundle core (epic TMB-6): manifest, in-memory
 * ZIP pack/unpack and the shared bundle verification. Depends only on the
 * register's public surface — deliberately free of lib/pipeline and
 * lib/adapters, so the standalone CLI can use it without pulling in the web
 * application's use-case layer.
 */
export { BundleFormatError } from "./errors";
export { assertSafeRelativePath } from "./safe-path";
export { bundleText, unzipBundle, zipBundle } from "./zip";
export type { BundleFiles } from "./zip";
export {
  buildManifest,
  Manifest,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  serializeManifest,
} from "./manifest";
export type { BuildManifestInput, ManifestFileEntry } from "./manifest";
export { collectBlobPaths } from "./blob-refs";
export { describeBundleProblem, verifyBundleFiles } from "./verify-bundle";
export type { BundleProblem, BundleVerification } from "./verify-bundle";
export { writeBundleToDirectory } from "./write-bundle";

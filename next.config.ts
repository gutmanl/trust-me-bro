import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TMB-48: the npm package ships a self-contained standalone server. Only
  // the packaging build (scripts/package-build.mjs) sets the flag — the
  // everyday dev loop (next dev / next build / next start) keeps the
  // regular output, which `next start` requires.
  ...(process.env.TMB_BUILD_TARGET === "package"
    ? {
        output: "standalone" as const,
        // S-05: the tarball used to be assembled purely by Next's tracing,
        // which swept in test suites, coverage output, TypeScript sources and
        // — when a workspace directory sits under the repo root — real user
        // project data. Tracing stays, but never reaches these.
        // scripts/prepare-standalone.mjs prunes the same set again after the
        // copy; the two guards are deliberately redundant.
        // The key is a route matcher: "*" matches every route, while the
        // previous "/*" only matched single-segment routes — every deeper
        // route (e.g. /projects/[id]/workbench) kept tracing the excluded
        // set in, and the prepare-standalone guard refused to pack whenever
        // the dev workspace sat under the repo root.
        outputFileTracingExcludes: {
          "*": [
            "**/coverage/**",
            "**/tests/**",
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/__fixtures__/**",
            "**/workspace/**",
            "**/.git/**",
          ],
        },
      }
    : {}),
  experimental: {
    serverActions: {
      // .tmb bundle upload (TMB-40): bundles with blobs exceed the 1 MB
      // server-action default.
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;

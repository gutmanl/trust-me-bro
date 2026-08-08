import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TMB-48: the npm package ships a self-contained standalone server. Only
  // the packaging build (scripts/package-build.mjs) sets the flag — the
  // everyday dev loop (next dev / next build / next start) keeps the
  // regular output, which `next start` requires.
  ...(process.env.TMB_BUILD_TARGET === "package"
    ? { output: "standalone" as const }
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

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // .tmb bundle upload (TMB-40): bundles with blobs exceed the 1 MB
      // server-action default.
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;

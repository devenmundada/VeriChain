import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
  turbopack: {},
  webpack: (config, { isServer }) => {
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });

    // Add loader to inject /* webpackIgnore: true */ into SDK bridge files
    // so their dynamic import() calls use native browser import, not webpack's.
    if (!isServer) {
      const loaderPath = path.resolve(process.cwd(), "scripts", "wasm-import-loader.cjs");
      config.module.rules.push({
        test: /LlamaCppBridge\.js$|SherpaONNXBridge\.js$|VLMWorkerRuntime\.js$/,
        enforce: "pre" as const,
        use: [{ loader: loaderPath }],
      });
    }

    return config;
  },
};

export default nextConfig;

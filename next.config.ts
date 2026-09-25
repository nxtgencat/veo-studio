import type { NextConfig } from "next";

// Browser calls same-origin /api/*; Next forwards to the backend (/api stripped).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787";

const nextConfig: NextConfig = {
  // Required for Docker: emits `.next/standalone` (minimal server + traced deps).
  // See https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiTarget}/:path*` }];
  },
};

export default nextConfig;

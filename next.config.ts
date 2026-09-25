import type { NextConfig } from "next";

// Same-origin /api/* proxy (dev): the browser calls this app's origin and Next
// forwards to the backend, so the httpOnly session cookie flows with no CORS.
// Destination is env-only (never request-derived). No rewrite when both unset
// (prod: the gateway owns /api/*).
const apiBase = process.env.NEXT_PUBLIC_API_PROXY || process.env.NEXT_PUBLIC_API_BASE;

const nextConfig: NextConfig = {
  async rewrites() {
    if (apiBase === undefined || apiBase === "") {
      return [];
    }
    return [{ source: "/api/:path*", destination: `${apiBase}/api/:path*` }];
  },
};

export default nextConfig;

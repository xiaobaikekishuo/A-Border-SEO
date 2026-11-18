import type { NextConfig } from "next";
import { APP_REDIRECTS } from "./lib/redirects";

const nextConfig: NextConfig = {
  // standalone is for Docker; Vercel uses its own output
  output: process.env.VERCEL ? undefined : "standalone",
  async redirects() {
    return APP_REDIRECTS;
  },
  async headers() {
    return [{
      source: "/desktop/oauth/login",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }];
  },
};

export default nextConfig;

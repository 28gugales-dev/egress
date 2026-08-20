import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["react-map-gl"],
  // Dev-only chrome, but it lands bottom-left on top of the scrubber's Ignition
  // caption — the one tick label the timeline cannot afford to lose.
  devIndicators: { position: "bottom-right" },
  /**
   * Simulation payloads are large static JSON, but they are NOT immutable: every
   * `pnpm data:simulate` rewrites them under the same URL. `immutable` told the
   * browser never to revalidate, so a regenerated run kept serving the previous
   * numbers through a hard reload — the console reported a clearance the files on
   * disk no longer contained. Revalidate instead: the payloads are unchanged most
   * of the time, so this is a 304 in the common case and costs nothing.
   */
  async headers() {
    return [
      {
        source: "/data/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;

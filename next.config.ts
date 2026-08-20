import type { NextConfig } from "next";

// Empty string, never "/": Next treats a lone slash as an invalid basePath.
const BASE_PATH = process.env.BASE_PATH ?? "";

// The deploy workflow sets this; a local `pnpm build` stays a normal server build.
const EXPORT = process.env.NEXT_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["react-map-gl"],
  // Dev-only chrome, but it lands bottom-left on top of the scrubber's Ignition
  // caption — the one tick label the timeline cannot afford to lose.
  devIndicators: { position: "bottom-right" },
  /**
   * GitHub Pages serves a project site from /<repo>/, so every emitted asset URL
   * needs that prefix. Set BASE_PATH in the deploy workflow; unset locally and on
   * any root-served host, where these must stay empty rather than "/".
   */
  basePath: BASE_PATH,
  assetPrefix: BASE_PATH || undefined,
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  /**
   * Pages has no Node server, so the whole console is prerendered to static
   * files. Nothing here is dynamic: two routes, no server actions, no route
   * handlers — the scenario payloads are already plain JSON under public/.
   */
  ...(EXPORT ? ({ output: "export", images: { unoptimized: true } } as const) : {}),
  /**
   * Simulation payloads are large static JSON, but they are NOT immutable: every
   * `pnpm data:simulate` rewrites them under the same URL. `immutable` told the
   * browser never to revalidate, so a regenerated run kept serving the previous
   * numbers through a hard reload — the console reported a clearance the files on
   * disk no longer contained. Revalidate instead: the payloads are unchanged most
   * of the time, so this is a 304 in the common case and costs nothing.
   *
   * `headers()` is a no-op under `output: "export"` (a static host sets its own),
   * so it is declared only when we are NOT exporting, which also silences the
   * build warning that would otherwise scroll past every real one.
   */
  ...(EXPORT
    ? {}
    : {
        async headers() {
          return [
            {
              source: "/data/:path*",
              headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
            },
          ];
        },
      }),
};

export default nextConfig;

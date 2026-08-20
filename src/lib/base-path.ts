/**
 * Prefix for every runtime-fetched static payload.
 *
 * Next rewrites `basePath` into `<Link>`, `<Image>` and the build's own asset
 * URLs, but it does NOT touch strings handed to `fetch()` — those are opaque to
 * the compiler. On a project GitHub Pages site the app is served from
 * `/egress/`, so a literal `/data/...` resolves against the domain root and
 * 404s while the page itself loads fine. Every payload URL goes through here.
 *
 * Empty in dev and on any root-served deploy, so the emitted URL is unchanged.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Absolute URL for a path rooted at the site's public/ directory. */
export function asset(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

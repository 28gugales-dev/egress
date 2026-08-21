"use client";

import { useEffect, useState } from "react";
import { asset } from "@/lib/base-path";

/**
 * Which OPTIONAL payloads a scenario actually carries.
 *
 * Four scenarios ship, and they are not equal. Camp Fire and Palisades carry a
 * hazard field, context imagery and block-level detail; Marshall and Conyers
 * carry none of the three. The map already handles that correctly — every one
 * of those loaders returns null on a miss and draws nothing rather than
 * inventing a substitute — but handling it correctly and SAYING so are
 * different things, and until this module existed the console did neither
 * loudly: a judge who picked Marshall got a visibly barer map and no statement
 * anywhere as to why.
 *
 * CLAUDE.md: volunteer the seam. Hiding it and getting caught ends the demo.
 *
 * PROBED, NOT DECLARED. A hardcoded table of which scenario has what would be a
 * second source of truth that goes stale the first time someone reruns a
 * pipeline script, and the failure mode is the console confidently describing
 * coverage it does not have. These are HEAD requests, so a present hazard field
 * costs its headers rather than its several megabytes.
 *
 * A 404 here is the ANSWER, not an error — the network panel shows three of
 * them on Marshall and that is the module working. The map's own loaders would
 * have made the same requests on their own gates regardless; this one just asks
 * early enough to put the result on screen.
 */

export interface ScenarioCoverage {
  /** Per-cell arrival raster behind hazard ETA shading. */
  hazardField: boolean;
  /** context/index.json — the imagery and reference rasters. */
  context: boolean;
  /** detail/blocks.json — block and building geometry, zoom-gated on the map. */
  detail: boolean;
}

const PROBES: { key: keyof ScenarioCoverage; path: (id: string) => string }[] = [
  { key: "hazardField", path: (id) => `/data/${id}/hazard-field.json` },
  { key: "context", path: (id) => `/data/${id}/context/index.json` },
  { key: "detail", path: (id) => `/data/${id}/detail/blocks.json` },
];

const cache = new Map<string, ScenarioCoverage>();
const inflight = new Map<string, Promise<ScenarioCoverage>>();

async function probe(scenarioId: string): Promise<ScenarioCoverage> {
  const cached = cache.get(scenarioId);
  if (cached) return cached;
  const pending = inflight.get(scenarioId);
  if (pending) return pending;

  const p = (async () => {
    const results = await Promise.all(
      PROBES.map(async ({ key, path }) => {
        try {
          const res = await fetch(asset(path(scenarioId)), {
            method: "HEAD",
            cache: "force-cache",
          });
          return [key, res.ok] as const;
        } catch {
          /* A network failure and a 404 mean the same thing to a reader: the
             layer is not going to draw. Reporting "unknown" for one and
             "absent" for the other would be a distinction the screen cannot
             act on. */
          return [key, false] as const;
        }
      }),
    );
    const out = { hazardField: false, context: false, detail: false } as ScenarioCoverage;
    for (const [key, ok] of results) out[key] = ok;
    cache.set(scenarioId, out);
    return out;
  })().finally(() => inflight.delete(scenarioId));

  inflight.set(scenarioId, p);
  return p;
}

/**
 * Null until the probes land. Rendering "absent" during the wait would flash a
 * false negative on every scenario switch, and absent is the claim this module
 * exists to make carefully.
 */
export function useScenarioCoverage(scenarioId: string): ScenarioCoverage | null {
  const [coverage, setCoverage] = useState<ScenarioCoverage | null>(
    () => cache.get(scenarioId) ?? null,
  );

  useEffect(() => {
    let live = true;
    setCoverage(cache.get(scenarioId) ?? null);
    probe(scenarioId).then((c) => {
      if (live) setCoverage(c);
    });
    return () => {
      live = false;
    };
  }, [scenarioId]);

  return coverage;
}

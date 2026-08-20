/**
 * fetch-evac-zones.ts — pull the county's OFFICIAL published evacuation zones.
 *
 *   npx tsx scripts/fetch-evac-zones.ts [scenarioId] [--refresh]
 *
 * The product's positioning is that Egress emits a release sequence keyed to the
 * zone ids the county ALREADY runs, so the output pastes into the tool already on
 * the wall. That is only literally true if the ids are theirs. Butte County
 * publishes its zone polygons as keyless, CORS-open GeoJSON, so for Camp Fire we
 * take BUT-TOP-01 verbatim instead of inventing PAR-E001.
 *
 * Resolution order, loudest-first about which one ran:
 *   1. scripts/.cache/  — prior raw response (zone boundaries change on the order
 *      of years, so a cache hit is the normal path; --refresh forces the network)
 *   2. the live FeatureServer
 *   3. research/snapshots/ — the committed, verified snapshot
 *
 * Only scenarios listed in OFFICIAL_ZONE_SOURCES have a real published layer.
 * For anything else this exits 0 having written nothing: build-zones.ts then
 * falls back to deriving zones by egress-corridor clustering. There is no path
 * in this file that fabricates a zone polygon.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getScenario } from "../src/lib/constants";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "scripts", ".cache");

const USER_AGENT = "egress-evac-planner/0.1 (evacuation clearance-time research tool)";

// ─────────────────────────────────────────────────────────────────────────────
// Sources — one entry per scenario whose county actually publishes zones
// ─────────────────────────────────────────────────────────────────────────────

interface OfficialZoneSource {
  label: string;
  /** ArcGIS FeatureServer layer query endpoint. */
  url: string;
  where: string;
  outFields: string;
  /** Committed verified snapshot, relative to repo root. */
  snapshot: string;
  /** Property carrying the county's own zone id. */
  idField: string;
  attribution: string;
}

/**
 * Verified live in research/endpoint-verification.md: HTTP 200, 46 features,
 * keyless, CORS-open. The Community filter is what scopes the statewide-shaped
 * layer down to the Camp Fire footprint.
 */
const OFFICIAL_ZONE_SOURCES: Record<string, OfficialZoneSource> = {
  "camp-fire-2018": {
    label: "Butte County ButteEvacuationZones_2_view",
    url: "https://services.arcgis.com/3t3QfTXFRFX44zo8/arcgis/rest/services/ButteEvacuationZones_2_view/FeatureServer/0/query",
    where: "Community IN ('Town of Paradise','Paradise East','Magalia','Concow','Butte Valley')",
    outFields: "*",
    snapshot: "research/snapshots/butte-evac-zones.geojson",
    idField: "Zone",
    attribution: "Butte County OEM evacuation zones (ArcGIS FeatureServer, keyless)",
  },
  // palisades-fire-2025 is deliberately absent even though a real published
  // layer exists and was verified live — LA County DPH's Evacuation_Zones_Jan_13_2025,
  // the Genasys/Zonehaven zones as they stood during the fire, snapshotted at
  // research/snapshots/la-evac-zones-2025-01-13.geojson.
  //
  // It is not consumed because Los Angeles held the entire community in ONE
  // zone: LOS-Q0767, 19,634 acres, 30,447 people, a single Evacuation Order.
  // Feeding that to build-zones would produce a release sequence with one wave
  // carrying 65% of the load — which is exactly what happened, and exactly why
  // there is nothing left to stage. The derived-zone path runs instead, and the
  // official zone is reported beside it as the honest cross-check.
};

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

interface ZoneFeature {
  type: "Feature";
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

interface ZoneCollection {
  type: string;
  features: ZoneFeature[];
  /** ArcGIS sets this when the layer's max record count truncated the result. */
  exceededTransferLimit?: boolean;
  /** ArcGIS reports query errors in-band with HTTP 200. */
  error?: { code: number; message: string; details?: string[] };
}

function log(msg: string): void {
  console.log(`[evac-zones] ${msg}`);
}

function loud(msg: string): void {
  console.warn(`\n**** FALLBACK PATH **** ${msg}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────

function queryUrl(src: OfficialZoneSource): string {
  const params = new URLSearchParams({
    where: src.where,
    outFields: src.outFields,
    outSR: "4326",
    returnGeometry: "true",
    f: "geojson",
  });
  return `${src.url}?${params.toString()}`;
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const delays = [500, 1500, 4000];
  let lastErr: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      // A 4xx that is not rate limiting will not fix itself on retry.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        throw new Error(
          `${label}: HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 300)}`,
        );
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) break;
      log(
        `  retry ${attempt + 1}/${delays.length} for ${label} in ${delays[attempt]}ms — ${(err as Error).message}`,
      );
      await sleep(delays[attempt]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Rejects anything that is not a usable zone layer. A FeatureCollection with
 * zero features, or with features carrying no county id, is a silent-failure
 * shape: it would write a valid-looking file that erases every zone downstream.
 */
function validate(raw: unknown, src: OfficialZoneSource, origin: string): ZoneCollection {
  const fc = raw as ZoneCollection | null;
  if (!fc || typeof fc !== "object") throw new Error(`${origin}: response is not an object`);
  if (fc.error) throw new Error(`${origin}: ArcGIS error ${fc.error.code} — ${fc.error.message}`);
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error(`${origin}: not a GeoJSON FeatureCollection (type=${String(fc.type)})`);
  }
  if (fc.features.length === 0) throw new Error(`${origin}: FeatureCollection has zero features`);

  const withId = fc.features.filter(
    (f) => f.geometry != null && typeof f.properties?.[src.idField] === "string",
  );
  if (withId.length === 0) {
    throw new Error(`${origin}: no feature carries a "${src.idField}" id with geometry`);
  }
  if (withId.length < fc.features.length) {
    log(
      `  warn: ${fc.features.length - withId.length} feature(s) lack ${src.idField}/geometry — dropped`,
    );
  }
  return { ...fc, features: withId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const refresh = process.argv.includes("--refresh");
  const scenario = getScenario(scenarioId);
  if (scenario.id !== scenarioId) {
    console.warn(`[evac-zones] unknown scenario "${scenarioId}" — falling back to ${scenario.id}`);
  }

  const src = OFFICIAL_ZONE_SOURCES[scenario.id];
  if (!src) {
    log(
      `no official evacuation zone layer is configured for "${scenario.id}" (${scenario.place}). ` +
        `Nothing written — build-zones.ts will derive zones by egress corridor instead. ` +
        `Add an entry to OFFICIAL_ZONE_SOURCES once a published layer for this county is verified.`,
    );
    return;
  }

  log(`scenario ${scenario.id} — ${scenario.place}`);
  log(`source ${src.label}`);

  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `evaczones-${scenario.id}.json`);
  const snapshotPath = join(ROOT, src.snapshot);
  const url = queryUrl(src);

  let fc: ZoneCollection | null = null;
  let provenance = "";

  if (!refresh && existsSync(cachePath)) {
    try {
      fc = validate(JSON.parse(readFileSync(cachePath, "utf8")), src, "cache");
      provenance = `cache (${cachePath}) — pass --refresh to force a live fetch`;
      log(`cache hit  evaczones-${scenario.id}`);
    } catch (err) {
      log(`cache at ${cachePath} is unusable (${(err as Error).message}) — refetching`);
      fc = null;
    }
  }

  if (!fc) {
    log(`GET ${url}`);
    try {
      const raw = await fetchJson(url, src.label);
      fc = validate(raw, src, "live");
      writeFileSync(cachePath, JSON.stringify(raw));
      log(
        `cache miss evaczones-${scenario.id} — raw response stored (${statSync(cachePath).size} bytes)`,
      );
      provenance = `LIVE ${src.label}`;
      if (fc.exceededTransferLimit) {
        console.warn(
          `[evac-zones] warn: exceededTransferLimit is set — the layer returned a TRUNCATED zone list ` +
            `(${fc.features.length} features). Zones beyond the server's max record count are MISSING.`,
        );
      }
    } catch (err) {
      loud(
        `the live fetch of ${src.label} FAILED (${(err as Error).message}). ` +
          `Substituting the committed snapshot at ${src.snapshot}, which was verified live but is ` +
          `frozen at its commit date — if the county has redrawn a zone since, this output is stale. ` +
          `Nothing here is invented: these are still the county's real polygons and real ids.`,
      );
      if (!existsSync(snapshotPath)) {
        console.error(
          `[evac-zones] FATAL: the network failed AND no snapshot exists at ${snapshotPath}. ` +
            `Refusing to write a zone file rather than fabricate one.`,
        );
        process.exit(1);
      }
      fc = validate(JSON.parse(readFileSync(snapshotPath, "utf8")), src, "snapshot");
      provenance = `SNAPSHOT ${src.snapshot} (live fetch failed)`;
    }
  }

  // ── emit ────────────────────────────────────────────────────────────────────
  const dataDir = join(ROOT, "public", "data", scenario.id);
  mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, "official-zones.geojson");

  const out = {
    type: "FeatureCollection",
    features: fc.features,
    // Downstream and the demo both need to say where these came from out loud.
    egress: {
      scenarioId: scenario.id,
      source: src.label,
      attribution: src.attribution,
      idField: src.idField,
      provenance,
      query: url,
      featureCount: fc.features.length,
      fetchedAt: new Date().toISOString(),
    },
  };
  writeFileSync(outPath, JSON.stringify(out));
  log(`wrote ${outPath} (${fc.features.length} zones, ${statSync(outPath).size} bytes)`);
  log(`provenance: ${provenance}`);

  // ── report ──────────────────────────────────────────────────────────────────
  const byCommunity = new Map<string, { n: number; structures: number; ids: string[] }>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const community = typeof p.Community === "string" ? p.Community : "(no Community)";
    const structures = typeof p.StructureC === "number" ? p.StructureC : 0;
    const id = String(p[src.idField]);
    const cur = byCommunity.get(community);
    if (cur) {
      cur.n++;
      cur.structures += structures;
      cur.ids.push(id);
    } else {
      byCommunity.set(community, { n: 1, structures, ids: [id] });
    }
  }

  console.log("");
  console.log(`${"COMMUNITY".padEnd(20)}${"ZONES".padStart(6)}${"STRUCTURES".padStart(12)}  IDS`);
  console.log("-".repeat(78));
  let totalStructures = 0;
  for (const [community, v] of [...byCommunity].sort((a, b) => b[1].structures - a[1].structures)) {
    totalStructures += v.structures;
    const ids = v.ids.slice().sort();
    const shown =
      ids.length > 4 ? `${ids.slice(0, 3).join(", ")}, … ${ids[ids.length - 1]}` : ids.join(", ");
    console.log(
      `${community.padEnd(20)}${String(v.n).padStart(6)}${String(v.structures).padStart(12)}  ${shown}`,
    );
  }
  console.log("-".repeat(78));
  console.log(
    `${"TOTAL".padEnd(20)}${String(fc.features.length).padStart(6)}${String(totalStructures).padStart(12)}`,
  );
  log("next: npx tsx scripts/build-zones.ts " + scenario.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

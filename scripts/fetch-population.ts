/**
 * Build PopulationLayer from US Census ACS 5-year data + TIGERweb geometry.
 *
 *   pnpm tsx scripts/fetch-population.ts [scenarioId]
 *
 * Two ACS transports, in preference order:
 *   1. api.census.gov  — requires CENSUS_API_KEY. As of 2025 the keyless quota
 *      is gone: a keyless call 302s to a "Missing Key" HTML page, so there is
 *      no point attempting it.
 *   2. data.census.gov/api/access/data/table — the endpoint the public
 *      data.census.gov UI calls. Keyless, same ACS estimates, same variable
 *      ids, returns whole tables for a summary level under a county.
 *
 * Not every table is published at block group. B18101 (disability) and C16001
 * (detailed language) stop at tract, so those two are fetched at tract and
 * apportioned down by the block group's share of tract population. That is a
 * derivation from real estimates, not synthesis, and it is logged as such.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getScenario } from "../src/lib/constants";
import type { LngLat, PopulationCell, PopulationLayer, ScenarioMeta } from "../src/types/egress";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CACHE_DIR = join(HERE, ".cache");

const ACS_DATASET = "acs5";

/**
 * ACS 5-year vintage per scenario — the last release that ENDS before the
 * event. Camp Fire is the reason this exists: the 2018-2022 release averages a
 * Paradise that burned down (26.5k -> ~6k), so it describes the aftermath, not
 * the town that had to evacuate. 2013-2017 is the last pre-fire window.
 */
const ACS_VINTAGE: Record<string, number> = {
  "camp-fire-2018": 2017,
  "conyers-plume-2024": 2022,
  "marshall-fire-2021": 2022,
  // 2019-2023 is the last release ending before the 7 Jan 2025 fire.
  "palisades-fire-2025": 2023,
};
const DEFAULT_ACS_YEAR = 2022;

/** TIGERweb layer ids move between vintages; used only if lookup-by-name fails. */
const TIGER_LAYER_FALLBACK: Record<number, { bg: number; county: number }> = {
  2017: { bg: 10, county: 84 },
  2022: { bg: 8, county: 78 },
  2023: { bg: 10, county: 82 },
};

// Set once in main(), from the scenario's vintage.
let acsYear = DEFAULT_ACS_YEAR;
let tigerService = "";
let tigerLayers = TIGER_LAYER_FALLBACK[2022];

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Ramer-Douglas-Peucker tolerance in degrees. ~11 m at this latitude. */
const SIMPLIFY_TOLERANCE = 0.0001;

/** ACS jam values (-666666666 and friends) mean "not computable", not a count. */
const ACS_JAM_FLOOR = -100000;

// Only used when TIGERweb's county lookup is unreachable. Matches the counties
// the three scenario bboxes actually sit in.
const COUNTY_FALLBACK: Record<string, County[]> = {
  "camp-fire-2018": [{ state: "06", county: "007", name: "Butte County, California" }],
  "conyers-plume-2024": [{ state: "13", county: "247", name: "Rockdale County, Georgia" }],
  "marshall-fire-2021": [{ state: "08", county: "013", name: "Boulder County, Colorado" }],
  "palisades-fire-2025": [{ state: "06", county: "037", name: "Los Angeles County, California" }],
};

interface County {
  state: string;
  county: string;
  name: string;
}

type AcsRow = Record<string, number>;
/** GEOID (no summary-level prefix) -> estimate values. */
type AcsTable = Map<string, AcsRow>;

interface BlockGroupGeom {
  geoid: string;
  county: string;
  state: string;
  centroid: LngLat;
  rings: LngLat[][];
  areaLand: number;
}

let warnings = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

function log(stage: string, msg: string): void {
  console.log(`[population] ${stage.padEnd(11)} ${msg}`);
}

function loud(msg: string): void {
  warnings += 1;
  console.warn(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  console.warn(`!! SYNTHETIC DATA: ${msg}`);
  console.warn(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
}

function warn(msg: string): void {
  warnings += 1;
  console.warn(`[population] WARNING     ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch with cache + backoff
// ─────────────────────────────────────────────────────────────────────────────

interface FetchOpts {
  body?: string;
  /** Skip the cache read but still write. */
  refresh?: boolean;
  retries?: number;
  timeoutMs?: number;
}

function cachePath(url: string, body?: string): string {
  const h = createHash("sha1")
    .update(url + (body ?? ""))
    .digest("hex")
    .slice(0, 16);
  const host = new URL(url).hostname.split(".").slice(-3, -1).join("-");
  return join(CACHE_DIR, `${host}-${h}.json`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const file = cachePath(url, opts.body);
  if (!opts.refresh) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      // cold cache
    }
  }

  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: opts.body ? "POST" : "GET",
        body: opts.body,
        headers: {
          "User-Agent": "egress-evac-pipeline/0.1 (research prototype)",
          ...(opts.body ? { "Content-Type": "text/plain" } : {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      if (!text.trim()) throw new Error("empty body");
      if (text.trimStart().startsWith("<")) {
        // api.census.gov serves an HTML "Missing Key" page instead of a 4xx.
        throw new Error(`HTML response (likely missing API key): ${text.slice(0, 80)}`);
      }
      const parsed = JSON.parse(text) as T;
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(parsed));
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable resolution — read the group metadata, never hand-type an id
// ─────────────────────────────────────────────────────────────────────────────

interface GroupVar {
  id: string;
  label: string;
  /** Label split on "!!" with the leading "Estimate" dropped. */
  parts: string[];
}

async function loadGroup(table: string): Promise<GroupVar[]> {
  const url = `https://api.census.gov/data/${acsYear}/acs/${ACS_DATASET}/groups/${table}.json`;
  const raw = await fetchJson<{ variables: Record<string, { label: string }> }>(url);
  return Object.entries(raw.variables)
    .filter(([id]) => id.startsWith(`${table}_`) && /_\d+E$/.test(id))
    .map(([id, v]) => ({
      id,
      label: v.label,
      parts: v.label
        .split("!!")
        .slice(1)
        .map((s) => s.replace(/:$/, "")),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const leaf = (v: GroupVar) => v.parts[v.parts.length - 1] ?? "";

interface Vars {
  noVehicle: string[];
  /** [variableId, vehiclesPerHousehold] for the household-vehicle weighting. */
  vehicleBuckets: [string, number][];
  age65: string[];
  disability: string[];
  limitedEnglish: string[];
  mobileHome: string;
  /** [variableId, ISO 639-1 code] for the top-level language groups. */
  languageGroups: [string, string][];
}

/** Census label fragment -> ISO 639-1. Groups with no single code are dropped. */
const LANG_ISO: [RegExp, string][] = [
  [/^Spanish$/, "es"],
  [/^French, Haitian, or Cajun$/, "fr"],
  [/^German or other West Germanic/, "de"],
  [/^Russian, Polish, or other Slavic/, "ru"],
  [/^Korean$/, "ko"],
  [/^Chinese/, "zh"],
  [/^Vietnamese$/, "vi"],
  [/^Tagalog/, "tl"],
  [/^Arabic$/, "ar"],
];

async function resolveVariables(): Promise<Vars> {
  const [b25044, b01001, b18101, c16002, c16001, b25024] = await Promise.all(
    ["B25044", "B01001", "B18101", "C16002", "C16001", "B25024"].map(loadGroup),
  );

  const noVehicle = b25044.filter((v) => leaf(v) === "No vehicle available").map((v) => v.id);

  const vehicleBuckets: [string, number][] = [];
  for (const v of b25044) {
    const m = /^(\d+) vehicles? available$/.exec(leaf(v));
    if (m) vehicleBuckets.push([v.id, Number(m[1])]);
    // "5 or more" is the open-ended top bucket; 5 is the conservative reading.
    else if (/^5 or more vehicles available$/.test(leaf(v))) vehicleBuckets.push([v.id, 5]);
  }

  const age65 = b01001
    .filter((v) =>
      /^(65 and 66 years|67 to 69 years|70 to 74 years|75 to 79 years|80 to 84 years|85 years and over)$/.test(
        leaf(v),
      ),
    )
    .map((v) => v.id);

  const disability = b18101.filter((v) => leaf(v) === "With a disability").map((v) => v.id);

  const limitedEnglish = c16002
    .filter((v) => leaf(v) === "Limited English speaking household")
    .map((v) => v.id);

  const mobileHomeVar = b25024.find((v) => leaf(v) === "Mobile home");

  const languageGroups: [string, string][] = [];
  for (const v of c16001) {
    // parts is ["Total", "<language group>"]; deeper rows are the
    // "speak English very well / less than very well" splits.
    if (v.parts.length !== 2) continue;
    const hit = LANG_ISO.find(([re]) => re.test(leaf(v)));
    if (hit) languageGroups.push([v.id, hit[1]]);
  }

  const bad: string[] = [];
  if (noVehicle.length !== 2) bad.push(`B25044 no-vehicle resolved ${noVehicle.length}/2`);
  if (vehicleBuckets.length !== 10) bad.push(`B25044 buckets resolved ${vehicleBuckets.length}/10`);
  if (age65.length !== 12) bad.push(`B01001 65+ resolved ${age65.length}/12`);
  if (disability.length !== 12) bad.push(`B18101 resolved ${disability.length}/12`);
  if (limitedEnglish.length !== 4) bad.push(`C16002 resolved ${limitedEnglish.length}/4`);
  if (!mobileHomeVar) bad.push("B25024 mobile home not found");
  if (bad.length || !mobileHomeVar) {
    throw new Error(`variable resolution failed: ${bad.join("; ")}`);
  }

  log(
    "variables",
    `no-vehicle=${noVehicle.join("+")} 65+=${age65.length} vars, disability=${disability.length} vars, ` +
      `limitedEnglish=${limitedEnglish.length} vars, mobileHome=${mobileHomeVar.id}, ` +
      `languages=${languageGroups.length} groups`,
  );

  return {
    noVehicle,
    vehicleBuckets,
    age65,
    disability,
    limitedEnglish,
    mobileHome: mobileHomeVar.id,
    languageGroups,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACS transports
// ─────────────────────────────────────────────────────────────────────────────

type SummaryLevel = "blockGroup" | "tract";

const SUMLEVEL_CODE: Record<SummaryLevel, string> = {
  blockGroup: "1500000",
  tract: "1400000",
};

function num(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < ACS_JAM_FLOOR) return 0;
  return n;
}

/** api.census.gov — real ACS, needs CENSUS_API_KEY. */
async function fetchAcsKeyed(
  table: string,
  c: County,
  level: SummaryLevel,
  key: string,
): Promise<AcsTable> {
  const forClause = level === "blockGroup" ? "block%20group:*" : "tract:*";
  const inClause =
    level === "blockGroup"
      ? `&in=state:${c.state}%20county:${c.county}&in=tract:*`
      : `&in=state:${c.state}%20county:${c.county}`;
  const url =
    `https://api.census.gov/data/${acsYear}/acs/${ACS_DATASET}` +
    `?get=group(${table})&for=${forClause}${inClause}&key=${key}`;

  const rows = await fetchJson<string[][]>(url);
  const header = rows[0];
  const out: AcsTable = new Map();
  const gi = {
    state: header.indexOf("state"),
    county: header.indexOf("county"),
    tract: header.indexOf("tract"),
    bg: header.indexOf("block group"),
  };
  for (const row of rows.slice(1)) {
    const geoid =
      row[gi.state] + row[gi.county] + row[gi.tract] + (level === "blockGroup" ? row[gi.bg] : "");
    const rec: AcsRow = {};
    header.forEach((h, i) => {
      if (/_\d+E$/.test(h)) rec[h] = num(row[i]);
    });
    out.set(geoid, rec);
  }
  return out;
}

/** data.census.gov's own table endpoint. Keyless, same estimates. */
async function fetchAcsKeyless(table: string, c: County, level: SummaryLevel): Promise<AcsTable> {
  const url =
    `https://data.census.gov/api/access/data/table` +
    `?id=ACSDT5Y${acsYear}.${table}` +
    `&g=050XX00US${c.state}${c.county}$${SUMLEVEL_CODE[level]}`;

  const raw = await fetchJson<{ response?: { data?: unknown[][] } }>(url);
  const data = raw.response?.data;
  if (!data || data.length < 2) throw new Error(`${table} empty at ${level} for ${c.name}`);

  const header = data[0] as string[];
  const geoIdx = header.indexOf("GEO_ID");
  if (geoIdx < 0) throw new Error(`${table} response has no GEO_ID column`);

  const out: AcsTable = new Map();
  for (const row of data.slice(1)) {
    const full = String(row[geoIdx] ?? "");
    const geoid = full.includes("US") ? full.slice(full.indexOf("US") + 2) : full;
    if (!geoid) continue;
    const rec: AcsRow = {};
    header.forEach((h, i) => {
      if (/_\d+E$/.test(h)) rec[h] = num(row[i]);
    });
    out.set(geoid, rec);
  }
  return out;
}

type Transport = "api.census.gov (keyed)" | "data.census.gov (keyless)";

async function fetchAcs(
  table: string,
  c: County,
  level: SummaryLevel,
  key: string | undefined,
  transport: { used: Transport | null },
): Promise<AcsTable> {
  if (key) {
    try {
      const t = await fetchAcsKeyed(table, c, level, key);
      transport.used = "api.census.gov (keyed)";
      return t;
    } catch (err) {
      warn(`keyed ACS call for ${table}/${level} failed (${(err as Error).message}); falling back`);
    }
  }
  const t = await fetchAcsKeyless(table, c, level);
  transport.used = "data.census.gov (keyless)";
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

interface GeoJsonFeature {
  properties: Record<string, string | number | null>;
  geometry:
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] }
    | null;
}

function tigerQueryUrl(layer: number, bbox: number[], outFields: string): string {
  const params = new URLSearchParams({
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  return `${tigerService}/${layer}/query?${params.toString()}`;
}

async function discoverTigerLayers(): Promise<{ bg: number; county: number }> {
  const fallback = TIGER_LAYER_FALLBACK[acsYear] ?? TIGER_LAYER_FALLBACK[2022];
  try {
    const root = await fetchJson<{ layers?: { id: number; name: string }[] }>(
      `${tigerService}?f=json`,
    );
    const find = (name: string) => root.layers?.find((l) => l.name === name)?.id;
    const bg = find("Census Block Groups");
    const county = find("Counties");
    if (bg === undefined || county === undefined) throw new Error("layer names not present");
    return { bg, county };
  } catch (err) {
    warn(`TIGERweb layer discovery failed (${(err as Error).message}); using static ids`);
    return fallback;
  }
}

async function discoverCounties(scenario: ScenarioMeta): Promise<County[]> {
  try {
    const url = tigerQueryUrl(
      tigerLayers.county,
      scenario.bbox,
      "GEOID,STATE,COUNTY,NAME,BASENAME",
    );
    const fc = await fetchJson<{ features?: GeoJsonFeature[] }>(url);
    const seen = new Map<string, County>();
    for (const f of fc.features ?? []) {
      const state = String(f.properties.STATE ?? "");
      const county = String(f.properties.COUNTY ?? "");
      if (!state || !county) continue;
      seen.set(state + county, {
        state,
        county,
        name: String(f.properties.NAME ?? f.properties.BASENAME ?? `${state}${county}`),
      });
    }
    if (seen.size) return [...seen.values()];
    throw new Error("no county features returned");
  } catch (err) {
    warn(`county discovery via TIGERweb failed (${(err as Error).message}); using static map`);
    return COUNTY_FALLBACK[scenario.id] ?? COUNTY_FALLBACK["camp-fire-2018"];
  }
}

function ringArea(ring: LngLat[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a / 2);
}

function perpDistance(p: LngLat, a: LngLat, b: LngLat): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const cl = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + cl * dx), p[1] - (a[1] + cl * dy));
}

function rdp(pts: LngLat[], tol: number): LngLat[] {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const d = perpDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), tol).slice(0, -1), ...rdp(pts.slice(idx), tol)];
}

function simplifyRing(ring: LngLat[], tol: number): LngLat[] {
  if (ring.length < 5) return ring;
  const open = ring.slice(0, -1);
  const simplified = rdp(open, tol);
  if (simplified.length < 3) return ring;
  return [...simplified, simplified[0]];
}

/** MultiPolygon block groups (islands, split by water) collapse to their
 *  dominant part — the solver needs one polygon per cell, not a fragment set. */
function toRings(geom: GeoJsonFeature["geometry"]): LngLat[][] {
  if (!geom) return [];
  const polys: number[][][][] = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best: number[][][] | null = null;
  let bestArea = -1;
  for (const poly of polys) {
    const a = ringArea(poly[0] as LngLat[]);
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  if (!best) return [];
  return best
    .map((ring) =>
      simplifyRing(
        ring.map((p) => [p[0], p[1]] as LngLat),
        SIMPLIFY_TOLERANCE,
      ),
    )
    .filter((r) => r.length >= 4);
}

async function fetchBlockGroupGeometry(scenario: ScenarioMeta): Promise<BlockGroupGeom[]> {
  const url = tigerQueryUrl(
    tigerLayers.bg,
    scenario.bbox,
    "GEOID,STATE,COUNTY,TRACT,BLKGRP,INTPTLAT,INTPTLON,AREALAND",
  );
  const fc = await fetchJson<{ features?: GeoJsonFeature[] }>(url);
  const out: BlockGroupGeom[] = [];
  for (const f of fc.features ?? []) {
    const geoid = String(f.properties.GEOID ?? "");
    const rings = toRings(f.geometry);
    if (!geoid || rings.length === 0) continue;
    const lat = Number(f.properties.INTPTLAT);
    const lon = Number(f.properties.INTPTLON);
    out.push({
      geoid,
      state: String(f.properties.STATE ?? geoid.slice(0, 2)),
      county: String(f.properties.COUNTY ?? geoid.slice(2, 5)),
      centroid: Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : centroidOf(rings[0]),
      rings,
      areaLand: Number(f.properties.AREALAND ?? 0),
    });
  }
  return out;
}

function centroidOf(ring: LngLat[]): LngLat {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

function pointInRing(pt: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass — mapped mobile home parks, used as a cross-check on ACS B25024
// ─────────────────────────────────────────────────────────────────────────────

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function fetchMobileHomeParks(
  scenario: ScenarioMeta,
): Promise<{ pos: LngLat; name: string }[]> {
  const [w, s, e, n] = scenario.bbox;
  const bb = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:180];
(
  way["residential"="mobile_home"](${bb});
  relation["residential"="mobile_home"](${bb});
  node["residential"="mobile_home"](${bb});
  way["landuse"="residential"]["name"~"Mobile Home|Trailer Park|MHP",i](${bb});
  node["place"="neighbourhood"]["name"~"Mobile Home|Trailer Park|MHP",i](${bb});
  way["name"~"Mobile Home Park|Trailer Park",i](${bb});
);
out center tags;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const raw = await fetchJson<{ elements?: OverpassElement[] }>(endpoint, { body: query });
      const byName = new Map<string, { pos: LngLat; name: string }>();
      for (const el of raw.elements ?? []) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (lat === undefined || lon === undefined) continue;
        const name = el.tags?.name ?? `park-${el.id}`;
        // OSM splits one park across many named ways; collapse by name.
        if (!byName.has(name)) byName.set(name, { pos: [lon, lat], name });
      }
      return [...byName.values()];
    } catch (err) {
      warn(`Overpass ${new URL(endpoint).hostname} failed: ${(err as Error).message}`);
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fallback — only when ACS is unreachable entirely
// ─────────────────────────────────────────────────────────────────────────────

/** Rural-WUI defaults used ONLY if every ACS transport fails. Rates are from
 *  the 2022 national ACS marginals, applied to a land-area density guess. */
const SYNTH = {
  peoplePerSqKm: 320,
  personsPerHousehold: 2.4,
  noVehicleRate: 0.061,
  vehiclesPerHousehold: 1.83,
  age65Rate: 0.171,
  disabilityRate: 0.134,
  limitedEnglishRate: 0.044,
  mobileHomeRate: 0.06,
};

function synthCells(geoms: BlockGroupGeom[]): PopulationCell[] {
  return geoms.map((g) => {
    const km2 = Math.max(g.areaLand / 1e6, 0.05);
    const population = Math.round(km2 * SYNTH.peoplePerSqKm);
    const households = Math.max(1, Math.round(population / SYNTH.personsPerHousehold));
    return {
      id: g.geoid,
      centroid: g.centroid,
      geometry: g.rings,
      population,
      households,
      noVehicleHouseholds: Math.round(households * SYNTH.noVehicleRate),
      vehiclesAvailable: Math.round(households * SYNTH.vehiclesPerHousehold),
      age65Plus: Math.round(population * SYNTH.age65Rate),
      withDisability: Math.round(population * SYNTH.disabilityRate),
      limitedEnglishHouseholds: Math.round(households * SYNTH.limitedEnglishRate),
      languages: ["en"],
      mobileHomes: Math.round(households * SYNTH.mobileHomeRate),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const sum = (rec: AcsRow | undefined, ids: string[]): number =>
  ids.reduce((acc, id) => acc + (rec?.[id] ?? 0), 0);

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario = getScenario(scenarioId);
  if (scenario.id !== scenarioId) {
    warn(`unknown scenario "${scenarioId}"; falling back to ${scenario.id}`);
  }
  const key = process.env.CENSUS_API_KEY?.trim() || undefined;

  acsYear = ACS_VINTAGE[scenario.id] ?? DEFAULT_ACS_YEAR;
  tigerService = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS${acsYear}/MapServer`;

  log(
    "start",
    `${scenario.id} bbox=[${scenario.bbox.join(", ")}] acs=${acsYear} 5-year ` +
      `(${acsYear - 4}-${acsYear}, last release ending before ${scenario.eventDate})`,
  );
  log(
    "auth",
    key
      ? "CENSUS_API_KEY present — trying keyed api.census.gov first"
      : "no CENSUS_API_KEY — keyless data.census.gov transport",
  );

  tigerLayers = await discoverTigerLayers();
  log(
    "tiger",
    `tigerWMS_ACS${acsYear}: block groups=layer ${tigerLayers.bg}, counties=layer ${tigerLayers.county}`,
  );

  const counties = await discoverCounties(scenario);
  log("counties", counties.map((c) => `${c.name} (${c.state}${c.county})`).join(", "));

  const geoms = await fetchBlockGroupGeometry(scenario);
  log(
    "geometry",
    `TIGERweb layer ${tigerLayers.bg}: ${geoms.length} block groups intersect the bbox`,
  );
  if (geoms.length === 0) throw new Error("TIGERweb returned no block groups for this bbox");

  const inBbox = new Set(geoms.map((g) => g.geoid));
  const countiesInPlay = counties.filter((c) =>
    geoms.some((g) => g.state === c.state && g.county === c.county),
  );
  const activeCounties = countiesInPlay.length ? countiesInPlay : counties;

  const vars = await resolveVariables();

  // Core tables decide whether the run is real at all. Enrichment tables can
  // fail on their own without discarding five good ones.
  const coreTables = ["B01003", "B11001", "B25044"] as const;
  const enrichTables = ["B01001", "C16002", "B25024"] as const;
  const tractTables = ["B18101", "C16001"] as const;

  const bg: Record<string, AcsTable> = {};
  const tract: Record<string, AcsTable> = {};
  for (const t of [...coreTables, ...enrichTables]) bg[t] = new Map();
  for (const t of tractTables) tract[t] = new Map();

  /** Tract population from ALL block groups in the county, not just the ones
   *  inside the bbox — a tract straddling the edge must not hand its whole
   *  disability/language count to the inside half. */
  const tractPop = new Map<string, number>();

  const transport = { used: null as Transport | null };
  const failed = new Set<string>();

  for (const c of activeCounties) {
    for (const t of [...coreTables, ...enrichTables]) {
      try {
        const table = await fetchAcs(t, c, "blockGroup", key, transport);
        let hits = 0;
        for (const [geoid, rec] of table) {
          if (t === "B01003") {
            const tid = geoid.slice(0, 11);
            tractPop.set(tid, (tractPop.get(tid) ?? 0) + (rec.B01003_001E ?? 0));
          }
          if (!inBbox.has(geoid)) continue;
          bg[t].set(geoid, rec);
          hits += 1;
        }
        log(
          "acs",
          `${t.padEnd(7)} ${c.name}: ${table.size} block groups fetched, ${hits} inside bbox`,
        );
      } catch (err) {
        failed.add(t);
        warn(`${t} block-group pull failed for ${c.name}: ${(err as Error).message}`);
      }
    }
    for (const t of tractTables) {
      try {
        const table = await fetchAcs(t, c, "tract", key, transport);
        for (const [geoid, rec] of table) tract[t].set(geoid, rec);
        log(
          "acs",
          `${t.padEnd(7)} ${c.name}: ${table.size} tracts fetched (tract-level table, apportioned to block groups)`,
        );
      } catch (err) {
        failed.add(t);
        warn(`${t} tract pull failed for ${c.name}: ${(err as Error).message}`);
      }
    }
  }

  const acsOk = coreTables.every((t) => bg[t].size > 0);
  for (const t of [...enrichTables, ...tractTables]) {
    const empty = t === "B18101" || t === "C16001" ? tract[t].size === 0 : bg[t].size === 0;
    if (empty) {
      const field =
        t === "B01001"
          ? "age65Plus"
          : t === "C16002"
            ? "limitedEnglishHouseholds"
            : t === "B25024"
              ? "mobileHomes"
              : t === "B18101"
                ? "withDisability"
                : "languages";
      warn(`${t} unavailable — ${field} zero-filled (or ["en"]) for every cell; not synthesized`);
    }
  }

  const parks = await fetchMobileHomeParks(scenario);
  if (parks.length === 0) {
    warn(
      "Overpass found no mapped mobile home parks in this bbox — park cross-check unavailable, mobileHomes comes from ACS B25024 alone",
    );
  } else {
    log(
      "overpass",
      `${parks.length} distinct mapped mobile home parks in bbox: ${parks
        .map((p) => p.name)
        .slice(0, 6)
        .join(", ")}`,
    );
  }

  let cells: PopulationCell[];

  if (!acsOk) {
    loud(
      `ACS core tables (${coreTables.join(", ")}) were unreachable — population, households, ` +
        "noVehicleHouseholds, vehiclesAvailable, age65Plus, withDisability, limitedEnglishHouseholds " +
        "and mobileHomes are ALL SYNTHESIZED from TIGER land area x national ACS marginals " +
        `(${SYNTH.peoplePerSqKm} people/km2, ${SYNTH.personsPerHousehold} per household, ` +
        `${SYNTH.noVehicleRate} no-vehicle rate). Do not quote these numbers.`,
    );
    cells = synthCells(geoms);
  } else {
    let missingAcs = 0;
    let parkMismatch = 0;
    cells = geoms.map((g) => {
      const tid = g.geoid.slice(0, 11);
      const pop = bg.B01003.get(g.geoid)?.B01003_001E ?? 0;
      const households = bg.B11001.get(g.geoid)?.B11001_001E ?? 0;
      if (!bg.B01003.has(g.geoid)) missingAcs += 1;

      const veh = bg.B25044.get(g.geoid);
      const noVehicleHouseholds = sum(veh, vars.noVehicle);
      const vehiclesAvailable = vars.vehicleBuckets.reduce(
        (acc, [id, per]) => acc + (veh?.[id] ?? 0) * per,
        0,
      );

      const share = (tractPop.get(tid) ?? 0) > 0 ? pop / (tractPop.get(tid) as number) : 0;
      const withDisability = Math.round(sum(tract.B18101.get(tid), vars.disability) * share);

      const langCounts = vars.languageGroups
        .map(([id, iso]) => ({ iso, n: (tract.C16001.get(tid)?.[id] ?? 0) * share }))
        .filter((l) => l.n >= 1)
        .sort((a, b) => b.n - a.n);
      const languages = ["en", ...langCounts.map((l) => l.iso)].slice(0, 4);

      const mobileHomes = bg.B25024.get(g.geoid)?.[vars.mobileHome] ?? 0;
      if (mobileHomes === 0 && parks.some((p) => g.rings.some((r) => pointInRing(p.pos, r)))) {
        parkMismatch += 1;
      }

      return {
        id: g.geoid,
        centroid: g.centroid,
        geometry: g.rings,
        population: pop,
        households,
        noVehicleHouseholds,
        vehiclesAvailable,
        age65Plus: sum(bg.B01001.get(g.geoid), vars.age65),
        withDisability,
        limitedEnglishHouseholds: sum(bg.C16002.get(g.geoid), vars.limitedEnglish),
        languages,
        // ACS counts manufactured-housing UNITS per block group; Overpass only
        // knows where parks are drawn. ACS is the count, parks are the check.
        mobileHomes,
      } satisfies PopulationCell;
    });

    if (missingAcs > 0) {
      warn(
        `${missingAcs} block groups in the bbox had no ACS row (zero-filled) — likely water or new-vintage geography`,
      );
    }
    if (parkMismatch > 0) {
      warn(
        `${parkMismatch} block groups contain a mapped OSM mobile home park but ACS B25024 reports zero mobile homes there`,
      );
    }
  }

  const totals = cells.reduce(
    (acc, c) => ({
      population: acc.population + c.population,
      households: acc.households + c.households,
      noVehicleHouseholds: acc.noVehicleHouseholds + c.noVehicleHouseholds,
      vehicles: acc.vehicles + c.vehiclesAvailable,
    }),
    { population: 0, households: 0, noVehicleHouseholds: 0, vehicles: 0 },
  );

  const layer: PopulationLayer = {
    scenarioId: scenario.id,
    cells,
    totals,
    source: acsOk
      ? `US Census ACS ${acsYear - 4}-${acsYear} 5-year (B01003, B11001, B25044, B01001, C16002, B25024 at ` +
        `block group; B18101, C16001 at tract, apportioned by block-group share of tract population) via ` +
        `${transport.used ?? "data.census.gov (keyless)"}; geometry TIGERweb tigerWMS_ACS${acsYear} ` +
        `layer ${tigerLayers.bg}; mobile homes from B25024 "Mobile home", cross-checked against ` +
        `${parks.length} OpenStreetMap mobile home parks via Overpass` +
        (failed.size ? `; UNAVAILABLE and zero-filled: ${[...failed].join(", ")}` : "")
      : `SYNTHETIC — ACS unreachable; TIGERweb tigerWMS_ACS${acsYear} geometry with national ACS ${acsYear} marginals applied to land area`,
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(ROOT, "public", "data", scenario.id);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "population.json");
  writeFileSync(outFile, JSON.stringify(layer));
  const bytes = statSync(outFile).size;

  // Per-county breakdown of what actually landed in the file.
  const byCounty = new Map<
    string,
    { cells: number; pop: number; hh: number; nv: number; mh: number }
  >();
  for (const c of cells) {
    const fips = c.id.slice(0, 5);
    const agg = byCounty.get(fips) ?? { cells: 0, pop: 0, hh: 0, nv: 0, mh: 0 };
    agg.cells += 1;
    agg.pop += c.population;
    agg.hh += c.households;
    agg.nv += c.noVehicleHouseholds;
    agg.mh += c.mobileHomes;
    byCounty.set(fips, agg);
  }

  console.log("");
  for (const [fips, a] of byCounty) {
    const nm = activeCounties.find((c) => c.state + c.county === fips)?.name ?? fips;
    log(
      "county",
      `${nm} (${fips}): ${a.cells} block groups, pop ${a.pop.toLocaleString()}, households ${a.hh.toLocaleString()}, ` +
        `no-vehicle households ${a.nv.toLocaleString()}, mobile homes ${a.mh.toLocaleString()}`,
    );
  }
  log(
    "totals",
    `population ${totals.population.toLocaleString()}, households ${totals.households.toLocaleString()}, ` +
      `NO-VEHICLE HOUSEHOLDS ${totals.noVehicleHouseholds.toLocaleString()}, vehicles ${totals.vehicles.toLocaleString()}`,
  );
  log(
    "written",
    `${outFile} (${bytes.toLocaleString()} bytes, ${cells.length} cells, ${warnings} warning(s))`,
  );
}

main().catch((err) => {
  console.error(`[population] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

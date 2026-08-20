/**
 * Environmental and exposure context layers.
 *
 *   npx tsx scripts/fetch-context-layers.ts [scenarioId]
 *
 * Writes one file per layer to public/data/<scenario>/context/ plus an
 * index.json manifest naming, for every layer, whether it built, from which
 * exact URL, how many records, and whether it is OBSERVED or MODELLED.
 *
 * Structure: one builder per layer, each wrapped in its own try/catch. A dead
 * upstream produces a manifest entry with `available: false` and a `reason`,
 * and the run continues. Nothing here can take the map down, and nothing here
 * feeds the solver — the solver stays deterministic on the core bundle.
 *
 * ── Upstreams, all keyless except where noted ───────────────────────────────
 *   AirNow historical      files.airnowtech.org      hourly PM2.5 by monitor
 *   NOAA HMS               satepsanone.nesdis.noaa.gov  analyst smoke polygons
 *   HIFLD                  services1.arcgis.com      transmission lines
 *   CDC/ATSDR SVI          svi.cdc.gov               tract vulnerability CSV
 *   TIGERweb               tigerweb.geo.census.gov   tract geometry
 *   IEM VTEC archive       mesonet.agron.iastate.edu archived NWS warnings
 *   api.weather.gov        api.weather.gov           live alerts (User-Agent!)
 *   Open-Meteo elevation   api.open-meteo.com        Copernicus DEM
 *   NIFC                   services3.arcgis.com      historical perimeters
 *   NASA FIRMS             firms.modaps.eosdis.nasa.gov  FRP — NEEDS MAP_KEY
 *
 * ── Traps this script exists to route around (all verified, see research/) ──
 *
 * 1. Open-Meteo's AIR QUALITY api answers HTTP 200 for 2018 and every hourly
 *    value is null. Its archive floor is ~2022-08-04. A naive integration
 *    ships an empty layer that looks like it worked. AirNow is used instead
 *    for pre-2022 events, and open-meteo only when the event date clears the
 *    floor.
 * 2. HMS files are `hms_smokeYYYYMMDD.kml`, not `smokeYYYYMMDD.kml`.
 * 3. IEM's watchwarn.py silently returns almost nothing with `limit0=yes`.
 * 4. api.weather.gov/alerts/active rejects a `limit` parameter outright, and
 *    its historical /alerts window does not reach 2018 — it answers 200 with
 *    an empty feature list.
 * 5. The clock is read from weather.json, never recomputed. Open-Meteo stamps
 *    historical hours with the REQUEST-time UTC offset; fetch-weather already
 *    solved that, and re-deriving it here would silently drift by an hour.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS } from "../src/lib/constants";
import type {
  AirQualityFrame,
  AirQualityPayload,
  AirQualityStation,
  BurnScar,
  BurnScarPayload,
  ContextLayerEntry,
  ContextLayerId,
  ContextManifest,
  FireDetection,
  FireIntensityPayload,
  FireWeatherAdvisory,
  FireWeatherPayload,
  Provenance,
  SlopeCell,
  SlopePayload,
  SmokeDensity,
  SmokePayload,
  SmokePlume,
  SviPayload,
  SviTract,
  TransmissionLine,
  TransmissionPayload,
} from "../src/types/context-layers";
import type { LngLat, ScenarioMeta, Tick } from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const AIRNOW_BASE = "https://files.airnowtech.org/airnow";
const HMS_KML_BASE = "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML";
const HIFLD_TRANSMISSION =
  "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query";
const SVI_CSV_BASE = "https://svi.cdc.gov/Documents/Data";
const IEM_WATCHWARN = "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py";
const NWS_ALERTS_ACTIVE = "https://api.weather.gov/alerts/active";
const OPEN_METEO_ELEVATION = "https://api.open-meteo.com/v1/elevation";
const OPENTOPODATA_SRTM = "https://api.opentopodata.org/v1/srtm30m";
const OPEN_METEO_AIR_QUALITY = "https://air-quality-api.open-meteo.com/v1/air-quality";
const NIFC_HISTORY =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query";
const FIRMS_AREA = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

/** api.weather.gov 403s an unidentified client. */
const USER_AGENT = "egress-evac-planner/0.1 (evacuation clearance-time research tool)";

/**
 * Earliest date Open-Meteo's air-quality archive actually carries values.
 * Established by binary search against the live API, not read from docs: every
 * date before this answers 200 with an all-null hourly block.
 */
const OPEN_METEO_AQ_FLOOR = "2022-08-04";

/** State the scenario sits in, for the statewide alert and SVI pulls. */
const SCENARIO_STATE: Record<string, { abbr: string; fips: string }> = {
  "camp-fire-2018": { abbr: "CA", fips: "06" },
  "conyers-plume-2024": { abbr: "GA", fips: "13" },
  "marshall-fire-2021": { abbr: "CO", fips: "08" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/** Monitor catchment. Wide enough to show where the plume went, not just
 *  whether the town was in it. */
const AQ_RADIUS_M = 150_000;
const AQ_MAX_STATIONS = 40;

/** Smoke polygons are continental. Keep only what could plausibly be seen from
 *  the scenario, roughly 330 km beyond the bbox. */
const SMOKE_PAD_DEG = 3.0;

/** Slope grid. 40x40 over a typical bbox lands near 450 m cells, which is
 *  finer than the terrain that matters and still one small payload. */
const SLOPE_COLS = 40;
const SLOPE_ROWS = 40;
/** Open-Meteo's elevation endpoint accepts 100 coordinate pairs per call. */
const ELEVATION_BATCH = 100;

/** Burn scars below this are noise at map scale and cost payload bytes. */
const BURN_MIN_ACRES = 250;
const BURN_MAX_FEATURES = 120;

/** Live zone geometry lookups are one request each; cap the fan-out. */
const MAX_LIVE_ZONE_LOOKUPS = 12;

/** Coordinate decimal places. 5 dp is ~1.1 m — far finer than any of these
 *  sources resolve, and it roughly halves the payloads against raw doubles. */
const COORD_DP = 5;

const CACHE_DIR = join(repoRoot(), "scripts", ".cache", "context");

// ─────────────────────────────────────────────────────────────────────────────
// Paths, logging
// ─────────────────────────────────────────────────────────────────────────────

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const log = (msg: string) => console.log(msg);

function warn(msg: string) {
  console.log(`      !! ${msg}`);
}

function loud(msg: string) {
  const bar = "!".repeat(74);
  console.log(`      ${bar}`);
  console.log(`      !! ${msg}`);
  console.log(`      ${bar}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch with backoff and an on-disk cache
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(
  url: string,
  label: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const delays = [400, 1200, 3000];
  let lastErr: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
      if (!res.ok && res.status !== 429 && res.status < 500) {
        const body = (await res.text()).slice(0, 240).replace(/\s+/g, " ");
        // A 4xx will not fix itself. Fail immediately rather than burning the
        // backoff budget on a URL that is simply wrong.
        throw new Error(`${label}: HTTP ${res.status} ${res.statusText} — ${body}`);
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message;
      // 429 is the one 4xx worth waiting out — Open-Meteo throttles a burst of
      // elevation batches and answers normally a second later.
      const retryable = !/HTTP 4\d\d/.test(msg) || /HTTP 429/.test(msg);
      if (attempt === delays.length || !retryable) break;
      await sleep(/HTTP 429/.test(msg) ? delays[attempt] * 4 : delays[attempt]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchJson<T>(
  url: string,
  label: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const txt = await fetchText(url, label, headers);
  try {
    return JSON.parse(txt) as T;
  } catch {
    throw new Error(`${label}: response was not JSON — ${txt.slice(0, 160).replace(/\s+/g, " ")}`);
  }
}

/** Historical files are immutable, so a cache hit makes a re-run free. */
async function cachedText(url: string, key: string, label: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `${key}.txt`);
  if (existsSync(path)) return readFileSync(path, "utf8");
  const txt = await fetchText(url, label);
  writeFileSync(path, txt);
  return txt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry and number helpers
// ─────────────────────────────────────────────────────────────────────────────

const q = (n: number, dp = COORD_DP) => {
  const p = 10 ** dp;
  return Math.round(n * p) / p;
};

const qPoint = (p: LngLat): LngLat => [q(p[0]), q(p[1])];

const EARTH_R = 6_371_000;

function haversine(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

type Bbox = [number, number, number, number];

function ringBbox(ring: LngLat[]): Bbox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

const bboxOverlaps = (a: Bbox, b: Bbox) =>
  !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

const padBbox = (b: Bbox, deg: number): Bbox => [b[0] - deg, b[1] - deg, b[2] + deg, b[3] + deg];

/**
 * Ramer-Douglas-Peucker in degrees. Applied to agency polygons whose vertex
 * density far exceeds what a 1200 px map can resolve; tolerance is chosen per
 * caller against how big the feature draws.
 */
function simplify(ring: LngLat[], tol: number): LngLat[] {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  const last = ring.length - 1;
  keep[0] = 1;
  keep[last] = 1;
  const stack: [number, number][] = [];

  // A closed ring's first and last points are identical, which makes the
  // seeding segment degenerate: every perpendicular distance to a zero-length
  // line is zero, nothing clears the tolerance, and the "simplified" ring comes
  // back at full vertex count. Seeding from the vertex farthest from the start
  // splits the ring into two open chains that RDP can actually work on.
  const closed = Math.hypot(ring[0][0] - ring[last][0], ring[0][1] - ring[last][1]) < 1e-12;
  if (closed) {
    let far = 0;
    let farD = -1;
    for (let i = 1; i < last; i++) {
      const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    keep[far] = 1;
    stack.push([0, far], [far, last]);
  } else {
    stack.push([0, last]);
  }

  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    if (j - i < 2) continue;
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const den = Math.hypot(dx, dy) || 1;
    let far = -1;
    let farD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * ring[k][0] - dx * ring[k][1] + x2 * y1 - y2 * x1) / den;
      if (d > farD) {
        farD = d;
        far = k;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  if (out.length >= 4) return out;
  // Too aggressive for this shape. Fall back to an even decimation rather than
  // the original ring — handing back full fidelity on the very shapes the
  // tolerance was meant to shrink is how a payload quietly triples.
  const step = Math.max(1, Math.floor(ring.length / 8));
  const thinned = ring.filter((_, i) => i % step === 0);
  if (thinned[thinned.length - 1] !== ring[last]) thinned.push(ring[last]);
  return thinned.length >= 4 ? thinned : ring;
}

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

/** Polygon and MultiPolygon alike collapse to a flat list of outer rings. The
 *  layers here never need holes, and carrying them doubles the payload. */
function outerRings(geom: GeoJsonGeometry | null | undefined, tol: number): LngLat[][] {
  if (!geom) return [];
  const polys: number[][][][] =
    geom.type === "Polygon"
      ? [geom.coordinates as number[][][]]
      : geom.type === "MultiPolygon"
        ? (geom.coordinates as number[][][][])
        : [];
  const out: LngLat[][] = [];
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    const simplified = simplify(
      ring.map((p) => [p[0], p[1]] as LngLat),
      tol,
    );
    out.push(simplified.map(qPoint));
  }
  return out;
}

function lineStrings(geom: GeoJsonGeometry | null | undefined, tol: number): LngLat[][] {
  if (!geom) return [];
  const lines: number[][][] =
    geom.type === "LineString"
      ? [geom.coordinates as number[][]]
      : geom.type === "MultiLineString"
        ? (geom.coordinates as number[][][])
        : [];
  return lines
    .map((l) =>
      simplify(
        l.map((p) => [p[0], p[1]] as LngLat),
        tol,
      ).map(qPoint),
    )
    .filter((l) => l.length >= 2);
}

function centroidOfRing(ring: LngLat[]): LngLat {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [q(x / ring.length), q(y / ring.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock
//
// T+0 is read from weather.json, which already resolved the historical-DST
// problem. Recomputing it here would be a second source of truth and the two
// would eventually disagree by an hour with nothing to catch it.
// ─────────────────────────────────────────────────────────────────────────────

interface Clock {
  startEpoch: number;
  duration: Tick;
  frameStep: Tick;
  /** How the epoch was obtained. Reported so a fallback is never silent. */
  from: string;
}

function readClock(scenario: ScenarioMeta): Clock {
  const path = join(repoRoot(), "public", "data", scenario.id, "weather.json");
  if (existsSync(path)) {
    try {
      const w = JSON.parse(readFileSync(path, "utf8")) as {
        raw?: { scenarioStartEpoch?: number };
      };
      const epoch = w.raw?.scenarioStartEpoch;
      if (typeof epoch === "number" && Number.isFinite(epoch)) {
        return {
          startEpoch: epoch,
          duration: scenario.duration,
          frameStep: scenario.frameStep,
          from: "weather.json raw.scenarioStartEpoch",
        };
      }
    } catch {
      // fall through to the derived clock below
    }
  }
  // Midnight UTC on the event date. Coarse, and announced as such — every
  // context layer would be offset by the scenario's true start hour.
  const [y, m, d] = scenario.eventDate.split("-").map(Number);
  loud(
    `weather.json missing or unreadable — context clock falls back to ${scenario.eventDate} 00:00 UTC. ` +
      `Run "pnpm data:weather ${scenario.id}" first or every time-varying layer will be hours out.`,
  );
  return {
    startEpoch: Math.round(Date.UTC(y, m - 1, d) / 1000),
    duration: scenario.duration,
    frameStep: scenario.frameStep,
    from: "DERIVED fallback (midnight UTC on event date)",
  };
}

const tickOf = (clock: Clock, epochSec: number): Tick => Math.round(epochSec - clock.startEpoch);

/** UTC hours the scenario window touches, padded an hour either side. */
function windowHoursUtc(clock: Clock): Date[] {
  const first = Math.floor((clock.startEpoch - 3600) / 3600) * 3600;
  const last = Math.ceil((clock.startEpoch + clock.duration + 3600) / 3600) * 3600;
  const out: Date[] = [];
  for (let e = first; e <= last; e += 3600) out.push(new Date(e * 1000));
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;

// ─────────────────────────────────────────────────────────────────────────────
// Layer results
// ─────────────────────────────────────────────────────────────────────────────

interface BuiltLayer {
  id: ContextLayerId;
  label: string;
  file: string;
  payload: unknown;
  provenance: Provenance;
  source: string;
  sourceUrl: string;
  recordCount: number;
  timeVarying: boolean;
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Air quality
// ─────────────────────────────────────────────────────────────────────────────

interface AirNowSite {
  id: string;
  name: string;
  agency: string;
  position: LngLat;
}

/**
 * AirNow's site file is pipe-delimited with no header:
 *   AQSID|param|siteCode|siteName|status|agencyCode|agencyName|region|lat|lon|…
 * One row per site PER PARAMETER, so the same monitor appears several times.
 */
function parseAirNowSites(dat: string, centre: LngLat, radiusM: number): AirNowSite[] {
  const byId = new Map<string, AirNowSite>();
  for (const line of dat.split("\n")) {
    const c = line.split("|");
    if (c.length < 10 || c[1] !== "PM2.5") continue;
    const lat = Number(c[8]);
    const lng = Number(c[9]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    const position: LngLat = [q(lng), q(lat)];
    if (haversine(position, centre) > radiusM) continue;
    byId.set(c[0], { id: c[0], name: c[3].trim(), agency: (c[6] ?? "").trim(), position });
  }
  return [...byId.values()];
}

async function buildAirQuality(scenario: ScenarioMeta, clock: Clock): Promise<BuiltLayer> {
  const eventAfterFloor = scenario.eventDate >= OPEN_METEO_AQ_FLOOR;
  if (eventAfterFloor) return buildAirQualityOpenMeteo(scenario, clock);

  log(
    `      open-meteo air-quality archive starts ${OPEN_METEO_AQ_FLOOR}; ${scenario.eventDate} predates it ` +
      `(that endpoint answers 200 with all-null hourly values) — using AirNow monitors instead`,
  );

  const hours = windowHoursUtc(clock);
  const day0 = ymd(hours[0]);
  const sitesUrl = `${AIRNOW_BASE}/${hours[0].getUTCFullYear()}/${day0}/monitoring_site_locations.dat`;
  const sitesDat = await cachedText(sitesUrl, `airnow-sites-${day0}`, "airnow/sites");

  const nearby = parseAirNowSites(sitesDat, scenario.center, AQ_RADIUS_M)
    .sort((a, b) => haversine(a.position, scenario.center) - haversine(b.position, scenario.center))
    .slice(0, AQ_MAX_STATIONS);
  if (nearby.length === 0) throw new Error(`no AirNow PM2.5 sites within ${AQ_RADIUS_M / 1000} km`);

  const index = new Map(nearby.map((s, i) => [s.id, i]));
  const frames: AirQualityFrame[] = [];
  const peak: (number | null)[] = nearby.map(() => null);
  let hoursFetched = 0;

  for (const h of hours) {
    const stamp = `${ymd(h)}${pad2(h.getUTCHours())}`;
    const url = `${AIRNOW_BASE}/${h.getUTCFullYear()}/${ymd(h)}/HourlyData_${stamp}.dat`;
    let dat: string;
    try {
      dat = await cachedText(url, `airnow-hourly-${stamp}`, "airnow/hourly");
    } catch (err) {
      // A single missing hour is a hole in the series, not a dead layer.
      warn(`AirNow hour ${stamp}Z unavailable (${(err as Error).message.slice(0, 90)}) — skipped`);
      continue;
    }
    hoursFetched++;

    const values: (number | null)[] = nearby.map(() => null);
    for (const line of dat.split("\n")) {
      const c = line.split("|");
      if (c.length < 8 || c[5] !== "PM2.5") continue;
      const slot = index.get(c[2]);
      if (slot === undefined) continue;
      const v = Number(c[7]);
      if (!Number.isFinite(v) || v < 0) continue;
      values[slot] = v;
      if (peak[slot] === null || v > (peak[slot] as number)) peak[slot] = v;
    }
    frames.push({ t: tickOf(clock, Math.round(h.getTime() / 1000)), values });
  }

  if (frames.length === 0) throw new Error("no AirNow hourly files were readable for this window");

  const stations: AirQualityStation[] = nearby.map((s, i) => ({
    id: s.id,
    name: s.name,
    agency: s.agency,
    position: s.position,
    reporting: peak[i] !== null,
    peak: peak[i],
    distanceM: Math.round(haversine(s.position, scenario.center)),
  }));

  const silent = stations.filter((s) => !s.reporting);
  const worst = stations.reduce<AirQualityStation | null>(
    (best, s) => (s.peak !== null && (!best || (best.peak ?? 0) < s.peak) ? s : best),
    null,
  );

  log(
    `      ${stations.length} monitors within ${AQ_RADIUS_M / 1000} km, ${hoursFetched} hourly files, ` +
      `${stations.length - silent.length} reporting`,
  );
  if (worst?.peak != null) {
    log(
      `      window peak ${worst.peak} ug/m3 at ${worst.name} (${(worst.distanceM / 1000).toFixed(0)} km)`,
    );
  }
  if (silent.length > 0) {
    log(`      silent through the whole window: ${silent.map((s) => s.name).join(", ")}`);
  }

  const payload: AirQualityPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    units: "ug/m3",
    stations,
    frames,
    source: "AirNow historical hourly files (US EPA / state and local agencies)",
    sourceUrl: `${AIRNOW_BASE}/<yyyy>/<yyyymmdd>/HourlyData_<yyyymmddhh>.dat`,
    note:
      `Hourly PM2.5 as published by the reporting agency, held between observations rather than ` +
      `interpolated — each value is an hourly mean and a value between two means is not a ` +
      `measurement. Monitors are point observations: this layer shows what instruments recorded, ` +
      `it does NOT show a concentration surface between them. ` +
      (silent.length > 0
        ? `${silent.length} monitor(s) in range published nothing across the window and are drawn as silent, not as zero.`
        : "Every monitor in range reported."),
    generatedAt: new Date().toISOString(),
  };

  return {
    id: "airQuality",
    label: "PM2.5 monitor coverage",
    file: "air-quality.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: payload.sourceUrl,
    recordCount: stations.length,
    timeVarying: true,
    note: payload.note,
  };
}

/** Post-2022 events can use the reanalysis grid, which gives a real field
 *  rather than scattered points. Same payload shape, one pseudo-station per
 *  grid node. */
async function buildAirQualityOpenMeteo(scenario: ScenarioMeta, clock: Clock): Promise<BuiltLayer> {
  const [w, s, e, n] = scenario.bbox;
  const pts: LngLat[] = [];
  for (let iy = 0; iy < 5; iy++) {
    for (let ix = 0; ix < 5; ix++) {
      pts.push([q(w + ((e - w) * ix) / 4, 4), q(s + ((n - s) * iy) / 4, 4)]);
    }
  }
  const endDate = new Date((clock.startEpoch + clock.duration + 86400) * 1000)
    .toISOString()
    .slice(0, 10);
  const url =
    `${OPEN_METEO_AIR_QUALITY}?latitude=${pts.map((p) => p[1]).join(",")}` +
    `&longitude=${pts.map((p) => p[0]).join(",")}` +
    `&hourly=pm2_5&start_date=${scenario.eventDate}&end_date=${endDate}&timezone=GMT`;

  const raw = await fetchJson<
    | { hourly: { time: string[]; pm2_5: (number | null)[] } }[]
    | { hourly: { time: string[]; pm2_5: (number | null)[] } }
  >(url, "open-meteo/air-quality");
  const series = Array.isArray(raw) ? raw : [raw];

  const times = series[0]?.hourly?.time ?? [];
  if (times.length === 0) throw new Error("open-meteo air-quality returned no hourly block");
  // The endpoint answers 200 for out-of-range dates with an all-null block.
  // Treat that as a failure, loudly, rather than shipping an empty layer.
  const anyValue = series.some((sv) => sv.hourly.pm2_5.some((v) => v !== null));
  if (!anyValue) {
    throw new Error(
      `open-meteo air-quality returned 200 but every value is null for ${scenario.eventDate} — ` +
        `its archive begins ~${OPEN_METEO_AQ_FLOOR}`,
    );
  }

  const stations: AirQualityStation[] = pts.map((p, i) => ({
    id: `grid-${i}`,
    name: `CAMS ${p[1].toFixed(2)}, ${p[0].toFixed(2)}`,
    agency: "Copernicus CAMS via Open-Meteo",
    position: p,
    reporting: series[i]?.hourly.pm2_5.some((v) => v !== null) ?? false,
    peak: Math.max(...(series[i]?.hourly.pm2_5.filter((v): v is number => v !== null) ?? [0])),
    distanceM: Math.round(haversine(p, scenario.center)),
  }));

  const frames: AirQualityFrame[] = times.map((iso, h) => ({
    t: tickOf(clock, Math.round(Date.parse(`${iso}:00Z`) / 1000)),
    values: series.map((sv) => sv.hourly.pm2_5[h] ?? null),
  }));

  const payload: AirQualityPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    units: "ug/m3",
    stations,
    frames,
    source: "Copernicus CAMS reanalysis via Open-Meteo Air Quality API",
    sourceUrl: url,
    note:
      "CAMS reanalysis sampled on a 5x5 grid over the scenario bbox. Model reanalysis of " +
      "observations, not a station reading: correct for regional plume structure, coarse near " +
      "the fire itself.",
    generatedAt: new Date().toISOString(),
  };

  log(`      ${stations.length} CAMS grid nodes, ${frames.length} hourly frames`);

  return {
    id: "airQuality",
    label: "PM2.5 monitor coverage",
    file: "air-quality.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: url,
    recordCount: stations.length,
    timeVarying: true,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Fire intensity — NASA FIRMS FRP
// ─────────────────────────────────────────────────────────────────────────────

async function buildFireIntensity(scenario: ScenarioMeta, clock: Clock): Promise<BuiltLayer> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    throw new Error(
      "FIRMS_MAP_KEY not set — skipping. With a key this layer would render every VIIRS/MODIS " +
        "detection in the bbox as a point scaled and coloured by Fire Radiative Power in MW, " +
        "the actual physical measure of fire intensity, stepped by satellite overpass. " +
        "Free key: https://firms.modaps.eosdis.nasa.gov/api/area/",
    );
  }

  const [w, s, e, n] = scenario.bbox;
  const startDate = new Date(clock.startEpoch * 1000).toISOString().slice(0, 10);
  // Archive products carry the _SP suffix; the NRT feeds only hold ~2 months.
  const products = ["VIIRS_SNPP_SP", "MODIS_SP"];
  const detections: FireDetection[] = [];
  let used = "";

  for (const product of products) {
    const url = `${FIRMS_AREA}/${key}/${product}/${w},${s},${e},${n}/2/${startDate}`;
    try {
      const csv = await fetchText(url, `firms/${product}`);
      const rows = csv.trim().split("\n");
      const head = rows[0].split(",").map((h) => h.trim());
      const col = (name: string) => head.indexOf(name);
      const [iLat, iLng, iFrp, iDate, iTime, iConf] = [
        col("latitude"),
        col("longitude"),
        col("frp"),
        col("acq_date"),
        col("acq_time"),
        col("confidence"),
      ];
      const iBright = col("bright_ti4") >= 0 ? col("bright_ti4") : col("brightness");
      if (iLat < 0 || iLng < 0 || iFrp < 0) continue;

      for (const row of rows.slice(1)) {
        const c = row.split(",");
        const frp = Number(c[iFrp]);
        if (!Number.isFinite(frp)) continue;
        const hhmm = (c[iTime] ?? "0").padStart(4, "0");
        const epoch = Math.round(
          Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) / 1000,
        );
        detections.push({
          position: [q(Number(c[iLng])), q(Number(c[iLat]))],
          t: tickOf(clock, epoch),
          frp,
          brightness: Number(c[iBright]) || 0,
          confidence: (c[iConf] ?? "").trim(),
          sensor: product,
          acquiredUtc: new Date(epoch * 1000).toISOString(),
        });
      }
      used = used ? `${used} + ${url}` : url;
    } catch (err) {
      warn(`FIRMS ${product}: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  if (detections.length === 0) throw new Error("FIRMS returned no detections in the bbox");

  detections.sort((a, b) => a.t - b.t);
  const frps = detections.map((d) => d.frp);
  const payload: FireIntensityPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    detections,
    frpRange: [Math.min(...frps), Math.max(...frps)],
    source: "NASA FIRMS VIIRS / MODIS archive",
    sourceUrl: used,
    note:
      "Fire Radiative Power in megawatts, per satellite detection. FRP is instantaneous at the " +
      "overpass moment — between overpasses there is no measurement, and none is invented here.",
    generatedAt: new Date().toISOString(),
  };

  log(
    `      ${detections.length} detections, FRP ${payload.frpRange[0]}–${payload.frpRange[1]} MW`,
  );

  return {
    id: "fireIntensity",
    label: "Fire intensity · FRP",
    file: "fire-intensity.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: used,
    recordCount: detections.length,
    timeVarying: true,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Smoke plumes — NOAA HMS
// ─────────────────────────────────────────────────────────────────────────────

const DENSITY_OF: Record<string, SmokeDensity> = {
  light: "light",
  medium: "medium",
  heavy: "heavy",
};

/** HMS stamps times as `YYYYDDD HHMMUTC`, day-of-year not month-day. */
function parseHmsTime(raw: string): number | null {
  const m = raw.match(/(\d{4})(\d{3})\s+(\d{2})(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const doy = Number(m[2]);
  const base = Date.UTC(year, 0, 1) + (doy - 1) * 86_400_000;
  return Math.round((base + Number(m[3]) * 3_600_000 + Number(m[4]) * 60_000) / 1000);
}

async function buildSmoke(scenario: ScenarioMeta, clock: Clock): Promise<BuiltLayer> {
  const hours = windowHoursUtc(clock);
  const days = [...new Set(hours.map(ymd))];
  const region = padBbox(scenario.bbox as Bbox, SMOKE_PAD_DEG);
  const winStart = clock.startEpoch - 3600;
  const winEnd = clock.startEpoch + clock.duration + 3600;

  const plumes: SmokePlume[] = [];
  const urls: string[] = [];
  let placemarksSeen = 0;

  for (const day of days) {
    const url = `${HMS_KML_BASE}/${day.slice(0, 4)}/${day.slice(4, 6)}/hms_smoke${day}.kml`;
    let kml: string;
    try {
      kml = await cachedText(url, `hms-smoke-${day}`, "noaa-hms/kml");
    } catch (err) {
      warn(`HMS ${day}: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }
    urls.push(url);

    for (const block of kml.split("<Placemark").slice(1)) {
      placemarksSeen++;
      const coordsRaw = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
      if (!coordsRaw) continue;

      const desc = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? "";
      const densityRaw = (desc.match(/Density:\s*([A-Za-z]+)/)?.[1] ?? "").toLowerCase();
      const density = DENSITY_OF[densityRaw];
      // The KML also carries legend/logo/overlay placemarks with no density.
      // Requiring a density is what separates data from chrome.
      if (!density) continue;

      const startEpoch = parseHmsTime(desc.match(/Start Time:\s*([\d\s]+)UTC/)?.[1] ?? "");
      const endEpoch = parseHmsTime(desc.match(/End Time:\s*([\d\s]+)UTC/)?.[1] ?? "");
      if (startEpoch === null || endEpoch === null) continue;
      if (endEpoch < winStart || startEpoch > winEnd) continue;

      const ring = coordsRaw[1]
        .trim()
        .split(/\s+/)
        .map((tuple) => {
          const [x, y] = tuple.split(",");
          return [Number(x), Number(y)] as LngLat;
        })
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (ring.length < 4) continue;
      if (!bboxOverlaps(ringBbox(ring), region)) continue;

      plumes.push({
        density,
        startT: tickOf(clock, startEpoch),
        endT: tickOf(clock, endEpoch),
        satellite: desc.match(/Satellite:\s*([A-Za-z0-9_-]+)/)?.[1] ?? "unknown",
        rings: [simplify(ring, 0.002).map(qPoint)],
      });
    }
  }

  if (plumes.length === 0) {
    throw new Error(
      `HMS returned no smoke polygon overlapping the scenario window within ${SMOKE_PAD_DEG} deg ` +
        `of the bbox (${placemarksSeen} placemarks scanned across ${days.join(", ")})`,
    );
  }

  plumes.sort((a, b) => a.startT - b.startT);
  const byDensity = plumes.reduce<Record<string, number>>((acc, p) => {
    acc[p.density] = (acc[p.density] ?? 0) + 1;
    return acc;
  }, {});

  const payload: SmokePayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    plumes,
    source: "NOAA Hazard Mapping System (HMS) smoke analysis",
    sourceUrl: urls.join(" | "),
    note:
      "Smoke footprints drawn by NOAA satellite analysts from GOES and polar imagery. Each polygon " +
      "carries the satellite analysis window it was observed in and is shown only inside that " +
      "window. Density is the analyst's three-level classification, not a concentration.",
    generatedAt: new Date().toISOString(),
  };

  log(
    `      ${plumes.length} plumes in window (${Object.entries(byDensity)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}) from ${placemarksSeen} placemarks`,
  );

  return {
    id: "smoke",
    label: "Smoke plumes",
    file: "smoke.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: payload.sourceUrl,
    recordCount: plumes.length,
    timeVarying: true,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Electric transmission
// ─────────────────────────────────────────────────────────────────────────────

async function buildTransmission(scenario: ScenarioMeta): Promise<BuiltLayer> {
  // Padded past the bbox: the line that starts a fire is rarely inside the
  // town it burns. The Camp Fire ignition was ~15 km northeast of Paradise.
  const [w, s, e, n] = padBbox(scenario.bbox as Bbox, 0.18);
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${w},${s},${e},${n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "ID,OWNER,VOLTAGE,VOLT_CLASS,TYPE,STATUS,SUB_1,SUB_2",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const url = `${HIFLD_TRANSMISSION}?${params.toString()}`;

  const fc = await fetchJson<{
    features?: { properties: Record<string, string | number | null>; geometry: GeoJsonGeometry }[];
  }>(url, "hifld/transmission");

  const lines: TransmissionLine[] = [];
  for (const f of fc.features ?? []) {
    const paths = lineStrings(f.geometry, 0.0004);
    if (paths.length === 0) continue;
    const v = Number(f.properties.VOLTAGE);
    for (let i = 0; i < paths.length; i++) {
      lines.push({
        id: `${String(f.properties.ID ?? "line")}-${i}`,
        owner: String(f.properties.OWNER ?? "UNKNOWN"),
        // HIFLD encodes "not published" as -999999, which would otherwise
        // render as a zero-kV line at the bottom of the width ramp.
        voltageKv: Number.isFinite(v) && v > 0 ? v : null,
        voltClass: String(f.properties.VOLT_CLASS ?? "UNKNOWN"),
        status: String(f.properties.STATUS ?? "UNKNOWN"),
        from: String(f.properties.SUB_1 ?? ""),
        to: String(f.properties.SUB_2 ?? ""),
        path: paths[i],
      });
    }
  }

  if (lines.length === 0) throw new Error("HIFLD returned no transmission lines in the bbox");

  const owners = [...new Set(lines.map((l) => l.owner))];
  const kv = lines.map((l) => l.voltageKv).filter((v): v is number => v !== null);
  log(
    `      ${lines.length} segments, ${owners.length} owner(s), ${
      kv.length ? `${Math.min(...kv)}–${Math.max(...kv)} kV` : "no published voltages"
    }`,
  );
  log(`      owners: ${owners.slice(0, 3).join(", ")}`);

  const payload: TransmissionPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    lines,
    source: "HIFLD Open — Electric Power Transmission Lines",
    sourceUrl: url,
    note:
      "Published transmission line routes and nominal voltages. This is present-day infrastructure " +
      "geometry, not the network state on the event date, and it is NOT an ignition attribution — " +
      "it shows what runs through the terrain the evacuation had to cross.",
    generatedAt: new Date().toISOString(),
  };

  return {
    id: "transmission",
    label: "Transmission lines",
    file: "transmission.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: url,
    recordCount: lines.length,
    timeVarying: false,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Social vulnerability
// ─────────────────────────────────────────────────────────────────────────────

/** Nearest published SVI vintage at or before the event year. */
function sviVintage(eventYear: number): number {
  const published = [2000, 2010, 2014, 2016, 2018, 2020, 2022];
  return published.filter((y) => y <= eventYear).pop() ?? 2018;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** SVI encodes suppressed and not-applicable values as -999. Zero is a real
 *  rank; -999 is an absence, so it becomes null. */
const sviValue = (raw: string | undefined): number | null => {
  const v = Number(raw);
  return Number.isFinite(v) && v > -900 ? v : null;
};

async function buildSvi(scenario: ScenarioMeta): Promise<BuiltLayer> {
  const state = SCENARIO_STATE[scenario.id];
  if (!state) throw new Error(`no state mapping for scenario ${scenario.id}`);
  const eventYear = Number(scenario.eventDate.slice(0, 4));
  const vintage = sviVintage(eventYear);

  // SVI tract geometry follows the decennial vintage the release was built on,
  // so the TIGERweb service must match the SVI year, not the current year.
  const tigerService = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS${vintage}/MapServer`;
  const root = await fetchJson<{ layers?: { id: number; name: string }[] }>(
    `${tigerService}?f=json`,
    "tigerweb/root",
  );
  const tractLayer = root.layers?.find((l) => l.name === "Census Tracts")?.id;
  if (tractLayer === undefined)
    throw new Error(`TIGERweb ACS${vintage} has no "Census Tracts" layer`);

  const geomUrl =
    `${tigerService}/${tractLayer}/query?` +
    new URLSearchParams({
      geometry: scenario.bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "GEOID,NAME,BASENAME",
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
    }).toString();

  const fc = await fetchJson<{
    features?: { properties: Record<string, string | number | null>; geometry: GeoJsonGeometry }[];
  }>(geomUrl, "tigerweb/tracts");

  const geoms = new Map<string, { rings: LngLat[][]; name: string }>();
  for (const f of fc.features ?? []) {
    const geoid = String(f.properties.GEOID ?? "");
    // TIGERweb tract boundaries follow every stream meander. 0.0025 deg is
    // ~275 m, invisible on a tract that spans kilometres, and it takes the
    // payload from hundreds of KB to tens.
    const rings = outerRings(f.geometry, 0.0025);
    if (!geoid || rings.length === 0) continue;
    geoms.set(geoid, { rings, name: String(f.properties.NAME ?? geoid) });
  }
  if (geoms.size === 0) throw new Error("TIGERweb returned no tracts intersecting the bbox");

  const csvUrl = `${SVI_CSV_BASE}/${vintage}/csv/states/${stateFileName(state.abbr)}.csv`;
  const csv = await cachedText(csvUrl, `svi-${vintage}-${state.abbr}`, "cdc/svi");
  const rows = csv.split("\n");
  const head = splitCsvLine(rows[0]).map((h) => h.trim().toUpperCase());
  const at = (name: string) => head.indexOf(name);
  const iFips = at("FIPS");
  if (iFips < 0)
    throw new Error(`SVI CSV has no FIPS column — header was ${head.slice(0, 8).join(",")}`);

  const cols = {
    overall: at("RPL_THEMES"),
    t1: at("RPL_THEME1"),
    t2: at("RPL_THEME2"),
    t3: at("RPL_THEME3"),
    t4: at("RPL_THEME4"),
    pop: at("E_TOTPOP"),
    noveh: at("E_NOVEH"),
    location: at("LOCATION"),
  };

  const tracts: SviTract[] = [];
  const matched = new Set<string>();
  for (const line of rows.slice(1)) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    const fips = (c[iFips] ?? "").trim().replace(/^"|"$/g, "");
    const geom = geoms.get(fips);
    if (!geom) continue;
    matched.add(fips);
    tracts.push({
      geoid: fips,
      name: (cols.location >= 0 ? c[cols.location] : geom.name).replace(/^"|"$/g, "").trim(),
      overall: sviValue(c[cols.overall]),
      socioeconomic: sviValue(c[cols.t1]),
      householdComposition: sviValue(c[cols.t2]),
      minorityLanguage: sviValue(c[cols.t3]),
      housingTransport: sviValue(c[cols.t4]),
      population: Math.max(0, Number(c[cols.pop]) || 0),
      noVehicle: cols.noveh >= 0 ? sviValue(c[cols.noveh]) : null,
      centroid: centroidOfRing(geom.rings[0]),
      geometry: geom.rings,
    });
  }

  const joinRate = geoms.size > 0 ? matched.size / geoms.size : 0;
  if (tracts.length === 0) {
    throw new Error(
      `SVI ${vintage} joined 0 of ${geoms.size} tracts — check the FIPS column format ` +
        `(sample geoid ${[...geoms.keys()][0]})`,
    );
  }
  // A partial join is the failure this project has been bitten by before, so
  // it is stated rather than absorbed.
  if (joinRate < 0.99) {
    warn(
      `SVI join covered ${matched.size}/${geoms.size} tracts (${(joinRate * 100).toFixed(1)}%) — ` +
        `unmatched tracts are absent from the layer, not zero-filled`,
    );
  }

  const ranked = tracts
    .filter((t) => t.overall !== null)
    .sort((a, b) => (b.overall as number) - (a.overall as number));
  log(
    `      ${tracts.length} tracts, join ${(joinRate * 100).toFixed(1)}%, SVI ${vintage} vintage` +
      (ranked[0] ? ` | most vulnerable ${ranked[0].name} at ${ranked[0].overall}` : ""),
  );

  const payload: SviPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    tracts,
    joinRate: q(joinRate, 4),
    source: `CDC/ATSDR Social Vulnerability Index ${vintage}`,
    sourceUrl: csvUrl,
    note:
      `Percentile ranks within ${state.abbr}, 0 to 1, higher is more vulnerable. Theme 4 carries ` +
      `the no-vehicle share, so this layer and the ACS no-vehicle layer are two independent ` +
      `measurements of the same constraint and should agree. Geometry is TIGERweb ACS${vintage} ` +
      `tracts. Suppressed values are null, never zero.`,
    generatedAt: new Date().toISOString(),
  };

  return {
    id: "socialVulnerability",
    label: "Social vulnerability",
    file: "svi.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: csvUrl,
    recordCount: tracts.length,
    timeVarying: false,
    note: payload.note,
  };
}

/** CDC files the SVI state CSVs under the full state name. */
const STATE_FILE: Record<string, string> = {
  CA: "California",
  GA: "Georgia",
  CO: "Colorado",
};
const stateFileName = (abbr: string) => STATE_FILE[abbr] ?? abbr;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Fire weather
// ─────────────────────────────────────────────────────────────────────────────

/** VTEC phenomena worth drawing beside an evacuation. */
const FIRE_WEATHER_PHENOMENA: Record<string, string> = {
  FW: "Fire Weather",
  WI: "Wind",
  HW: "High Wind",
  EH: "Excessive Heat",
};

const SIGNIFICANCE_LABEL: Record<string, string> = {
  W: "Warning",
  A: "Watch",
  Y: "Advisory",
  S: "Statement",
};

async function buildFireWeather(scenario: ScenarioMeta, clock: Clock): Promise<BuiltLayer> {
  const state = SCENARIO_STATE[scenario.id];
  const startIso = new Date((clock.startEpoch - 2 * 86400) * 1000).toISOString().slice(0, 16);
  const endIso = new Date((clock.startEpoch + clock.duration + 86400) * 1000)
    .toISOString()
    .slice(0, 16);

  // No `limit0` parameter. With it the archive returns a near-empty set that
  // reads exactly like "there were no warnings" — verified the hard way.
  const archiveUrl = `${IEM_WATCHWARN}?sts=${startIso}Z&ets=${endIso}Z&accept=csv`;
  const csv = await cachedText(
    archiveUrl,
    `iem-vtec-${scenario.id}-${startIso.slice(0, 10)}`,
    "iem/watchwarn",
  );

  const rows = csv.split("\n");
  const head = splitCsvLine(rows[0]).map((h) => h.trim());
  const at = (n: string) => head.indexOf(n);
  const [iWfo, iIssue, iExpire, iPhen, iSig, iEtn, iUgc, iProd] = [
    at("wfo"),
    at("utc_issue"),
    at("utc_expire"),
    at("phenomena"),
    at("significance"),
    at("eventid"),
    at("ugc"),
    at("product_id"),
  ];
  if (iPhen < 0 || iUgc < 0)
    throw new Error("IEM CSV header did not contain phenomena/ugc columns");

  // The archive is one row per UGC zone; collapse to one product per event.
  const events = new Map<string, FireWeatherAdvisory>();
  for (const line of rows.slice(1)) {
    const c = splitCsvLine(line);
    if (c.length < head.length - 2) continue;
    const phen = c[iPhen];
    const ugc = (c[iUgc] ?? "").trim();
    if (!FIRE_WEATHER_PHENOMENA[phen]) continue;
    if (state && !ugc.startsWith(state.abbr)) continue;

    const key = `${c[iWfo]}|${phen}|${c[iSig]}|${c[iEtn]}`;
    const issued = Date.parse(`${c[iIssue].replace(" ", "T")}:00Z`);
    const expires = Date.parse(`${c[iExpire].replace(" ", "T")}:00Z`);
    if (!Number.isFinite(issued) || !Number.isFinite(expires)) continue;

    const existing = events.get(key);
    if (existing) {
      if (!existing.zones.includes(ugc)) existing.zones.push(ugc);
      // Rows differ per zone update; keep the widest envelope of the product.
      existing.startT = Math.min(existing.startT, tickOf(clock, issued / 1000));
      existing.endT = Math.max(existing.endT, tickOf(clock, expires / 1000));
      continue;
    }
    events.set(key, {
      id: key,
      event: `${FIRE_WEATHER_PHENOMENA[phen]} ${SIGNIFICANCE_LABEL[c[iSig]] ?? c[iSig]}`,
      phenomena: phen,
      significance: c[iSig],
      office: c[iWfo],
      zones: [ugc],
      issuedUtc: new Date(issued).toISOString(),
      expiresUtc: new Date(expires).toISOString(),
      startT: tickOf(clock, issued / 1000),
      endT: tickOf(clock, expires / 1000),
      productId: (c[iProd] ?? "").trim(),
      live: false,
    });
  }

  const archive = [...events.values()].sort((a, b) => a.startT - b.startT);

  // Live alerts: today's, deliberately uncached. `limit` is rejected outright
  // by this endpoint, so paging is done by not asking for it.
  const liveUrl = state
    ? `${NWS_ALERTS_ACTIVE}?area=${state.abbr}`
    : `${NWS_ALERTS_ACTIVE}?point=${scenario.center[1]},${scenario.center[0]}`;
  const live: FireWeatherAdvisory[] = [];
  try {
    const fc = await fetchJson<{
      features?: {
        id?: string;
        geometry: GeoJsonGeometry | null;
        properties: Record<string, unknown>;
      }[];
    }>(liveUrl, "api.weather.gov/alerts", { Accept: "application/geo+json" });

    let zoneLookups = 0;
    for (const f of fc.features ?? []) {
      const p = f.properties;
      const event = String(p.event ?? "");
      if (!/fire|red flag|wind|heat|smoke/i.test(event)) continue;

      let rings = outerRings(f.geometry, 0.002);
      const affected = Array.isArray(p.affectedZones) ? (p.affectedZones as string[]) : [];
      // Most fire-weather products are zone-based and carry no inline polygon;
      // resolve a bounded number of them so the layer has something to draw.
      if (rings.length === 0 && affected.length > 0 && zoneLookups < MAX_LIVE_ZONE_LOOKUPS) {
        for (const zoneUrl of affected.slice(0, 3)) {
          if (zoneLookups >= MAX_LIVE_ZONE_LOOKUPS) break;
          zoneLookups++;
          try {
            const z = await fetchJson<{ geometry: GeoJsonGeometry | null }>(
              zoneUrl,
              "api.weather.gov/zones",
              { Accept: "application/geo+json" },
            );
            // NWS zones are county-to-region sized and ship ~120 KB of
            // coastline each; 0.02 deg (~2 km) is the right scale for them.
            rings = rings.concat(outerRings(z.geometry, 0.02));
          } catch {
            // A retired or unavailable zone drops out; the advisory still
            // lists it in `zones` and remains real without a footprint.
          }
        }
      }

      const onset = Date.parse(String(p.effective ?? p.onset ?? ""));
      const ends = Date.parse(String(p.expires ?? p.ends ?? ""));
      live.push({
        id: String(f.id ?? p.id ?? event),
        event,
        phenomena: String(
          (p.eventCode as Record<string, string[]> | undefined)?.NationalWeatherService?.[0] ?? "",
        ),
        significance: String(p.severity ?? ""),
        office: String(p.senderName ?? ""),
        zones: affected.map((u) => u.split("/").pop() ?? u),
        issuedUtc: Number.isFinite(onset) ? new Date(onset).toISOString() : "",
        expiresUtc: Number.isFinite(ends) ? new Date(ends).toISOString() : "",
        startT: 0,
        endT: clock.duration,
        productId: String(p.id ?? ""),
        rings: rings.length > 0 ? rings : undefined,
        live: true,
      });
    }
  } catch (err) {
    warn(`live NWS alerts unavailable (${(err as Error).message.slice(0, 110)}) — archive only`);
  }

  if (archive.length === 0 && live.length === 0) {
    throw new Error(
      "neither the IEM archive nor the live NWS feed returned a fire-weather product",
    );
  }

  const inWindow = archive.filter((a) => a.startT <= clock.duration && a.endT >= 0);
  log(`      ${archive.length} archived products, ${inWindow.length} in force during the window`);
  for (const a of inWindow.slice(0, 4)) {
    log(
      `      ${a.office} ${a.event} — ${a.issuedUtc.slice(0, 16)}Z to ${a.expiresUtc.slice(0, 16)}Z, ${a.zones.length} zone(s)`,
    );
  }
  log(`      ${live.length} live alert(s) in force right now`);

  const payload: FireWeatherPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    archive,
    live,
    source: "Iowa Environmental Mesonet NWS VTEC archive + api.weather.gov active alerts",
    sourceUrl: `${archiveUrl} | ${liveUrl}`,
    note:
      "Archived products are the real NWS warnings in force over the event, with their issue and " +
      "expiry times and product identifiers. They carry NO polygon: the UGC zones a 2018 product " +
      "referenced have since been retired and api.weather.gov returns 404 for them, so the " +
      "advisory is drawn as a timeline band rather than an invented footprint. Live alerts carry " +
      "real geometry and exercise the same path against today's feed.",
    generatedAt: new Date().toISOString(),
  };

  return {
    id: "fireWeather",
    label: "Fire weather advisories",
    file: "fire-weather.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: payload.sourceUrl,
    recordCount: archive.length + live.length,
    timeVarying: true,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Terrain slope
// ─────────────────────────────────────────────────────────────────────────────

interface ElevationResult {
  elevations: number[];
  provider: string;
  providerUrl: string;
}

/**
 * Two keyless DEM providers, tried in order.
 *
 * OpenTopoData leads because its published limits (100 locations per call,
 * one call per second) fit a 1,600-point grid comfortably. Open-Meteo's
 * elevation endpoint meters by LOCATION COUNT inside a rolling minute, not by
 * request count, so 1,600 points trips "Minutely API request limit exceeded"
 * no matter how the batches are spaced — verified, not assumed. It stays as
 * the fallback because it is the same host the rest of the pipeline uses.
 */
async function sampleElevations(lats: number[], lngs: number[]): Promise<ElevationResult> {
  const providers: {
    name: string;
    url: (i: number) => string;
    read: (raw: string) => number[];
    gapMs: number;
  }[] = [
    {
      name: "OpenTopoData SRTM 30 m",
      url: (i) =>
        `${OPENTOPODATA_SRTM}?locations=${lats
          .slice(i, i + ELEVATION_BATCH)
          .map((la, k) => `${la},${lngs[i + k]}`)
          .join("|")}`,
      read: (raw) =>
        (JSON.parse(raw) as { results?: { elevation: number | null }[] }).results?.map(
          (r) => r.elevation ?? 0,
        ) ?? [],
      gapMs: 1200,
    },
    {
      name: "Copernicus DEM GLO-90 via Open-Meteo",
      url: (i) =>
        `${OPEN_METEO_ELEVATION}?latitude=${lats.slice(i, i + ELEVATION_BATCH).join(",")}` +
        `&longitude=${lngs.slice(i, i + ELEVATION_BATCH).join(",")}`,
      read: (raw) => (JSON.parse(raw) as { elevation?: number[] }).elevation ?? [],
      gapMs: 2500,
    },
  ];

  let lastErr = "";
  for (const p of providers) {
    const out: number[] = [];
    try {
      for (let i = 0; i < lats.length; i += ELEVATION_BATCH) {
        const chunk = p.read(await fetchText(p.url(i), p.name));
        if (chunk.length === 0) throw new Error("empty elevation batch");
        out.push(...chunk);
        if (i + ELEVATION_BATCH < lats.length) await sleep(p.gapMs);
      }
      return { elevations: out, provider: p.name, providerUrl: p.url(0) };
    } catch (err) {
      lastErr = `${p.name}: ${(err as Error).message.slice(0, 120)}`;
      warn(`${lastErr} — trying next elevation provider`);
    }
  }
  throw new Error(`no elevation provider answered (${lastErr})`);
}

async function buildSlope(scenario: ScenarioMeta): Promise<BuiltLayer> {
  const [w, s, e, n] = scenario.bbox;
  const cellLng = (e - w) / SLOPE_COLS;
  const cellLat = (n - s) / SLOPE_ROWS;

  // Sample cell CENTRES. Sampling corners and then differencing would offset
  // the slope field by half a cell against everything else on the map.
  const lats: number[] = [];
  const lngs: number[] = [];
  for (let r = 0; r < SLOPE_ROWS; r++) {
    for (let c = 0; c < SLOPE_COLS; c++) {
      lngs.push(q(w + cellLng * (c + 0.5), 4));
      lats.push(q(s + cellLat * (r + 0.5), 4));
    }
  }

  const { elevations, provider, providerUrl } = await sampleElevations(lats, lngs);
  if (elevations.length !== lats.length) {
    throw new Error(`elevation returned ${elevations.length} of ${lats.length} samples`);
  }
  log(`      elevation from ${provider}`);

  const midLat = (s + n) / 2;
  const dxM = cellLng * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const dyM = cellLat * 110_540;
  const idx = (r: number, c: number) => r * SLOPE_COLS + c;
  const clampC = (c: number) => Math.max(0, Math.min(SLOPE_COLS - 1, c));
  const clampR = (r: number) => Math.max(0, Math.min(SLOPE_ROWS - 1, r));

  const cells: SlopeCell[] = [];
  let maxSlope = 0;

  for (let r = 0; r < SLOPE_ROWS; r++) {
    for (let c = 0; c < SLOPE_COLS; c++) {
      // Horn's 3x3 finite difference — the standard GIS slope operator.
      // Edge cells clamp to themselves, which flattens the border by design.
      const z = (rr: number, cc: number) => elevations[idx(clampR(rr), clampC(cc))];
      const dzdx =
        (z(r - 1, c + 1) +
          2 * z(r, c + 1) +
          z(r + 1, c + 1) -
          (z(r - 1, c - 1) + 2 * z(r, c - 1) + z(r + 1, c - 1))) /
        (8 * dxM);
      const dzdy =
        (z(r + 1, c - 1) +
          2 * z(r + 1, c) +
          z(r + 1, c + 1) -
          (z(r - 1, c - 1) + 2 * z(r - 1, c) + z(r - 1, c + 1))) /
        (8 * dyM);

      const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      if (slopeDeg > maxSlope) maxSlope = slopeDeg;
      const aspect = ((((Math.atan2(-dzdy, -dzdx) * 180) / Math.PI + 450) % 360) + 360) % 360;

      cells.push({
        position: [q(lngs[idx(r, c)], 5), q(lats[idx(r, c)], 5)],
        elevation: Math.round(elevations[idx(r, c)]),
        slope: q(slopeDeg, 2),
        aspect: q(aspect, 1),
        // Rule of thumb, not a fire model: head-fire rate of spread roughly
        // doubles per 10 degrees of upslope. Stated in the note so nobody
        // reads it as Rothermel output.
        spreadFactor: q(Math.min(16, 2 ** (slopeDeg / 10)), 2),
      });
    }
  }

  const steep = cells.filter((c) => c.slope >= 15).length;
  log(
    `      ${cells.length} cells (${SLOPE_COLS}x${SLOPE_ROWS}, ~${Math.round(dxM)}x${Math.round(dyM)} m), ` +
      `max ${maxSlope.toFixed(1)}deg, ${steep} cells >= 15deg`,
  );

  const payload: SlopePayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    cols: SLOPE_COLS,
    rows: SLOPE_ROWS,
    cellDeg: [q(cellLng, 6), q(cellLat, 6)],
    cells,
    maxSlope: q(maxSlope, 2),
    source: provider,
    sourceUrl: providerUrl,
    note:
      "Elevation is measured. Slope and aspect are Horn's standard 3x3 finite difference on those " +
      "measurements — arithmetic, not a model. `spreadFactor` IS a heuristic: the widely used rule " +
      "of thumb that head-fire spread roughly doubles per 10 degrees of upslope. It is not " +
      "Rothermel output and must not be quoted as a predicted rate of spread.",
    generatedAt: new Date().toISOString(),
  };

  return {
    id: "slope",
    label: "Terrain slope",
    file: "slope.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: payload.sourceUrl,
    recordCount: cells.length,
    timeVarying: false,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Historical burn scars
// ─────────────────────────────────────────────────────────────────────────────

async function buildBurnScars(scenario: ScenarioMeta): Promise<BuiltLayer> {
  const eventYear = Number(scenario.eventDate.slice(0, 4));
  const [w, s, e, n] = padBbox(scenario.bbox as Bbox, 0.1);
  const where = `FIRE_YEAR_INT < ${eventYear} AND GIS_ACRES > ${BURN_MIN_ACRES}`;

  const scars: BurnScar[] = [];
  let offset = 0;
  let firstUrl = "";

  // The service caps a page at its transfer limit and flags it; paging on
  // resultOffset is the difference between "the last 30 fires" and all of them.
  for (let page = 0; page < 8; page++) {
    const url =
      `${NIFC_HISTORY}?` +
      new URLSearchParams({
        where,
        geometry: `${w},${s},${e},${n}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        // UNQE_FIRE_ID, not UNQE_FIRE_. An unknown field name here does NOT
        // return the documented `400 Invalid field` — in geojson mode the
        // service answers 200 with an empty FeatureCollection, which reads as
        // "no fires ever burned here". Verified; see research/.
        outFields: "INCIDENT,FIRE_YEAR_INT,GIS_ACRES,UNQE_FIRE_ID",
        returnGeometry: "true",
        outSR: "4326",
        // Biggest first, so a truncated pull still holds the scars that matter.
        orderByFields: "GIS_ACRES DESC",
        resultOffset: String(offset),
        resultRecordCount: "40",
        f: "geojson",
      }).toString();
    if (!firstUrl) firstUrl = url;

    const fc = await fetchJson<{
      features?: {
        properties: Record<string, string | number | null>;
        geometry: GeoJsonGeometry;
      }[];
      exceededTransferLimit?: boolean;
      properties?: { exceededTransferLimit?: boolean };
    }>(url, "nifc/history");

    const feats = fc.features ?? [];
    for (const f of feats) {
      // 0.004 deg is ~440 m. These draw stroke-only as historical context at
      // town scale; vertex fidelity beyond that is pure payload.
      const rings = outerRings(f.geometry, 0.004);
      if (rings.length === 0) continue;
      const year = Number(f.properties.FIRE_YEAR_INT) || 0;
      scars.push({
        id: String(f.properties.UNQE_FIRE_ID ?? `${f.properties.INCIDENT}-${year}-${scars.length}`),
        name: String(f.properties.INCIDENT ?? "Unnamed").trim(),
        year,
        acres: Math.round(Number(f.properties.GIS_ACRES) || 0),
        rings,
      });
    }
    offset += feats.length;
    const more = fc.exceededTransferLimit ?? fc.properties?.exceededTransferLimit ?? false;
    if (feats.length === 0 || !more || scars.length >= BURN_MAX_FEATURES) break;
  }

  if (scars.length === 0)
    throw new Error(`no prior perimeters over ${BURN_MIN_ACRES} acres in the bbox`);

  scars.sort((a, b) => b.year - a.year);
  const years = scars.map((s) => s.year).filter((y) => y > 0);
  const biggest = scars.reduce((a, b) => (b.acres > a.acres ? b : a));
  log(
    `      ${scars.length} prior perimeters over ${BURN_MIN_ACRES} ac, ${Math.min(...years)}–${Math.max(...years)} | ` +
      `largest ${biggest.name} ${biggest.year} at ${biggest.acres.toLocaleString()} ac`,
  );

  const payload: BurnScarPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    scars,
    yearRange: [Math.min(...years), Math.max(...years)],
    source: "NIFC InterAgency Fire Perimeter History",
    sourceUrl: firstUrl,
    note:
      "Mapped perimeters of fires that burned this terrain BEFORE the event, at least " +
      `${BURN_MIN_ACRES} acres. Fuel history, not the live hazard: a recent scar is fuel already ` +
      "consumed. Drawn stroke-only and age-faded so it can never be mistaken for the hazard front.",
    generatedAt: new Date().toISOString(),
  };

  return {
    id: "burnScars",
    label: "Historical burn scars",
    file: "burn-scars.json",
    payload,
    provenance: "observed",
    source: payload.source,
    sourceUrl: firstUrl,
    recordCount: scars.length,
    timeVarying: false,
    note: payload.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/** Label used in the manifest for a layer that did not build, so the UI can
 *  still name what is missing instead of showing a gap. */
const FALLBACK_LABEL: Record<ContextLayerId, string> = {
  // Renamed from "Air quality". This layer is a MONITOR NETWORK, and for the
  // Camp Fire its headline finding is where that network stopped reporting —
  // calling it "air quality" invited the reading that it maps the air, which it
  // does not. The gridded field that can honestly be called air quality is the
  // satellite AOD layer built by scripts/build-context-fields.ts.
  airQuality: "PM2.5 monitor coverage",
  aerosol: "Smoke column · AOD",
  fireIntensity: "Fire intensity · FRP",
  smoke: "Smoke plumes",
  transmission: "Transmission lines",
  socialVulnerability: "Social vulnerability",
  fireWeather: "Fire weather advisories",
  slope: "Terrain slope",
  burnScars: "Historical burn scars",
};

async function main() {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(
      `unknown scenario "${scenarioId}" — known: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }

  const clock = readClock(scenario);
  log(`[ctx] ${scenario.id} — ${scenario.place}`);
  log(
    `      T+0 = ${new Date(clock.startEpoch * 1000).toISOString()} (${clock.from}) | ` +
      `${clock.duration}s @ ${clock.frameStep}s | bbox ${scenario.bbox.join(",")}`,
  );

  const builders: { id: ContextLayerId; run: () => Promise<BuiltLayer> }[] = [
    { id: "airQuality", run: () => buildAirQuality(scenario, clock) },
    { id: "fireIntensity", run: () => buildFireIntensity(scenario, clock) },
    { id: "smoke", run: () => buildSmoke(scenario, clock) },
    { id: "transmission", run: () => buildTransmission(scenario) },
    { id: "socialVulnerability", run: () => buildSvi(scenario) },
    { id: "fireWeather", run: () => buildFireWeather(scenario, clock) },
    { id: "slope", run: () => buildSlope(scenario) },
    { id: "burnScars", run: () => buildBurnScars(scenario) },
  ];

  const outDir = join(repoRoot(), "public", "data", scenario.id, "context");
  mkdirSync(outDir, { recursive: true });

  const entries: ContextLayerEntry[] = [];
  let step = 0;

  for (const b of builders) {
    step++;
    log(`[${step}/${builders.length}] ${b.id}`);
    try {
      const built = await b.run();
      const json = JSON.stringify(built.payload);
      writeFileSync(join(outDir, built.file), json);
      const bytes = Buffer.byteLength(json);
      entries.push({
        id: built.id,
        label: built.label,
        file: built.file,
        available: true,
        provenance: built.provenance,
        source: built.source,
        sourceUrl: built.sourceUrl,
        recordCount: built.recordCount,
        timeVarying: built.timeVarying,
        bytes,
        note: built.note,
      });
      log(
        `      OK ${built.file} — ${(bytes / 1024).toFixed(1)} KB, ${built.recordCount} records, ${built.provenance.toUpperCase()}`,
      );
    } catch (err) {
      const reason = (err as Error).message;
      entries.push({
        id: b.id,
        label: FALLBACK_LABEL[b.id],
        file: null,
        available: false,
        // A layer that did not build has no data to mislabel; "observed" is
        // the neutral value and `available: false` is what the UI reads.
        provenance: "observed",
        source: "",
        sourceUrl: "",
        recordCount: 0,
        timeVarying: false,
        bytes: 0,
        note: "Layer unavailable — the toggle is hidden, nothing is substituted.",
        reason,
      });
      warn(`SKIPPED ${b.id}: ${reason.slice(0, 300)}`);
    }
  }

  const manifest: ContextManifest = {
    scenarioId: scenario.id,
    generatedAt: new Date().toISOString(),
    scenarioStartEpoch: clock.startEpoch,
    layers: entries,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(join(outDir, "index.json"), manifestJson);

  const ok = entries.filter((e) => e.available);
  const modelled = ok.filter((e) => e.provenance === "modelled");
  const totalBytes = ok.reduce((sum, e) => sum + e.bytes, 0) + Buffer.byteLength(manifestJson);

  log("");
  log(
    `[done] ${ok.length}/${entries.length} layers built — ${(totalBytes / 1024).toFixed(1)} KB total`,
  );
  for (const e of entries) {
    log(
      e.available
        ? `      + ${e.id.padEnd(20)} ${String(e.recordCount).padStart(6)} rec  ${(e.bytes / 1024).toFixed(1).padStart(7)} KB  ${e.provenance}${e.timeVarying ? "  time-varying" : ""}`
        : `      - ${e.id.padEnd(20)} UNAVAILABLE — ${e.reason?.slice(0, 110)}`,
    );
  }
  if (modelled.length > 0) {
    loud(
      `${modelled.length} layer(s) are MODELLED, not observed: ${modelled.map((m) => m.id).join(", ")}. ` +
        `The manifest and the UI toggle both say so.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * fetch-hazard.ts — build the timestamped HazardTrack for a scenario.
 *
 *   npx tsx scripts/fetch-hazard.ts [scenarioId] [--source=lng,lat] [--rays=N]
 *
 * Wildfire path
 *   PRIMARY   NIFC GeoMAC 2018 daily-progression perimeters (real, dated observations)
 *   FALLBACK  NIFC InterAgencyFirePerimeterHistory (final perimeter only)
 *   SECONDARY NASA FIRMS archive hotspots (needs FIRMS_MAP_KEY)
 *
 * The archive gives a handful of dated perimeters, not a frame every 5 minutes. The
 * observed ones are emitted verbatim as anchors; everything between them is a modelled
 * fill and is labelled "interpolated". Before the first anchor the fill is an Anderson
 * fire ellipse grown from the ignition point along the wind, clipped by the first
 * observed perimeter so the model can never claim ground the observation didn't.
 * Between anchors it is a radial morph. Nothing is silently passed off as observed.
 *
 * Plume path
 *   Gaussian ground-level footprint from a point source, advected along the integrated
 *   hourly wind track. All frames are modelled — no observed plume archive exists.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCENARIOS } from "../src/lib/constants";
import type {
  HazardFrame,
  HazardKind,
  HazardTrack,
  LngLat,
  RoadNetwork,
  ScenarioMeta,
  Tick,
  WindSample,
} from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * T+0 is the scenario's local start hour, which lives on ScenarioMeta so the
 * hazard clock, the weather pull and the UI scrubber cannot disagree. A private
 * copy here used to force every scenario to 06:00 — for a mid-morning ignition
 * that silently shifted the whole wind track against the fire.
 */
const DEFAULT_T0_LOCAL_HOUR = 6;

/** UTC offset in effect at the event, hours. Camp Fire and Palisades = PST, BioLab = EDT, Marshall = MST. */
const UTC_OFFSET_HOURS: Record<string, number> = {
  "camp-fire-2018": -8,
  "conyers-plume-2024": -4,
  "marshall-fire-2021": -7,
  "palisades-fire-2025": -8,
};

interface IgnitionSpec {
  point: LngLat;
  /** ISO UTC instant of ignition / release start. */
  atUtc: string;
  note: string;
  /** True when the coordinate is our best reading rather than a fetched record. */
  approximate: boolean;
}

const IGNITION: Record<string, IgnitionSpec> = {
  "camp-fire-2018": {
    point: [-121.4347, 39.8136],
    atUtc: "2018-11-08T14:33:00Z",
    note: "Camp Creek Rd near Pulga, 06:33 PST",
    approximate: false,
  },
  "conyers-plume-2024": {
    point: [-83.9884, 33.6669],
    atUtc: "2024-09-29T09:30:00Z",
    note: "BioLab warehouse, Old Covington Rd — 05:30 EDT",
    approximate: true,
  },
  "marshall-fire-2021": {
    point: [-105.1783, 39.9633],
    atUtc: "2021-12-30T18:00:00Z",
    note: "Marshall Rd / CO-93, 11:00 MST",
    approximate: true,
  },
  // Both coordinate and instant are FETCHED, not authored: the point is the
  // CAL FIRE incident record's Latitude/Longitude, the instant is its Started
  // field, which agrees to the minute with WFIGS attr_FireDiscoveryDateTime.
  // Flagged approximate because the two agencies' points of origin disagree by
  // 750 m — WFIGS puts it at -118.55112,34.06778 — and both are dispatch-entered.
  // Both fall inside the fetched final perimeter.
  "palisades-fire-2025": {
    point: [-118.54453, 34.07022],
    atUtc: "2025-01-07T18:30:00Z",
    note: "Southeast of Palisades Drive, Pacific Palisades — 10:30 PST (CAL FIRE incident record)",
    approximate: true,
  },
};

const ARCGIS_NIFC = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";

interface PerimeterSource {
  label: string;
  url: string;
  where: string;
  /** Field holding the observation instant. Epoch-ms number, or an ISO string. */
  timeField: string;
  outFields: string;
}

/** Ordered by preference — first source that returns usable features wins. */
const PERIMETER_SOURCES: Record<string, PerimeterSource[]> = {
  "camp-fire-2018": [
    {
      label: "NIFC GeoMAC 2018 progression",
      url: `${ARCGIS_NIFC}/Historic_Geomac_Perimeters_2018/FeatureServer/0/query`,
      where: "uniquefireidentifier='2018-CABTU-016737'",
      timeField: "perimeterdatetime",
      outFields: "OBJECTID,incidentname,perimeterdatetime,gisacres,mapmethod",
    },
    {
      label: "NIFC InterAgencyFirePerimeterHistory",
      url: `${ARCGIS_NIFC}/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query`,
      where: "UNQE_FIRE_ID='2018-CABTU-016737'",
      timeField: "DATE_CUR",
      outFields: "OBJECTID,INCIDENT,DATE_CUR,GIS_ACRES,MAP_METHOD",
    },
  ],
  "marshall-fire-2021": [
    {
      label: "NIFC InterAgencyFirePerimeterHistory",
      url: `${ARCGIS_NIFC}/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query`,
      where: "INCIDENT='MARSHALL' AND FIRE_YEAR_INT=2021",
      timeField: "DATE_CUR",
      outFields: "OBJECTID,INCIDENT,DATE_CUR,GIS_ACRES,MAP_METHOD",
    },
  ],
  // 2025 has no GeoMAC-style progression layer — that series stopped at 2019 —
  // and InterAgencyFirePerimeterHistory carries no 2025 records yet, so the only
  // observation available is the single WFIGS perimeter. Note the field schema
  // here is the poly_*/attr_* one; the historic layer's INCIDENT/FIRE_YEAR_INT
  // names return 400 Invalid field against this service and vice versa.
  "palisades-fire-2025": [
    {
      label: "NIFC WFIGS Interagency Perimeters",
      url: `${ARCGIS_NIFC}/WFIGS_Interagency_Perimeters/FeatureServer/0/query`,
      where: "attr_UniqueFireIdentifier='2025-CALFD-000738'",
      // poly_DateCurrent is when the RECORD was last touched (21 Jan, three
      // weeks out); poly_PolygonDateTime is the instant the polygon depicts.
      // The two disagree with the geometry, which is the final 23,448-acre
      // extent — see research/endpoint-verification.md. Using the polygon
      // instant makes the modelled pre-anchor growth land near the reported
      // acreage; using DateCurrent would flatten the fire to nothing in-window.
      timeField: "poly_PolygonDateTime",
      outFields: "OBJECTID,poly_IncidentName,poly_PolygonDateTime,poly_GISAcres,poly_MapMethod",
    },
  ],
};

/**
 * Documented synthetic anchors, used ONLY when every upstream perimeter call fails.
 * Areas are the published acreages for those instants, so the synthetic fire is at
 * least the right size even when its shape is invented.
 */
const SYNTHETIC_ANCHORS: Record<string, { atUtc: string; km2: number }[]> = {
  "camp-fire-2018": [
    { atUtc: "2018-11-08T17:54:00Z", km2: 220.9 }, // 54,586 acres
    { atUtc: "2018-11-09T00:00:00Z", km2: 285.1 }, // 70,454 acres
  ],
  "marshall-fire-2021": [{ atUtc: "2021-12-31T02:00:00Z", km2: 24.3 }],
  "palisades-fire-2025": [
    { atUtc: "2025-01-08T14:31:44Z", km2: 94.9 }, // 23,448 acres, WFIGS final
  ],
};

/** Wind used when weather.json is absent. Task-specified: from the NE at 12 m/s. */
const DEFAULT_WIND = { speed: 12, direction: 45 };

/** Rays in the polar morph. 240 gives ~1.5 degree resolution — smooth at city zoom. */
const DEFAULT_RAYS = 240;

/** Douglas–Peucker tolerance for observed rings, metres. */
const SIMPLIFY_M = 25;

/**
 * Exponent relating burnt-area fraction to cumulative-wind-run fraction. An ellipse
 * whose axes both scale with head length has area proportional to length squared, so
 * 2.0 is the value that makes head length linear in the wind run — the standard
 * steady-rate-of-spread assumption, not a fitted knob.
 */
const GROWTH_EXPONENT = 2.0;

/**
 * Plume shape constant Q/C_threshold in m^3/s. This is a FOOTPRINT SHAPE parameter
 * tuned so the contour reaches ~12 km at 4 m/s under Pasquill D — it is not a real
 * source term and must not be read as one.
 */
const PLUME_K = 1.35e6;

const RAD = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const notes: string[] = [];

function log(stage: string, msg: string): void {
  console.log(`[hazard] ${stage.padEnd(11)} ${msg}`);
}

function loud(msg: string): void {
  const line = `!!! SYNTHETIC / DEGRADED: ${msg}`;
  console.log(
    `\n${"!".repeat(Math.min(100, line.length))}\n${line}\n${"!".repeat(Math.min(100, line.length))}\n`,
  );
  notes.push(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths, env, cache
// ─────────────────────────────────────────────────────────────────────────────

function findRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(cur, "package.json"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return start;
}

const ROOT = findRoot(process.cwd());
const CACHE_DIR = path.join(ROOT, "scripts", ".cache", "hazard");

function loadEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
  } catch {
    // Node < 20.12 has no loadEnvFile; the key stays unset and FIRMS is skipped.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cachedFetch(key: string, url: string, timeoutMs = 90_000): Promise<string | null> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${key}.txt`);
  if (existsSync(file)) {
    const cached = await readFile(file, "utf8");
    if (cached.length > 0) return cached;
  }
  let backoff = 1500;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "egress-pipeline/0.1 (evacuation planning research)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length === 0) throw new Error("empty body");
      await writeFile(file, text, "utf8");
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("fetch", `attempt ${attempt}/4 failed (${msg}) — ${url.slice(0, 96)}`);
      if (attempt === 4) return null;
      await sleep(backoff);
      backoff *= 2;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry — a local equirectangular metre frame, accurate enough over one county
// ─────────────────────────────────────────────────────────────────────────────

type Pt = [number, number];

class Frame2D {
  private readonly mx: number;
  private readonly my = 110_540;
  constructor(private readonly origin: LngLat) {
    this.mx = 111_320 * Math.cos(origin[1] * RAD);
  }
  to(p: LngLat | number[]): Pt {
    return [(p[0] - this.origin[0]) * this.mx, (p[1] - this.origin[1]) * this.my];
  }
  from(p: Pt): LngLat {
    return [round5(this.origin[0] + p[0] / this.mx), round5(this.origin[1] + p[1] / this.my)];
  }
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function ringAreaM2(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function bboxOf(ring: Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

function simplify(ring: Pt[], tol: number): Pt[] {
  if (ring.length < 24) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop() as [number, number];
    let best = -1;
    let bestD = tol;
    const [sx, sy] = ring[s];
    const [ex, ey] = ring[e];
    const dx = ex - sx;
    const dy = ey - sy;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = ring[i];
      let t = ((px - sx) * dx + (py - sy) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = sx + t * dx;
      const qy = sy + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 4 ? out : ring;
}

/**
 * Farthest boundary crossing along each ray from the origin. The fire perimeter is
 * treated as star-shaped about the ignition point; taking the farthest crossing makes
 * the morph conservative (it never under-claims a re-entrant lobe).
 */
function radiusProfile(ring: Pt[], rays: number): Float64Array {
  const out = new Float64Array(rays);
  for (let k = 0; k < rays; k++) {
    const th = (k / rays) * Math.PI * 2;
    const rx = Math.cos(th);
    const ry = Math.sin(th);
    let best = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const sx = b[0] - a[0];
      const sy = b[1] - a[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = (a[0] * sy - a[1] * sx) / den;
      const u = (a[0] * ry - a[1] * rx) / den;
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    out[k] = best;
  }
  return out;
}

function ringFromRadii(r: Float64Array, frame: Frame2D): LngLat[] {
  const out: LngLat[] = [];
  for (let k = 0; k < r.length; k++) {
    if (r[k] <= 0) continue;
    const th = (k / r.length) * Math.PI * 2;
    out.push(frame.from([Math.cos(th) * r[k], Math.sin(th) * r[k]]));
  }
  return out.length >= 4 ? out : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Wind
// ─────────────────────────────────────────────────────────────────────────────

interface WindSeries {
  samples: WindSample[];
  synthetic: boolean;
  source: string;
}

function isWindSample(v: unknown): v is WindSample {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.t === "number" && typeof o.speed === "number" && typeof o.direction === "number";
}

/**
 * weather.json is written by a sibling script whose exact envelope isn't fixed yet,
 * so accept the plausible shapes rather than hard-failing the whole pipeline.
 */
function parseWeather(raw: unknown): WindSample[] | null {
  const candidates: unknown[] = [];
  if (Array.isArray(raw)) candidates.push(raw);
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    for (const key of ["wind", "samples", "series", "hourly", "winds"]) {
      if (key in o) candidates.push(o[key]);
    }
    // Raw Open-Meteo passthrough.
    const h = o.hourly as Record<string, unknown> | undefined;
    if (h && Array.isArray(h.time) && Array.isArray(h.wind_speed_10m)) {
      const times = h.time as string[];
      const spd = h.wind_speed_10m as number[];
      const dir = (h.wind_direction_10m as number[] | undefined) ?? [];
      return times.map((iso, i) => ({
        t: Date.parse(`${iso}Z`),
        speed: spd[i] ?? DEFAULT_WIND.speed,
        direction: dir[i] ?? DEFAULT_WIND.direction,
      }));
    }
  }
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && c.every(isWindSample)) return c as WindSample[];
  }
  return null;
}

/** Sibling scripts may emit ticks or raw epoch-ms; anything huge is an instant. */
function normaliseTicks(samples: WindSample[], t0Ms: number): WindSample[] {
  return samples.map((s) =>
    Math.abs(s.t) > 1e10 ? { ...s, t: Math.round((s.t - t0Ms) / 1000) } : s,
  );
}

async function loadWind(scenario: ScenarioMeta, t0Ms: number): Promise<WindSeries> {
  const file = path.join(ROOT, "public", "data", scenario.id, "weather.json");
  if (existsSync(file)) {
    try {
      const raw = parseWeather(JSON.parse(await readFile(file, "utf8")));
      const parsed = raw ? normaliseTicks(raw, t0Ms).sort((a, b) => a.t - b.t) : null;
      if (parsed && parsed.length > 0) {
        log(
          "wind",
          `weather.json → ${parsed.length} samples, t ${parsed[0].t}s..${parsed[parsed.length - 1].t}s`,
        );
        return { samples: parsed, synthetic: false, source: "weather.json (observed archive)" };
      }
      loud("weather.json exists but no WindSample[] could be read from it — using default wind.");
    } catch (err) {
      loud(
        `weather.json unreadable (${err instanceof Error ? err.message : String(err)}) — using default wind.`,
      );
    }
  } else {
    loud(
      `weather.json missing for ${scenario.id} — WIND IS SYNTHETIC: constant ${DEFAULT_WIND.speed} m/s from ${DEFAULT_WIND.direction} deg (NE, driving SW). ` +
        "Note: `npm run data:all` runs data:hazard BEFORE data:weather, so this fires on a first full run. Re-run `npm run data:hazard` after data:weather for real wind.",
    );
  }
  const samples: WindSample[] = [];
  for (let t = 0; t <= scenario.duration; t += 3600) {
    samples.push({ t, speed: DEFAULT_WIND.speed, direction: DEFAULT_WIND.direction });
  }
  return {
    samples,
    synthetic: true,
    source: `synthetic constant wind ${DEFAULT_WIND.speed} m/s from ${DEFAULT_WIND.direction} deg`,
  };
}

function windAt(series: WindSample[], t: Tick): { speed: number; direction: number } {
  if (series.length === 0) return DEFAULT_WIND;
  if (t <= series[0].t) return series[0];
  const last = series[series.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (i < series.length - 2 && series[i + 1].t < t) i++;
  const a = series[i];
  const b = series[i + 1];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const dd = ((b.direction - a.direction + 540) % 360) - 180; // shortest arc
  return {
    speed: a.speed + (b.speed - a.speed) * f,
    direction: (a.direction + dd * f + 360) % 360,
  };
}

/** Spread heading in radians, math convention (CCW from +x). Wind direction is FROM. */
function headingRad(windDirection: number): number {
  const towards = (windDirection + 180) % 360; // meteorological bearing the fire runs toward
  return Math.PI / 2 - towards * RAD;
}

/** Time-weighted mean spread heading over [t0, t], so a wind shift bends the run. */
function meanHeading(series: WindSample[], t0: Tick, t: Tick): number {
  if (t <= t0) return headingRad(windAt(series, t0).direction);
  let sx = 0;
  let sy = 0;
  const step = Math.max(300, (t - t0) / 24);
  for (let s = t0; s <= t; s += step) {
    const w = windAt(series, s);
    const h = headingRad(w.direction);
    sx += Math.cos(h) * w.speed;
    sy += Math.sin(h) * w.speed;
  }
  return Math.atan2(sy, sx);
}

/**
 * Gusts, not the hourly mean, drive a wind-driven run and the spotting ahead of it,
 * so the gust is the spread driver wherever the archive carries one.
 */
function spreadDriver(w: { speed: number; gust?: number }): number {
  return Math.max(w.speed, typeof w.gust === "number" ? w.gust * 0.8 : 0);
}

/** Cumulative wind run over [a, b] in metres — the rate term of the growth law. */
function windRun(series: WindSample[], a: Tick, b: Tick): number {
  if (b <= a) return 0;
  const step = Math.max(60, (b - a) / 96);
  let sum = 0;
  for (let s = a; s < b; s += step) {
    const seg = Math.min(step, b - s);
    sum += spreadDriver(sampleAt(series, s + seg / 2)) * seg;
  }
  return sum;
}

function sampleAt(series: WindSample[], t: Tick): WindSample {
  if (series.length === 0) return { t, ...DEFAULT_WIND };
  let i = 0;
  while (i < series.length - 1 && series[i + 1].t <= t) i++;
  return series[i];
}

/** Anderson 1983 length-to-breadth ratio from mid-flame wind speed (m/s). */
function lengthToBreadth(u: number): number {
  const lb = 0.936 * Math.exp(0.2566 * u) + 0.461 * Math.exp(-0.1548 * u) - 0.397;
  return Math.min(8, Math.max(1.1, lb));
}

/** Normalised fire ellipse with the ignition at the rear focus; 1 at the head. */
function ellipseShape(theta: number, head: number, e: number): number {
  return (1 - e) / (1 - e * Math.cos(theta - head));
}

// ─────────────────────────────────────────────────────────────────────────────
// Perimeter anchors
// ─────────────────────────────────────────────────────────────────────────────

interface Anchor {
  t: Tick;
  atUtc: string;
  /** Outer rings only, holes dropped — a hole is unburnt ground we conservatively burn. */
  rings: Pt[][];
  areaKm2: number;
  label: string;
  observed: boolean;
}

function scenarioT0Ms(s: ScenarioMeta): number {
  const off = UTC_OFFSET_HOURS[s.id] ?? -8;
  const hour = s.startHourLocal ?? DEFAULT_T0_LOCAL_HOUR;
  return Date.parse(`${s.eventDate}T00:00:00Z`) + (hour - off) * 3_600_000;
}

function parseInstant(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function outerRings(geometry: unknown): number[][][] {
  if (typeof geometry !== "object" || geometry === null) return [];
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    return [(g.coordinates as number[][][])[0]];
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    return (g.coordinates as number[][][][]).map((poly) => poly[0]).filter(Boolean);
  }
  return [];
}

async function fetchAnchors(
  scenario: ScenarioMeta,
  frame: Frame2D,
  t0Ms: number,
): Promise<{ anchors: Anchor[]; source: string }> {
  const [qw, qs, qe, qn] = scenario.bbox;
  const sources = [
    ...(PERIMETER_SOURCES[scenario.id] ?? []),
    // Last resort for any wildfire we have no named query for: everything in the
    // event year whose footprint intersects the scenario bbox.
    {
      label: "NIFC IFPH bbox sweep",
      url: `${ARCGIS_NIFC}/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query`,
      where: `FIRE_YEAR_INT=${new Date(scenario.eventDate).getUTCFullYear()}`,
      timeField: "DATE_CUR",
      outFields: "OBJECTID,INCIDENT,DATE_CUR,GIS_ACRES,MAP_METHOD",
      spatial: `&geometry=${qw},${qs},${qe},${qn}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`,
    },
  ];
  for (const src of sources) {
    const url =
      `${src.url}?where=${encodeURIComponent(src.where)}` +
      `&outFields=${encodeURIComponent(src.outFields)}` +
      ("spatial" in src && typeof src.spatial === "string" ? src.spatial : "") +
      "&outSR=4326&returnGeometry=true&maxAllowableOffset=0.0004&geometryPrecision=5&f=geojson";
    log("perimeter", `querying ${src.label}`);
    const text = await cachedFetch(`perims-${scenario.id}-${src.label.replace(/\W+/g, "-")}`, url);
    if (!text) {
      log("perimeter", `${src.label} — no response`);
      continue;
    }
    let fc: { features?: unknown[]; error?: unknown };
    try {
      fc = JSON.parse(text);
    } catch {
      log("perimeter", `${src.label} — response was not JSON`);
      continue;
    }
    if (fc.error || !Array.isArray(fc.features) || fc.features.length === 0) {
      log("perimeter", `${src.label} — 0 features`);
      continue;
    }

    const [bw, bs, be, bn] = scenario.bbox;
    const anchors: Anchor[] = [];
    for (const raw of fc.features) {
      const f = raw as { properties?: Record<string, unknown>; geometry?: unknown };
      const props = f.properties ?? {};
      const ms = parseInstant(props[src.timeField]);
      if (ms === null) continue;
      const rings = outerRings(f.geometry)
        .map((r) => r.map((c) => frame.to(c)))
        .filter((r) => r.length >= 4);
      if (rings.length === 0) continue;
      // Keep only perimeters that actually touch the scenario window.
      const inBbox = rings.some((r) =>
        r.some((p) => {
          const ll = frame.from(p);
          return ll[0] >= bw - 0.3 && ll[0] <= be + 0.3 && ll[1] >= bs - 0.3 && ll[1] <= bn + 0.3;
        }),
      );
      if (!inBbox) continue;
      const simplified = rings.map((r) => simplify(r, SIMPLIFY_M));
      simplified.sort((a, b) => ringAreaM2(b) - ringAreaM2(a));
      anchors.push({
        t: Math.round((ms - t0Ms) / 1000),
        atUtc: new Date(ms).toISOString(),
        rings: simplified,
        areaKm2: simplified.reduce((s, r) => s + ringAreaM2(r), 0) / 1e6,
        label: src.label,
        observed: true,
      });
    }
    if (anchors.length === 0) {
      log("perimeter", `${src.label} — features returned but none intersect the scenario bbox`);
      continue;
    }
    anchors.sort((a, b) => a.t - b.t);
    // A midnight-UTC timestamp in GeoMAC usually means date-only precision on the
    // submission, not a perimeter mapped at exactly 00:00 — treat those anchors as
    // day-resolution when reading the timeline.
    // De-duplicate perimeters mapped twice on the same pass; keep the larger.
    const deduped: Anchor[] = [];
    for (const a of anchors) {
      const prev = deduped[deduped.length - 1];
      if (prev && Math.abs(prev.t - a.t) < 600) {
        if (a.areaKm2 > prev.areaKm2) deduped[deduped.length - 1] = a;
      } else deduped.push(a);
    }
    log(
      "perimeter",
      `${src.label} → ${deduped.length} dated perimeters, ` +
        `t ${deduped[0].t}s..${deduped[deduped.length - 1].t}s, ` +
        `${deduped[0].areaKm2.toFixed(1)}..${deduped[deduped.length - 1].areaKm2.toFixed(1)} km2`,
    );
    return { anchors: deduped, source: `${src.label} (${src.url})` };
  }

  // Every upstream failed — build the documented synthetic ellipse chain.
  const spec = SYNTHETIC_ANCHORS[scenario.id] ?? [
    { atUtc: new Date(t0Ms + scenario.duration * 600).toISOString(), km2: 100 },
  ];
  loud(
    `No perimeter source returned usable features for ${scenario.id} — PERIMETERS ARE SYNTHETIC: ` +
      `wind-oriented ellipses sized to the published acreages (${spec.map((s) => `${s.km2} km2 @ ${s.atUtc}`).join(", ")}). ` +
      "Every frame is labelled interpolated; nothing here is an observation.",
  );
  return { anchors: [], source: "SYNTHETIC ellipse chain (no upstream perimeter available)" };
}

/** Build a synthetic anchor of a target area, oriented downwind. */
function syntheticAnchor(km2: number, head: number, e: number, rays: number): Pt[] {
  const unit = new Float64Array(rays);
  for (let k = 0; k < rays; k++) unit[k] = ellipseShape((k / rays) * Math.PI * 2, head, e);
  const proto: Pt[] = [];
  for (let k = 0; k < rays; k++) {
    const th = (k / rays) * Math.PI * 2;
    proto.push([Math.cos(th) * unit[k], Math.sin(th) * unit[k]]);
  }
  const scale = Math.sqrt((km2 * 1e6) / ringAreaM2(proto));
  return proto.map(([x, y]) => [x * scale, y * scale] as Pt);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRMS hotspots
// ─────────────────────────────────────────────────────────────────────────────

interface Hotspot {
  t: Tick;
  lngLat: LngLat;
}

async function fetchHotspots(scenario: ScenarioMeta, t0Ms: number): Promise<Hotspot[]> {
  const key = process.env.FIRMS_MAP_KEY?.trim();
  if (!key) {
    log("firms", "FIRMS_MAP_KEY not set — skipping hotspots (perimeters are unaffected)");
    notes.push("NASA FIRMS hotspots skipped: FIRMS_MAP_KEY not set.");
    return [];
  }
  const [w, s, e, n] = scenario.bbox;
  const area = `${w},${s},${e},${n}`;
  const out: Hotspot[] = [];
  for (const product of ["VIIRS_SNPP_SP", "MODIS_SP", "VIIRS_SNPP_NRT"]) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${product}/${area}/2/${scenario.eventDate}`;
    const text = await cachedFetch(`firms-${scenario.id}-${product}`, url, 60_000);
    if (!text) continue;
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2 || !/latitude/i.test(lines[0])) {
      log("firms", `${product} — no CSV (${lines[0]?.slice(0, 80) ?? "empty"})`);
      continue;
    }
    const cols = lines[0].split(",").map((c) => c.trim().toLowerCase());
    const iLat = cols.indexOf("latitude");
    const iLng = cols.indexOf("longitude");
    const iDate = cols.indexOf("acq_date");
    const iTime = cols.indexOf("acq_time");
    if (iLat < 0 || iLng < 0 || iDate < 0 || iTime < 0) continue;
    for (const line of lines.slice(1)) {
      const p = line.split(",");
      const lat = Number(p[iLat]);
      const lng = Number(p[iLng]);
      const hhmm = String(p[iTime] ?? "").padStart(4, "0");
      const ms = Date.parse(`${p[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(ms)) continue;
      out.push({ t: Math.round((ms - t0Ms) / 1000), lngLat: [round5(lng), round5(lat)] });
    }
    log("firms", `${product} → ${out.length} detections in bbox`);
    if (out.length > 0) break;
  }
  if (out.length === 0) notes.push("NASA FIRMS returned no usable detections for this bbox/date.");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wildfire frame construction
// ─────────────────────────────────────────────────────────────────────────────

interface BuiltFrame {
  t: Tick;
  rings: LngLat[][];
  ringsM: Pt[][];
  provenance: "observed" | "interpolated";
}

function buildWildfireFrames(
  scenario: ScenarioMeta,
  frame: Frame2D,
  anchors: Anchor[],
  ignitionT: Tick,
  wind: WindSample[],
  rays: number,
): BuiltFrame[] {
  const half = scenario.frameStep / 2;

  // If upstream gave nothing, manufacture the documented synthetic anchor chain.
  let chain = anchors;
  if (chain.length === 0) {
    const t0Ms = scenarioT0Ms(scenario);
    const spec = SYNTHETIC_ANCHORS[scenario.id] ?? [
      { atUtc: new Date(t0Ms + scenario.duration * 600).toISOString(), km2: 100 },
    ];
    chain = spec.map((s) => {
      const t = Math.round((Date.parse(s.atUtc) - t0Ms) / 1000);
      const head = meanHeading(wind, ignitionT, t);
      const e = eccentricity(lengthToBreadth(windAt(wind, t).speed));
      return {
        t,
        atUtc: s.atUtc,
        rings: [syntheticAnchor(s.km2, head, e, rays)],
        areaKm2: s.km2,
        label: "synthetic ellipse",
        observed: false,
      };
    });
  }

  const profiles = chain.map((a) => radiusProfile(a.rings[0], rays));
  const first = chain[0];
  const firstProfile = profiles[0];

  /**
   * Run direction. A 25 km reanalysis cell does not resolve a downslope canyon wind —
   * for the Camp Fire ERA5 has the surface wind veering west by mid-morning while the
   * fire was still driving southwest. When an observation exists, the vector from the
   * ignition to the burnt area's centroid IS the observed run, so it wins; wind is
   * still what sets the elongation and the rate. Wind orients the run only when there
   * is nothing observed to orient against.
   *
   * The anchor has to lie inside the replay window for that argument to hold. The
   * only Palisades perimeter is the FINAL 23,448-acre extent, three weeks of
   * westward spread into Malibu; its centroid points west while the fire spent the
   * replayed eight hours running south to the coast. An anchor past the end of the
   * window describes a run the window never shows, so wind orients the fill instead.
   */
  const windHead = meanHeading(wind, ignitionT, first.t);
  let head = windHead;
  const anchorInWindow = first.t <= scenario.duration;
  if (first.observed && !anchorInWindow) {
    log(
      "orient",
      `only anchor is at T+${first.t}s, past the T+${scenario.duration}s window — ` +
        "orienting the fill on observed wind, not on the anchor centroid",
    );
    notes.push(
      `Pre-anchor fill is oriented on observed WIND: the single available perimeter sits at T+${first.t}s, ` +
        `${(first.t / 3600).toFixed(1)} h past the end of the ${(scenario.duration / 3600).toFixed(0)} h replay, ` +
        "so its shape describes spread the replay does not cover.",
    );
  }
  if (first.observed && anchorInWindow) {
    let cx = 0;
    let cy = 0;
    let wsum = 0;
    for (let k = 0; k < rays; k++) {
      const th = (k / rays) * Math.PI * 2;
      const w = firstProfile[k] * firstProfile[k];
      cx += Math.cos(th) * firstProfile[k] * w;
      cy += Math.sin(th) * firstProfile[k] * w;
      wsum += w;
    }
    if (wsum > 0) head = Math.atan2(cy / wsum, cx / wsum);
    const deltaDeg = Math.abs((((windHead - head) * (180 / Math.PI) + 540) % 360) - 180);
    log(
      "orient",
      `observed run bearing ${((90 - (head * 180) / Math.PI + 360) % 360).toFixed(0)} deg, ` +
        `wind-derived ${((90 - (windHead * 180) / Math.PI + 360) % 360).toFixed(0)} deg — ${deltaDeg.toFixed(0)} deg apart; using the observed run`,
    );
    if (deltaDeg > 45) {
      notes.push(
        `Pre-anchor fill is oriented on the OBSERVED run bearing, ${deltaDeg.toFixed(0)} deg off the archived surface wind — the reanalysis cell does not resolve the local wind that drove this fire.`,
      );
    }
  }

  const eHead = eccentricity(lengthToBreadth(spreadDriver(sampleAt(wind, ignitionT))));
  const shape = new Float64Array(rays);
  for (let k = 0; k < rays; k++) shape[k] = ellipseShape((k / rays) * Math.PI * 2, head, eHead);

  const polarArea = (r: Float64Array): number => {
    const c = 0.5 * Math.sin((2 * Math.PI) / rays);
    let a = 0;
    for (let k = 0; k < rays; k++) a += r[k] * r[(k + 1) % rays];
    return a * c;
  };
  const anchorArea = polarArea(firstProfile);
  const totalRun = windRun(wind, ignitionT, first.t);

  /**
   * Scale the ellipse so the burnt AREA at t matches the wind-run fraction, rather
   * than scaling the head length directly. Normalising on area is what keeps the fill
   * stable: a head-length scale is set by whichever single ray has the worst
   * radius-to-shape ratio, which makes the whole sequence hostage to one lobe.
   */
  const clippedAt = (l: number, out: Float64Array): number => {
    for (let k = 0; k < rays; k++) out[k] = Math.min(l * shape[k], firstProfile[k]);
    return polarArea(out);
  };
  const scratch = new Float64Array(rays);
  const solveForArea = (target: number, out: Float64Array): void => {
    if (target <= 0) {
      out.fill(0);
      return;
    }
    let hi = 500;
    while (clippedAt(hi, scratch) < target && hi < 5e6) hi *= 2;
    let lo = 0;
    for (let i = 0; i < 44; i++) {
      const mid = (lo + hi) / 2;
      if (clippedAt(mid, scratch) < target) lo = mid;
      else hi = mid;
    }
    clippedAt(hi, out);
  };

  const out: BuiltFrame[] = [];
  const prev = new Float64Array(rays);
  /** Secondary fire fronts from the most recent observation, held so they don't flicker. */
  let carriedSpots: Pt[][] = [];

  for (let t = 0; t <= scenario.duration; t += scenario.frameStep) {
    const anchorIdx = chain.findIndex((a) => a.observed && Math.abs(a.t - t) <= half);
    if (anchorIdx >= 0) {
      const a = chain[anchorIdx];
      const p = profiles[anchorIdx];
      for (let k = 0; k < rays; k++) prev[k] = Math.max(prev[k], p[k]);
      carriedSpots = a.rings.slice(1);
      out.push({
        t,
        rings: a.rings.map((r) => r.map((pt) => frame.from(pt))),
        ringsM: a.rings,
        provenance: "observed",
      });
      continue;
    }

    if (t < ignitionT) {
      out.push({ t, rings: [], ringsM: [], provenance: "interpolated" });
      continue;
    }

    const r = new Float64Array(rays);
    if (t < first.t) {
      // Pre-observation: fire ellipse clipped by the first observed perimeter, sized so
      // burnt area tracks the cumulative wind run. It can never out-run the observation.
      const f = totalRun > 0 ? Math.min(1, windRun(wind, ignitionT, t) / totalRun) : 0;
      solveForArea(anchorArea * f ** GROWTH_EXPONENT, r);
    } else {
      let i = 0;
      while (i < chain.length - 1 && chain[i + 1].t <= t) i++;
      if (i >= chain.length - 1) {
        r.set(profiles[chain.length - 1]); // past the last observation: hold it
      } else {
        const a = chain[i];
        const b = chain[i + 1];
        const f = (t - a.t) / Math.max(1, b.t - a.t);
        const pa = profiles[i];
        const pb = profiles[i + 1];
        for (let k = 0; k < rays; k++) r[k] = pa[k] + (pb[k] - pa[k]) * f;
      }
    }

    for (let k = 0; k < rays; k++) {
      r[k] = Math.max(r[k], prev[k]); // a fire front never retreats
      prev[k] = r[k];
    }

    const main = ringFromRadii(r, frame);
    const rings = main.length
      ? [main, ...carriedSpots.map((s) => s.map((pt) => frame.from(pt)))]
      : [];
    const ringsM = main.length ? [main.map((ll) => frame.to(ll)), ...carriedSpots] : [];
    out.push({ t, rings, ringsM, provenance: "interpolated" });
  }
  return out;
}

function eccentricity(lb: number): number {
  return Math.min(0.94, Math.sqrt(Math.max(0, lb * lb - 1)) / lb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Plume frame construction
// ─────────────────────────────────────────────────────────────────────────────

/** Briggs rural dispersion coefficients, Pasquill class D. */
function sigmaY(x: number): number {
  return (0.08 * x) / Math.sqrt(1 + 0.0001 * x);
}
function sigmaZ(x: number): number {
  return (0.06 * x) / Math.sqrt(1 + 0.0015 * x);
}

function buildPlumeFrames(
  scenario: ScenarioMeta,
  frame: Frame2D,
  releaseT: Tick,
  wind: WindSample[],
): BuiltFrame[] {
  const out: BuiltFrame[] = [];
  /** Centreline resolution in metres; the time step follows from the wind speed. */
  const SEG_M = 250;
  for (let t = 0; t <= scenario.duration; t += scenario.frameStep) {
    if (t < releaseT) {
      out.push({ t, rings: [], ringsM: [], provenance: "interpolated" });
      continue;
    }
    // Walk backwards in release time: parcels released earlier sit further downwind.
    const centre: { p: Pt; x: number }[] = [{ p: [0, 0], x: 0 }];
    let px = 0;
    let py = 0;
    let arc = 0;
    let s = t;
    for (let guard = 0; guard < 400 && s > releaseT; guard++) {
      const w = windAt(wind, s);
      const u = Math.max(0.5, w.speed);
      const dt = Math.min(Math.max(20, SEG_M / u), 600, s - releaseT);
      const h = headingRad(w.direction);
      const d = u * dt;
      px += Math.cos(h) * d;
      py += Math.sin(h) * d;
      arc += d;
      s -= dt;
      // Cut the tail where dilution drops the contour below threshold.
      if (Math.PI * u * sigmaY(arc) * sigmaZ(arc) > PLUME_K) break;
      centre.push({ p: [px, py], x: arc });
    }
    if (centre.length < 3) {
      const w = windAt(wind, t);
      const r = Math.max(150, sigmaY(Math.max(1, w.speed) * (t - releaseT)));
      const ring: LngLat[] = [];
      for (let k = 0; k < 48; k++) {
        const th = (k / 48) * Math.PI * 2;
        ring.push(frame.from([Math.cos(th) * r, Math.sin(th) * r]));
      }
      out.push({
        t,
        rings: [ring],
        ringsM: [ring.map((ll) => frame.to(ll))],
        provenance: "interpolated",
      });
      continue;
    }

    const uMean = Math.max(1, windAt(wind, t).speed);
    const halfWidth = (x: number): number => {
      if (x < 50) return 120;
      const sy = sigmaY(x);
      const sz = sigmaZ(x);
      const cAxis = PLUME_K / (Math.PI * uMean * sy * sz);
      if (cAxis <= 1) return 120;
      return Math.max(120, sy * Math.sqrt(2 * Math.log(cAxis)));
    };

    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < centre.length; i++) {
      const a = centre[Math.max(0, i - 1)].p;
      const b = centre[Math.min(centre.length - 1, i + 1)].p;
      const tx = b[0] - a[0];
      const ty = b[1] - a[1];
      const len = Math.hypot(tx, ty) || 1;
      const nx = -ty / len;
      const ny = tx / len;
      const hw = halfWidth(centre[i].x);
      left.push([centre[i].p[0] + nx * hw, centre[i].p[1] + ny * hw]);
      right.push([centre[i].p[0] - nx * hw, centre[i].p[1] - ny * hw]);
    }
    const ringM: Pt[] = [...left, ...right.reverse()];
    out.push({
      t,
      rings: [ringM.map((p) => frame.from(p))],
      ringsM: [ringM],
      provenance: "interpolated",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge closures
// ─────────────────────────────────────────────────────────────────────────────

async function loadNetwork(scenarioId: string): Promise<RoadNetwork | null> {
  const file = path.join(ROOT, "public", "data", scenarioId, "network.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as RoadNetwork;
    return Array.isArray(raw.edges) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Cumulative closures. `closedEdgeIds` on a frame is the FULL set impassable at that
 * instant, not the delta — a consumer that reads it directly and one that unions the
 * prefix both land on the same set, whereas emitting deltas breaks the first reading.
 */
function computeClosures(
  frames: BuiltFrame[],
  network: RoadNetwork | null,
  frame: Frame2D,
): string[][] {
  if (!network) return frames.map(() => []);
  const edges = network.edges
    .filter((e) => Array.isArray(e.geometry) && e.geometry.length >= 2)
    .map((e) => {
      const pts = e.geometry.map((c) => frame.to(c));
      return { id: e.id, pts, bbox: bboxOf(pts) };
    });
  const open = new Set(edges.map((_, i) => i));
  const closed: string[] = [];
  const perFrame: string[][] = [];

  for (const f of frames) {
    if (f.ringsM.length > 0 && open.size > 0) {
      const ringInfo = f.ringsM.map((r) => ({ ring: r, bbox: bboxOf(r) }));
      const hit: number[] = [];
      for (const i of open) {
        const e = edges[i];
        let struck = false;
        for (const { ring, bbox } of ringInfo) {
          if (!bboxOverlap(e.bbox, bbox)) continue;
          for (const p of e.pts) {
            if (pointInRing(p, ring)) {
              struck = true;
              break;
            }
          }
          if (struck) break;
          // Vertices all outside: the edge can still cut clean across a narrow lobe.
          for (let s = 0; s < e.pts.length - 1 && !struck; s++) {
            const a = e.pts[s];
            const b = e.pts[s + 1];
            const sb: [number, number, number, number] = [
              Math.min(a[0], b[0]),
              Math.min(a[1], b[1]),
              Math.max(a[0], b[0]),
              Math.max(a[1], b[1]),
            ];
            if (!bboxOverlap(sb, bbox)) continue;
            for (let j = 0, n = ring.length; j < n; j++) {
              if (segmentsCross(a, b, ring[j], ring[(j + 1) % n])) {
                struck = true;
                break;
              }
            }
          }
          if (struck) break;
        }
        if (struck) hit.push(i);
      }
      for (const i of hit) {
        open.delete(i);
        closed.push(edges[i].id);
      }
    }
    perFrame.push([...closed]);
  }
  return perFrame;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const scenarioId = argv.find((a) => !a.startsWith("--")) ?? "camp-fire-2018";
  const rays = Number(argv.find((a) => a.startsWith("--rays="))?.split("=")[1] ?? DEFAULT_RAYS);
  const sourceOverride = argv.find((a) => a.startsWith("--source="))?.split("=")[1];

  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(
      `[hazard] unknown scenario "${scenarioId}". Known: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
    return;
  }

  const kind: HazardKind = scenario.hazardKind;
  const t0Ms = scenarioT0Ms(scenario);
  log(
    "scenario",
    `${scenario.id} — ${kind}, ${scenario.duration}s @ ${scenario.frameStep}s, T+0 = ${new Date(t0Ms).toISOString()}`,
  );

  const ign = IGNITION[scenario.id];
  let origin: LngLat;
  let ignitionT: Tick;
  if (sourceOverride) {
    const [lng, lat] = sourceOverride.split(",").map(Number);
    origin = [lng, lat];
    ignitionT = ign ? Math.round((Date.parse(ign.atUtc) - t0Ms) / 1000) : 0;
    log("origin", `source overridden via --source → ${origin.join(",")}`);
  } else if (ign) {
    origin = ign.point;
    ignitionT = Math.round((Date.parse(ign.atUtc) - t0Ms) / 1000);
    log("origin", `${ign.note} → ${origin.join(",")}, T${ignitionT >= 0 ? "+" : ""}${ignitionT}s`);
    if (ign.approximate) {
      loud(
        `${scenario.id} source point ${origin.join(",")} is APPROXIMATE — see the note in IGNITION for where it came from ("${ign.note}") and why it is not exact. Override with --source=lng,lat.`,
      );
    }
  } else {
    origin = scenario.center;
    ignitionT = 0;
    loud(
      `No ignition/release point known for ${scenario.id} — using the scenario centre ${origin.join(",")} at T+0.`,
    );
  }

  if (ignitionT >= scenario.duration) {
    loud(
      `${scenario.id} ignition/release lands at T+${ignitionT}s but the scenario window ends at T+${scenario.duration}s — ` +
        `EVERY FRAME WILL BE EMPTY. T+0 is ${scenario.startHourLocal ?? DEFAULT_T0_LOCAL_HOUR}:00 local (startHourLocal), so this scenario's duration/eventDate in src/lib/constants.ts needs to cover the ignition.`,
    );
  }

  const frame = new Frame2D(origin);
  const windSeries = await loadWind(scenario, t0Ms);
  const wind = windSeries.samples;

  let built: BuiltFrame[];
  let perimeterSource: string;
  let observedAnchors: Anchor[] = [];

  if (kind === "plume") {
    perimeterSource = "Gaussian plume model (Briggs rural D), advected by hourly wind";
    log("plume", `advecting from ${origin.join(",")} — all frames modelled, none observed`);
    notes.push("Plume footprints are modelled; no observed plume archive exists for this event.");
    built = buildPlumeFrames(scenario, frame, ignitionT, wind);
  } else {
    const res = await fetchAnchors(scenario, frame, t0Ms);
    observedAnchors = res.anchors;
    perimeterSource = res.source;
    for (const a of observedAnchors) {
      log(
        "anchor",
        `${a.atUtc}  T${a.t >= 0 ? "+" : ""}${a.t}s  ${a.areaKm2.toFixed(1)} km2  ${a.rings.length} ring(s)` +
          (a.t >= 0 && a.t <= scenario.duration ? "   <- inside window" : ""),
      );
    }
    built = buildWildfireFrames(scenario, frame, observedAnchors, ignitionT, wind, rays);
  }

  const hotspots = kind === "wildfire" ? await fetchHotspots(scenario, t0Ms) : [];

  const network = await loadNetwork(scenario.id);
  if (!network) {
    loud(
      `network.json missing for ${scenario.id} — closedEdgeIds will be EMPTY on every frame. ` +
        "Run `npm run data:network` then re-run `npm run data:hazard`.",
    );
  } else {
    log("network", `network.json → ${network.edges.length} edges, testing intersections`);
  }
  const closures = computeClosures(built, network, frame);

  const half = scenario.frameStep / 2;
  const frames: HazardFrame[] = built.map((b, i) => {
    const f: HazardFrame = {
      t: b.t,
      rings: b.rings,
      closedEdgeIds: closures[i],
      provenance: b.provenance,
    };
    const hs = hotspots.filter((h) => h.t >= b.t - half && h.t < b.t + half).map((h) => h.lngLat);
    if (hs.length > 0) f.hotspots = hs;
    return f;
  });

  const windOut: WindSample[] = wind
    .filter((w) => w.t >= -3600 && w.t <= scenario.duration + 3600)
    .map((w) => ({
      t: Math.round(w.t),
      speed: Math.round(w.speed * 100) / 100,
      direction: Math.round(w.direction * 10) / 10,
      ...(typeof w.gust === "number" ? { gust: Math.round(w.gust * 100) / 100 } : {}),
    }));

  const track: HazardTrack = {
    scenarioId: scenario.id,
    kind,
    frames,
    wind: windOut.length > 0 ? windOut : wind,
    source: [
      perimeterSource,
      `wind: ${windSeries.source}`,
      hotspots.length ? "hotspots: NASA FIRMS" : "hotspots: none",
    ]
      .concat(notes.length ? [`caveats: ${notes.length} logged`] : [])
      .join(" | "),
    generatedAt: new Date().toISOString(),
  };

  const outDir = path.join(ROOT, "public", "data", scenario.id);
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "hazard.json");
  const json = JSON.stringify(track);
  await writeFile(outFile, json, "utf8");

  const observedCount = frames.filter((f) => f.provenance === "observed").length;
  const interpCount = frames.length - observedCount;
  const empty = frames.filter((f) => f.rings.length === 0).length;
  const lastClosed = closures[closures.length - 1]?.length ?? 0;
  const withHotspots = frames.filter((f) => f.hotspots?.length).length;

  log(
    "frames",
    `${frames.length} total — ${observedCount} observed, ${interpCount} interpolated (${empty} empty, pre-ignition or pre-release)`,
  );
  log(
    "provenance",
    observedCount === 0
      ? "NO frame is a direct observation for this scenario"
      : `observed frames at t = ${frames
          .filter((f) => f.provenance === "observed")
          .map((f) => f.t)
          .join(", ")}`,
  );
  log(
    "closures",
    `${lastClosed} edges impassable by T+${scenario.duration}s (cumulative sets per frame)`,
  );
  log("hotspots", `${hotspots.length} FIRMS detections attached across ${withHotspots} frames`);
  log("write", `${outFile} — ${Buffer.byteLength(json).toLocaleString("en-US")} bytes`);
  if (notes.length > 0) {
    console.log("\n[hazard] caveats to carry into the deck:");
    for (const n of notes) console.log(`  - ${n}`);
  }
}

main().catch((err) => {
  console.error("[hazard] FAILED:", err);
  process.exit(1);
});

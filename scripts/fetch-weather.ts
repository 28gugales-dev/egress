/**
 * Archived hourly wind for a scenario, resampled onto the scenario clock.
 *
 *   npx tsx scripts/fetch-weather.ts [scenarioId]
 *
 * Upstreams (both keyless):
 *   - archive-api.open-meteo.com/v1/archive  — ERA5 reanalysis, the event date
 *   - api.weather.gov/alerts/active          — TODAY's alerts, shipped as a
 *     demonstration of the live-alert path. Never historical, never cached.
 *
 * TIMEZONE — the reason this script does its own clock arithmetic:
 * Open-Meteo's `timezone=auto` stamps hourly labels with the offset in force at
 * REQUEST time, not on the requested date. For 2018-11-08 (PST, UTC-8) it
 * returned utc_offset_seconds = -25200 (PDT, UTC-7), so its "06:00" is really
 * 05:00 PST. Verified by cross-checking the same hour against `timezone=GMT`:
 * the value it labels 06:00 local lands at 13:00Z, and 13:00Z is 05:00 PST.
 * So we pull the series in GMT and convert the scenario's local start hour to
 * UTC ourselves via Intl, which honours historical DST rules correctly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS } from "../src/lib/constants";
import type { ScenarioMeta, WindSample } from "../src/types/egress";

const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";
const NWS_ALERTS_API = "https://api.weather.gov/alerts/active";

/** api.weather.gov rejects requests without an identifying User-Agent. */
const USER_AGENT = "egress-evac-planner/0.1 (evacuation clearance-time research tool)";

const HOURLY_VARS = [
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "temperature_2m",
  "relative_humidity_2m",
] as const;

/**
 * Local wall-clock hour that T+0 represents lives on ScenarioMeta, because
 * fetch-hazard and the UI scrubber have to agree with it. A per-script copy
 * would drift, and a drifted start hour rotates the wind against the fire
 * without failing anything.
 *
 *   camp-fire-2018       06:00 PST — fire ignited 06:33 near Pulga
 *   conyers-plume-2024   05:00 EDT — BioLab roof fire reported just before dawn
 *   marshall-fire-2021   10:00 MST — approximate; first reports came ~11:00
 *   palisades-fire-2025  10:00 PST — fire reported 10:30
 */
const DEFAULT_START_HOUR = 6;

const CACHE_DIR = join(repoRoot(), "scripts", ".cache");

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/** Walk up from cwd until package.json turns up, so the script works from
 *  anywhere rather than only from an npm-run cwd. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Fetch with backoff + on-disk cache
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(
  url: string,
  label: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const delays = [500, 1500, 4000, 9000];
  let lastErr: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });

      // 4xx other than rate-limiting will not fix itself; fail immediately.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        throw new Error(
          `${label}: HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 300)}`,
        );
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText}`);

      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) break;
      const wait = delays[attempt];
      console.log(
        `  retry ${attempt + 1}/${delays.length} for ${label} in ${wait}ms — ${(err as Error).message}`,
      );
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Historical reanalysis is immutable, so caching it makes re-runs free. */
async function fetchCachedJson<T>(url: string, cacheKey: string, label: string): Promise<T> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `${cacheKey}.json`);
  if (existsSync(path)) {
    console.log(`  cache hit  ${cacheKey}`);
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }
  const json = await fetchJson<T>(url, label);
  writeFileSync(path, JSON.stringify(json));
  console.log(`  cache miss ${cacheKey} — stored`);
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock
// ─────────────────────────────────────────────────────────────────────────────

/** Offset of `timeZone` from UTC, in seconds, at the given instant. Uses Intl
 *  so historical DST transitions are applied for the date in question. */
function tzOffsetSeconds(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return (asIfUtc - utcMs) / 1000;
}

/** Epoch seconds for a local wall-clock time in `timeZone`. Two passes so a
 *  start hour that straddles a DST change still resolves. */
function localWallToEpoch(dateIso: string, hour: number, timeZone: string): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  for (let i = 0; i < 2; i++) {
    guess = Date.UTC(y, m - 1, d, hour, 0, 0) - tzOffsetSeconds(guess, timeZone) * 1000;
  }
  return Math.round(guess / 1000);
}

function shiftDate(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interpolation
// ─────────────────────────────────────────────────────────────────────────────

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

/** Shortest-arc interpolation. Linear lerp between 350 and 10 would sweep the
 *  long way through south and invent a wind that never blew. */
function lerpAngle(a: number, b: number, f: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  return norm360(a + delta * f);
}

const round = (v: number, places: number) => {
  const p = 10 ** places;
  return Math.round(v * p) / p;
};

interface HourlyRow {
  epoch: number;
  speed: number;
  direction: number;
  gust: number;
  temperature: number;
  humidity: number;
}

function resample(
  rows: HourlyRow[],
  startEpoch: number,
  duration: number,
  frameStep: number,
): WindSample[] {
  const samples: WindSample[] = [];
  let cursor = 0;

  for (let t = 0; t <= duration; t += frameStep) {
    const target = startEpoch + t;
    while (cursor < rows.length - 2 && rows[cursor + 1].epoch <= target) cursor++;

    const a = rows[Math.min(cursor, rows.length - 1)];
    const b = rows[Math.min(cursor + 1, rows.length - 1)];
    const span = b.epoch - a.epoch;
    // Clamp rather than extrapolate if the padded window still fell short.
    const f = span > 0 ? Math.max(0, Math.min(1, (target - a.epoch) / span)) : 0;

    samples.push({
      t,
      speed: round(lerp(a.speed, b.speed, f), 2),
      direction: round(lerpAngle(a.direction, b.direction, f), 1),
      gust: round(lerp(a.gust, b.gust, f), 2),
    });
  }
  return samples;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

const compass = (deg: number) => COMPASS[Math.round(norm360(deg) / 22.5) % 16];

/** Speed-weighted circular mean. A plain mean of a series that swings across
 *  north returns a direction the wind never held. */
function dominantDirection(series: { speed: number; direction: number }[]): number {
  let x = 0;
  let y = 0;
  for (const s of series) {
    const rad = (s.direction * Math.PI) / 180;
    x += s.speed * Math.sin(rad);
    y += s.speed * Math.cos(rad);
  }
  return norm360((Math.atan2(x, y) * 180) / Math.PI);
}

function peakGust(samples: WindSample[]): WindSample {
  return samples.reduce((best, s) => ((s.gust ?? 0) > (best.gust ?? 0) ? s : best), samples[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fallback — only on upstream failure, and loudly announced
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Idealised offshore/downslope profile: a steady gradient-driven flow that
 * decays through the morning as the boundary layer mixes out, with gusts at a
 * fixed 2.2x factor and a slow clockwise veer. Bears no relation to what the
 * atmosphere actually did — it exists so the rest of the pipeline can run.
 */
function syntheticSamples(scenario: ScenarioMeta, baseDirection: number): WindSample[] {
  const out: WindSample[] = [];
  for (let t = 0; t <= scenario.duration; t += scenario.frameStep) {
    const hours = t / 3600;
    const speed = 9.0 * Math.exp(-hours / 6) + 1.5;
    out.push({
      t,
      speed: round(speed, 2),
      direction: round(norm360(baseDirection + hours * 3), 1),
      gust: round(speed * 2.2, 2),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream shapes
// ─────────────────────────────────────────────────────────────────────────────

interface ArchiveResponse {
  latitude: number;
  longitude: number;
  elevation: number;
  timezone: string;
  timezone_abbreviation: string;
  utc_offset_seconds: number;
  hourly_units: Record<string, string>;
  hourly: {
    time: string[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
    wind_gusts_10m: (number | null)[];
    temperature_2m: (number | null)[];
    relative_humidity_2m: (number | null)[];
  };
}

interface AlertsResponse {
  features?: unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(
      `unknown scenario "${scenarioId}" — known: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }

  const [lng, lat] = scenario.center;
  const startHour = scenario.startHourLocal ?? DEFAULT_START_HOUR;
  const startDate = shiftDate(scenario.eventDate, -1);
  const endDate = shiftDate(scenario.eventDate, 1);

  console.log(
    `[1/5] ${scenario.id} — ${scenario.place} @ ${lat.toFixed(4)},${lng.toFixed(4)} | ` +
      `T+0 = ${scenario.eventDate} ${String(startHour).padStart(2, "0")}:00 local | ` +
      `${scenario.duration}s @ ${scenario.frameStep}s`,
  );

  const hourlyParam = HOURLY_VARS.join(",");
  const base =
    `${ARCHIVE_API}?latitude=${lat}&longitude=${lng}` +
    `&start_date=${startDate}&end_date=${endDate}&hourly=${hourlyParam}&wind_speed_unit=ms`;
  const autoUrl = `${base}&timezone=auto`;
  const gmtUrl = `${base}&timezone=GMT`;

  let samples: WindSample[];
  const rows: HourlyRow[] = [];
  let archive: ArchiveResponse | null = null;
  let auto: ArchiveResponse | null = null;
  let timeZone = "UTC";
  let startEpoch = 0;
  let synthesized: string | null = null;

  console.log(`[2/5] open-meteo archive ${startDate}..${endDate}`);
  try {
    // The auto call is only for the IANA zone name — its hour labels are not
    // trustworthy for historical dates (see the header note).
    auto = await fetchCachedJson<ArchiveResponse>(
      autoUrl,
      `openmeteo-${scenario.id}-${startDate}-${endDate}-auto`,
      "open-meteo/auto",
    );
    timeZone = auto.timezone ?? "UTC";

    archive = await fetchCachedJson<ArchiveResponse>(
      gmtUrl,
      `openmeteo-${scenario.id}-${startDate}-${endDate}-gmt`,
      "open-meteo/gmt",
    );

    const h = archive.hourly;
    for (let i = 0; i < h.time.length; i++) {
      const speed = h.wind_speed_10m[i];
      const direction = h.wind_direction_10m[i];
      if (speed == null || direction == null) continue;
      rows.push({
        epoch: Math.round(Date.parse(`${h.time[i]}:00Z`) / 1000),
        speed,
        direction,
        gust: h.wind_gusts_10m[i] ?? speed * 1.6,
        temperature: h.temperature_2m[i] ?? Number.NaN,
        humidity: h.relative_humidity_2m[i] ?? Number.NaN,
      });
    }
    rows.sort((a, b) => a.epoch - b.epoch);
    if (rows.length < 2) throw new Error(`only ${rows.length} usable hourly rows returned`);

    startEpoch = localWallToEpoch(scenario.eventDate, startHour, timeZone);
    const trueOffset = tzOffsetSeconds(startEpoch * 1000, timeZone);
    console.log(
      `[3/5] ${rows.length} hourly rows | grid ${archive.latitude.toFixed(4)},${archive.longitude.toFixed(4)} ` +
        `@ ${archive.elevation}m | tz ${timeZone} true offset ${trueOffset / 3600}h ` +
        `(api reported ${auto.utc_offset_seconds / 3600}h)`,
    );
    console.log(`      T+0 = ${new Date(startEpoch * 1000).toISOString()}`);

    samples = resample(rows, startEpoch, scenario.duration, scenario.frameStep);
  } catch (err) {
    const baseDir = scenario.hazardKind === "wildfire" ? 45 : 270;
    synthesized =
      `open-meteo archive unreachable (${(err as Error).message}); wind series is an idealised ` +
      `decaying downslope profile from ${baseDir}deg, NOT observed data`;
    console.log("[3/5] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.log(`[3/5] !! SYNTHETIC WIND: ${synthesized}`);
    console.log("[3/5] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    startEpoch = localWallToEpoch(scenario.eventDate, startHour, "UTC");
    samples = syntheticSamples(scenario, baseDir);
  }

  // Live alerts: today's, for the same point. Deliberately uncached — the whole
  // point is to exercise the path that would run against a live incident.
  console.log(`[4/5] nws active alerts @ ${lat},${lng}`);
  const alertsUrl = `${NWS_ALERTS_API}?point=${lat},${lng}`;
  let liveAlerts: unknown[] = [];
  let alertsError: string | null = null;
  try {
    const res = await fetchJson<AlertsResponse>(alertsUrl, "api.weather.gov", {
      Accept: "application/geo+json",
    });
    liveAlerts = Array.isArray(res.features) ? res.features : [];
    console.log(
      `      ${liveAlerts.length} active alert(s)${liveAlerts.length === 0 ? " — none in force at this point right now" : ""}`,
    );
  } catch (err) {
    alertsError = (err as Error).message;
    console.log("      !! NWS ALERTS UNAVAILABLE — liveAlerts left EMPTY, nothing synthesized");
    console.log(`      !! ${alertsError}`);
  }

  const peak = peakGust(samples);
  const dominant = dominantDirection(samples);

  const windowRows = rows.filter(
    (r) => r.epoch >= startEpoch && r.epoch <= startEpoch + scenario.duration,
  );

  // The scenario window is a slice of the event, not the whole of it. Report
  // the event-day peak alongside so the window figure is not read as "the"
  // peak — for camp-fire-2018 the downslope jet peaks before T+0.
  const dayRows = rows.filter(
    (r) => new Date(r.epoch * 1000).toISOString().slice(0, 10) === scenario.eventDate,
  );
  const dayPeak = dayRows.length ? dayRows.reduce((a, b) => (b.gust > a.gust ? b : a)) : null;
  const dayDominant = dayRows.length ? dominantDirection(dayRows) : null;

  const payload = {
    scenarioId: scenario.id,
    samples,
    raw: {
      archive: archive
        ? {
            url: gmtUrl,
            requestedCenter: { lat, lng },
            gridPoint: {
              lat: archive.latitude,
              lng: archive.longitude,
              elevationM: archive.elevation,
            },
            timeZone,
            reportedUtcOffsetSeconds: auto?.utc_offset_seconds ?? null,
            trueUtcOffsetSeconds: tzOffsetSeconds(startEpoch * 1000, timeZone),
            units: archive.hourly_units,
            hourly: archive.hourly,
          }
        : null,
      timezoneNote:
        "Open-Meteo timezone=auto applies the request-time UTC offset to historical dates. " +
        "Hourly data here is pulled in GMT and anchored to local wall time via Intl.",
      scenarioStartHourLocal: startHour,
      scenarioStartEpoch: startEpoch,
      scenarioStartUtc: new Date(startEpoch * 1000).toISOString(),
      windowHourly: windowRows,
      peakGust: peak.gust ?? null,
      peakGustAtTick: peak.t,
      dominantDirectionDeg: round(dominant, 1),
      dominantDirectionCompass: compass(dominant),
      dominantDirectionMethod: "speed-weighted circular mean over scenario window",
      eventDay: dayPeak
        ? {
            peakGust: dayPeak.gust,
            peakGustUtc: new Date(dayPeak.epoch * 1000).toISOString(),
            peakSustained: dayRows.reduce((a, b) => (b.speed > a.speed ? b : a)).speed,
            dominantDirectionDeg: round(dayDominant ?? 0, 1),
            dominantDirectionCompass: compass(dayDominant ?? 0),
          }
        : null,
      resolutionNote:
        "ERA5 reanalysis on a ~0.1deg grid. The nearest cell is offset from the scenario " +
        "centre and cannot resolve terrain-channelled downslope jets, so gusts in steep " +
        "canyon terrain are damped and their timing is smoothed. Treat as synoptic forcing, " +
        "not as a station observation.",
      synthesized,
      alerts: {
        url: alertsUrl,
        fetchedAt: new Date().toISOString(),
        count: liveAlerts.length,
        ok: alertsError === null,
        error: alertsError,
      },
    },
    liveAlerts,
    source: synthesized
      ? "SYNTHETIC (open-meteo unreachable) + NWS api.weather.gov active alerts"
      : "Open-Meteo ERA5 archive (archive-api.open-meteo.com) + NWS api.weather.gov active alerts",
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(repoRoot(), "public", "data", scenario.id);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "weather.json");
  const json = JSON.stringify(payload, null, 2);
  writeFileSync(outPath, json);

  console.log(
    `[5/5] wrote ${outPath} — ${Buffer.byteLength(json)} bytes, ${samples.length} samples`,
  );
  console.log(
    `      peak gust ${peak.gust?.toFixed(2)} m/s at T+${peak.t}s | ` +
      `dominant ${round(dominant, 1)}deg (${compass(dominant)}) | ` +
      `speed range ${Math.min(...samples.map((s) => s.speed)).toFixed(2)}–${Math.max(...samples.map((s) => s.speed)).toFixed(2)} m/s`,
  );
  if (dayPeak && dayDominant !== null) {
    console.log(
      `      event day  peak gust ${dayPeak.gust.toFixed(2)} m/s at ` +
        `${new Date(dayPeak.epoch * 1000).toISOString().slice(0, 16)}Z | ` +
        `dominant ${round(dayDominant, 1)}deg (${compass(dayDominant)})`,
    );
  }
  if (windowRows.length) {
    console.log("      hourly within scenario window (UTC | m/s | deg | gust m/s):");
    for (const r of windowRows) {
      console.log(
        `        ${new Date(r.epoch * 1000).toISOString().slice(0, 16)}Z  ` +
          `${r.speed.toFixed(2).padStart(5)}  ${String(Math.round(r.direction)).padStart(3)}  ${r.gust.toFixed(2).padStart(5)}  ${compass(r.direction)}`,
      );
    }
  }
  if (synthesized) console.log(`      !! OUTPUT CONTAINS SYNTHETIC WIND: ${synthesized}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

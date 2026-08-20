/**
 * Build the census-block detail layer.
 *
 *   pnpm tsx scripts/fetch-blocks.ts [scenarioId]
 *
 * Writes public/data/<scenario>/detail/blocks.json.
 *
 * The population layer stops at the block GROUP (summary level 150) because
 * that is as fine as ACS publishes. The decennial census goes one level finer —
 * the block, summary level 100 — and at block scale the counts are not
 * estimates with a margin of error but an actual enumeration. TIGERweb serves
 * block geometry with `POP100` and `HU100` attached, keyless, so geometry and
 * counts arrive in the same call and nothing has to be joined.
 *
 * ── Vintage is the whole game here ──────────────────────────────────────────
 *
 * The census year is chosen per scenario as the last enumeration BEFORE the
 * event. For the Camp Fire that is 2010, not 2020: the 2020 census counted a
 * Paradise that had already burned — the town went from roughly 26,000 people
 * to under 5,000 — so 2020 blocks describe the aftermath, not the town that had
 * to get out. This is the same reasoning `ACS_VINTAGE` in fetch-population.ts
 * uses, applied to the decennial series. The chosen year is written into the
 * payload and the UI states it.
 *
 * Endpoint confirmed live before this was written; layer ids are resolved by
 * name at runtime because they move between vintages.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getScenario } from "../src/lib/constants";
import type { BlocksPayload, DetailBlock } from "../src/types/detail-layers";
import type {
  EvacZone,
  HazardTrack,
  LngLat,
  ScenarioMeta,
  Tick,
  ZoneLayer,
} from "../src/types/egress";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";

/** Last decennial enumeration that precedes the event. See the header. */
const CENSUS_VINTAGE: Record<string, number> = {
  "camp-fire-2018": 2010,
  "conyers-plume-2024": 2020,
  "marshall-fire-2021": 2020,
};
const DEFAULT_VINTAGE = 2020;

/** Used only when the service's own layer listing is unreachable. Both were
 *  read off the live service, not guessed. */
const LAYER_FALLBACK: Record<number, number> = { 2010: 18, 2020: 10 };

/** ~1.1 m. Blocks are administrative boundaries, not measurements, and their
 *  vertices are published at far more precision than they mean. */
const DP = 1e5;

/** A block ring past this many vertices is a river or a coastline following a
 *  hydrography line; simplify hard rather than ship it. */
const SIMPLIFY_TOLERANCE = 0.00002;

let warnings = 0;

function log(tag: string, msg: string): void {
  console.log(`[blocks] ${tag.padEnd(10)} ${msg}`);
}

function warn(msg: string): void {
  warnings += 1;
  console.warn(`[blocks] WARNING    ${msg}`);
}

type Box = [number, number, number, number];

function boxOf(ring: LngLat[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function unionBox(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function inBox(b: Box, x: number, y: number): boolean {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

/**
 * Multiple of the median zone box area past which a zone's box is treated as a
 * geometry artifact rather than a neighbourhood, for the purpose of sizing the
 * fetch extent ONLY.
 *
 * Measured, not chosen by feel. Largest legitimate zone in either built
 * scenario is Concow (camp-fire-2018 BUT-CON-501) at 19.9x the median — a real
 * rural zone that must keep setting the extent. Palisades PAC-E020 is 144.6x,
 * because its two block groups are 060377019023 (Santa Monica, where its 1,555
 * residents actually live) and 060379902000 — a 9900-series census WATER tract
 * whose polygon runs 29 km down the coast and out to sea. Left unbounded that
 * one zone pushed the extent to -118.6998,33.7467,-118.3954,34.1478 and the
 * buildings payload to 165,045 structures / 37.1 MB, 88% of it in no
 * evacuation zone at all. 40x sits in the empty gap between 19.9 and 144.6, so
 * the rule cannot fire on any zone in either built scenario except that one.
 */
const EXTENT_ZONE_AREA_MULTIPLE = 40;

/**
 * Fetch extent: the scenario bbox unioned with the zones, with any outlier
 * zone's contribution CLIPPED rather than dropped.
 *
 * An outlier still gets to extend the extent, but by at most one typical zone
 * width (the median zone box's diagonal) beyond what the rest of the system
 * already covers. That bound is intrinsic to the zone layer, not a tuned
 * constant, and it is what keeps PAC-E020's real Santa Monica blocks
 * (34.0041-34.0161, 1,079 people) inside coverage while leaving its ocean
 * hull outside. The zone itself is untouched everywhere else — population,
 * release wave and per-structure assignment all still use it.
 */
function extentBox(bbox: Box, zones: { id: string; box: Box }[], onClip: (m: string) => void): Box {
  const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
  let box: Box = [...bbox] as Box;
  if (zones.length < 3) {
    for (const z of zones) box = unionBox(box, z.box);
    return box;
  }

  const sorted = zones.map((z) => area(z.box)).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const outlier = (z: { box: Box }) => median > 0 && area(z.box) / median > EXTENT_ZONE_AREA_MULTIPLE;

  for (const z of zones) if (!outlier(z)) box = unionBox(box, z.box);

  // One typical zone's diagonal, from this scenario's own zone system.
  const pad = Math.SQRT2 * Math.sqrt(median);
  const limit: Box = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];

  for (const z of zones) {
    if (!outlier(z)) continue;
    const clipped: Box = [
      Math.max(z.box[0], limit[0]),
      Math.max(z.box[1], limit[1]),
      Math.min(z.box[2], limit[2]),
      Math.min(z.box[3], limit[3]),
    ];
    onClip(
      `zone ${z.id} box is ${(area(z.box) / median).toFixed(1)}x the median zone box — a geometry ` +
        `artifact, almost always a 9900-series census water tract. Its contribution to the fetch ` +
        `extent is CLIPPED from ${z.box.map((v) => v.toFixed(4)).join(",")} to ` +
        `${clipped.map((v) => v.toFixed(4)).join(",")} (one median zone diagonal, ${pad.toFixed(4)} deg). ` +
        `The zone is otherwise UNCHANGED: population, waves and assignments all still use it.`,
    );
    if (clipped[0] < clipped[2] && clipped[1] < clipped[3]) box = unionBox(box, clipped);
  }
  return box;
}

function inRing(ring: LngLat[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function inRings(rings: LngLat[][], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) if (inRing(r, x, y)) inside = !inside;
  return inside;
}

function rdp(pts: LngLat[], eps: number): LngLat[] {
  if (pts.length < 4) return pts;
  let maxD = 0;
  let idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const den = dx * dx + dy * dy;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const d =
      den === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / Math.sqrt(den);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

function flatten(ring: LngLat[]): number[] {
  const out: number[] = [];
  const n =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  for (let i = 0; i < n; i++) {
    out.push(Math.round(ring[i][0] * DP) / DP, Math.round(ring[i][1] * DP) / DP);
  }
  return out;
}

/** Area-weighted-free centroid: blocks are convex enough that the vertex mean
 *  lands inside, and this only has to pick the hazard sample point. */
function centroidOf(ring: LngLat[]): LngLat {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length];
}

/** See the same function in fetch-buildings.ts for why it is bracket-then-scan
 *  rather than a plain binary search. */
function firstInside(
  frames: { t: Tick; rings: LngLat[][]; boxes: Box[] }[],
  x: number,
  y: number,
  stride: number,
): Tick | null {
  const hit = (i: number): boolean => {
    const f = frames[i];
    let any = false;
    for (const b of f.boxes) {
      if (inBox(b, x, y)) {
        any = true;
        break;
      }
    }
    return any && inRings(f.rings, x, y);
  };
  let lo = -1;
  for (let i = 0; i < frames.length; i += stride) {
    if (hit(i)) {
      lo = i;
      break;
    }
  }
  if (lo < 0) {
    const last = frames.length - 1;
    if (last % stride !== 0 && hit(last)) lo = last;
    else return null;
  }
  for (let i = Math.max(0, lo - stride + 1); i <= lo; i++) if (hit(i)) return frames[i].t;
  return frames[lo].t;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIGERweb
// ─────────────────────────────────────────────────────────────────────────────

interface EsriPolygonFeature {
  attributes: Record<string, string | number | null>;
  geometry?: { rings: [number, number][][] };
}

async function getJson<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function resolveLayer(service: string, vintage: number): Promise<number> {
  try {
    const j = await getJson<{ layers: { id: number; name: string }[] }>(
      `${TIGERWEB}/${service}/MapServer/layers?f=json`,
      "TIGERweb layer listing",
    );
    const hit = j.layers.find((l) => l.name.trim().toLowerCase() === "census blocks");
    if (hit) return hit.id;
    warn(
      `"Census Blocks" not in ${service}'s layer list — falling back to id ${LAYER_FALLBACK[vintage]}`,
    );
  } catch (e) {
    warn(
      `TIGERweb layer listing unreachable (${e instanceof Error ? e.message : String(e)}) — ` +
        `falling back to hardcoded layer id ${LAYER_FALLBACK[vintage]}`,
    );
  }
  return LAYER_FALLBACK[vintage] ?? LAYER_FALLBACK[DEFAULT_VINTAGE];
}

/**
 * Envelope query, splitting into quadrants whenever the server says it clipped
 * the result. Blocks are small and numerous; a silent truncation here would
 * quietly delete a neighbourhood, which is exactly the failure the "never
 * silently synthesize" rule is about.
 */
async function queryBlocks(
  service: string,
  layer: number,
  box: Box,
  depth = 0,
): Promise<EsriPolygonFeature[]> {
  const url =
    `${TIGERWEB}/${service}/MapServer/${layer}/query?f=json&where=1%3D1` +
    `&geometry=${box.join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=GEOID,POP100,HU100` +
    `&geometryPrecision=6&returnGeometry=true`;

  const page = await getJson<{
    features?: EsriPolygonFeature[];
    exceededTransferLimit?: boolean;
    error?: { message: string };
  }>(url, "TIGERweb blocks");

  if (page.error) throw new Error(`TIGERweb blocks: ${page.error.message}`);
  if (!page.exceededTransferLimit || depth >= 4) {
    if (page.exceededTransferLimit) {
      warn(
        `transfer limit still hit after ${depth} splits — block coverage in ${box.join(",")} is INCOMPLETE`,
      );
    }
    return page.features ?? [];
  }

  const mx = (box[0] + box[2]) / 2;
  const my = (box[1] + box[3]) / 2;
  const quads: Box[] = [
    [box[0], box[1], mx, my],
    [mx, box[1], box[2], my],
    [box[0], my, mx, box[3]],
    [mx, my, box[2], box[3]],
  ];
  const seen = new Map<string, EsriPolygonFeature>();
  for (const q of quads) {
    for (const f of await queryBlocks(service, layer, q, depth + 1)) {
      seen.set(String(f.attributes.GEOID ?? Math.random()), f);
    }
  }
  return [...seen.values()];
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario: ScenarioMeta = getScenario(scenarioId);
  const dataDir = join(ROOT, "public", "data", scenario.id);

  const vintage = CENSUS_VINTAGE[scenario.id] ?? DEFAULT_VINTAGE;
  const service = `tigerWMS_Census${vintage}`;
  log("vintage", `${vintage} decennial — the last enumeration before ${scenario.eventDate}`);

  const zoneLayer = JSON.parse(readFileSync(join(dataDir, "zones.json"), "utf8")) as ZoneLayer;
  const hazard = JSON.parse(readFileSync(join(dataDir, "hazard.json"), "utf8")) as HazardTrack;

  const zones = zoneLayer.zones.map((z: EvacZone) => ({
    id: z.id,
    rings: z.geometry,
    box: z.geometry.map(boxOf).reduce(unionBox),
  }));

  let box: Box = [...scenario.bbox] as Box;
  box = extentBox(scenario.bbox as Box, zones, warn);
  box = [box[0] - 0.002, box[1] - 0.002, box[2] + 0.002, box[3] + 0.002];

  const layer = await resolveLayer(service, vintage);
  log("query", `${service} layer ${layer} over ${box.map((v) => v.toFixed(4)).join(", ")}`);
  const feats = await queryBlocks(service, layer, box);
  log("query", `${feats.length.toLocaleString()} blocks returned`);
  if (feats.length === 0) {
    warn(
      "TIGERweb returned zero blocks — the payload will be empty and the toggle will do nothing",
    );
  }

  const frames = hazard.frames
    .filter((f) => f.rings.length > 0)
    .map((f) => ({ t: f.t, rings: f.rings, boxes: f.rings.map(boxOf) }));
  const stride = Math.max(1, Math.round(Math.sqrt(Math.max(1, frames.length))));

  const blocks: DetailBlock[] = [];
  let population = 0;
  let housingUnits = 0;
  let unpopulated = 0;
  let missingCounts = 0;

  for (const f of feats) {
    const rings = f.geometry?.rings;
    if (!rings || rings.length === 0) continue;
    // Esri polygons are outer-ring-clockwise with holes counter-clockwise; the
    // largest ring is the block itself and holes here are water, which carries
    // no population.
    const outer = rings.reduce((a, b) => (b.length > a.length ? b : a)) as LngLat[];
    const c = centroidOf(outer);

    let zoneId: string | null = null;
    for (const z of zones) {
      if (!inBox(z.box, c[0], c[1])) continue;
      if (!inRings(z.rings, c[0], c[1])) continue;
      zoneId = z.id;
      break;
    }

    const pop = Number(f.attributes.POP100);
    const hu = Number(f.attributes.HU100);
    if (!Number.isFinite(pop) || !Number.isFinite(hu)) missingCounts += 1;

    const b: DetailBlock = {
      id: String(f.attributes.GEOID ?? ""),
      ring: flatten(rdp(outer, SIMPLIFY_TOLERANCE)),
      c: [Math.round(c[0] * DP) / DP, Math.round(c[1] * DP) / DP],
      pop: Number.isFinite(pop) ? pop : 0,
      hu: Number.isFinite(hu) ? hu : 0,
      z: zoneId,
      h: frames.length > 0 ? firstInside(frames, c[0], c[1], stride) : null,
    };
    population += b.pop;
    housingUnits += b.hu;
    if (b.pop === 0) unpopulated += 1;
    blocks.push(b);
  }

  if (missingCounts > 0) {
    warn(
      `${missingCounts} block(s) came back without POP100/HU100 and are counted as zero — they are ` +
        `drawn but contribute nothing to the totals`,
    );
  }

  const payload: BlocksPayload = {
    scenarioId: scenario.id,
    vintage,
    blocks,
    totals: { blocks: blocks.length, population, housingUnits, unpopulated },
    source: `US Census ${vintage} decennial (P1 total population, H1 housing units) via TIGERweb ${service} layer ${layer}`,
    sourceUrl: `${TIGERWEB}/${service}/MapServer/${layer}`,
    note:
      `Summary level 100 — one level finer than the block groups in population.json, and an enumeration ` +
      `rather than a survey estimate, so these counts carry no margin of error. Vintage ${vintage} is the ` +
      `last decennial before ${scenario.eventDate}; a later census would describe the place after the event. ` +
      `Hazard arrival is the first perimeter frame containing the block centroid, so a large block reads as ` +
      `reached when its middle is reached.`,
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(dataDir, "detail");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "blocks.json");
  writeFileSync(outFile, JSON.stringify(payload));
  const bytes = statSync(outFile).size;

  const inZone = blocks.filter((b) => b.z !== null).length;
  const reached = blocks.filter((b) => b.h !== null).length;
  log(
    "counts",
    `${blocks.length.toLocaleString()} blocks, population ${population.toLocaleString()}, ` +
      `housing units ${housingUnits.toLocaleString()}, ${unpopulated} unpopulated, ` +
      `${inZone} inside an evacuation zone, ${reached} reached by the hazard`,
  );
  log("written", `${outFile} (${(bytes / 1e6).toFixed(2)} MB, ${warnings} warning(s))`);
  if (!existsSync(outFile)) throw new Error("write failed");
}

main().catch((err) => {
  console.error(`[blocks] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

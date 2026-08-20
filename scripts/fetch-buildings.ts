/**
 * Build the structure-level detail layer.
 *
 *   pnpm tsx scripts/fetch-buildings.ts [scenarioId]
 *
 * Writes public/data/<scenario>/detail/buildings.json.
 *
 * ── Why two upstreams, not one ──────────────────────────────────────────────
 *
 * Microsoft's Global ML Building Footprints is the best free footprint set for
 * rural California, and it is the geometry source here. It is also, for this
 * scenario, WRONG ABOUT THE PAST, and that is not a small caveat.
 *
 * Measured, not assumed. Counting ML footprint centroids inside Butte County's
 * own evacuation zone polygons and comparing with the county's published
 * StructureC field, using the 2026-02-03 release:
 *
 *     Town of Paradise   official 14,877   ML  5,884   ratio 0.40
 *     Magalia            official  5,969   ML  3,853   ratio 0.65
 *     Concow             official    636   ML    573   ratio 0.90
 *     Butte Valley       official  1,200   ML  1,732   ratio 1.44
 *
 * Butte Valley did not burn, and there the ML set OVER-counts — it sees sheds
 * and outbuildings the county does not list. So 0.40 in Paradise is not a
 * coverage failure. It is the Camp Fire: the imagery behind the current release
 * post-dates 2018-11-08, and the town is roughly 40% rebuilt. Shipping that set
 * alone would draw 5,884 structures in a town that had 14,877 to evacuate, and
 * the whole point of this layer is watching those structures fall.
 *
 * So the pre-event inventory comes from CAL FIRE's Damage Inspection (DINS)
 * programme instead: one inspected record per structure that was standing when
 * the fire arrived, with the outcome recorded. That is an observation of the
 * town Egress is replaying. Footprint geometry is joined onto it where a
 * surviving outline exists; where it does not — because the structure burned —
 * the record is drawn as a square of median local footprint area, and tagged
 * `derived-from-point` so nothing downstream can mistake it for a traced
 * outline.
 *
 * A scenario with no DINS incident (a plume, a fire outside California) simply
 * gets the ML set, a loud warning, and every structure marked presence
 * "imagery". Nothing is invented to fill the gap.
 *
 * Both endpoints were called and their responses read before this was written.
 * Neither needs a key.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { getScenario } from "../src/lib/constants";
import type {
  BuildingsPayload,
  DetailBuilding,
  FootprintSource,
  StructureCrossCheck,
  StructureDamage,
} from "../src/types/detail-layers";
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
const CACHE_DIR = join(HERE, ".cache");

const MS_MANIFEST =
  "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv";
const DINS =
  "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0";

/** The manifest partitions by zoom-9 quadkey; nothing else in it is spatial. */
const QUADKEY_ZOOM = 9;

/**
 * CAL FIRE inspects the whole incident, not our bbox, so the incident has to be
 * named. Absent here means "no inspection record exists for this event" — which
 * is the truth for a chemical plume and for anything outside California.
 */
const DINS_INCIDENT: Record<string, { name: string; county: string }> = {
  "camp-fire-2018": { name: "Camp", county: "Butte" },
  // Name and county read off a returnDistinctValues query against the live
  // service, not guessed: the only row matching '%alisade%' is
  // INCIDENTNAME 'Palisades' / INCIDENTNUM 'CALFD 000738' / COUNTY 'Los Angeles',
  // and that incident number is the same 000738 as the WFIGS perimeter's
  // attr_UniqueFireIdentifier '2025-CALFD-000738' the hazard track is built on.
  "palisades-fire-2025": { name: "Palisades", county: "Los Angeles" },
  // No entry for marshall-fire-2021 or conyers-plume-2024, and that is
  // deliberate. DINS is a CAL FIRE programme; a Colorado fire and a Georgia
  // chemical release are outside it. Guessing an incident name here would make
  // the query return zero rows quietly, which is strictly worse than the
  // unmapped path — that one prints a warning naming what is missing.
};

/** Join radius, metres. A DINS point is recorded at the parcel, not the roof
 *  centre, so this is generous enough to catch a set-back house and tight
 *  enough not to steal the neighbour's outline. */
const JOIN_RADIUS_M = 28;

/** ArcGIS caps a page at this; paging is by resultOffset over a stable sort. */
const PAGE = 2000;

/** Ramer-Douglas-Peucker tolerance in degrees. ~0.8 m at this latitude —
 *  invisible on a 12 m house, but it halves the vertex count on the traced
 *  outlines that come back with 40+ points. */
const SIMPLIFY_TOLERANCE = 0.0000072;

/** Coordinate output precision. 6dp is ~11 cm, well past what a footprint
 *  extracted from 30 cm imagery can support. */
const DP = 1e6;

/** Fallback square edge, metres, when a community has too few real footprints
 *  to take a median from. Roughly a 140 m² single-storey house. */
const FALLBACK_EDGE_M = 11.8;

let warnings = 0;

function log(tag: string, msg: string): void {
  console.log(`[buildings] ${tag.padEnd(11)} ${msg}`);
}

function warn(msg: string): void {
  warnings += 1;
  console.warn(`[buildings] WARNING     ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached HTTP. The two footprint parts are 14 MB gzipped between them and the
// DINS pull is a dozen pages; re-running the pipeline should not re-download.
// ─────────────────────────────────────────────────────────────────────────────

function cachePath(url: string, ext: string): string {
  return join(CACHE_DIR, `${createHash("sha1").update(url).digest("hex").slice(0, 20)}.${ext}`);
}

async function cachedBinary(url: string, label: string): Promise<Buffer> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = cachePath(url, "bin");
  if (existsSync(path)) return readFileSync(path);
  log("fetch", `${label} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  log("fetch", `${label} ${(buf.length / 1e6).toFixed(1)} MB`);
  return buf;
}

async function getJson<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

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

/** Even-odd ray cast. Ring may be open or closed. */
function inRing(ring: LngLat[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Multi-ring even-odd: an odd number of containing rings means inside, which
 *  is what makes a hole in a fire perimeter read as unburned. */
function inRings(rings: LngLat[][], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) if (inRing(r, x, y)) inside = !inside;
  return inside;
}

/** Shoelace area of a lng/lat ring in square metres, via a local equirectangular
 *  projection. Exact enough at building scale; nothing here needs a geodesic. */
function ringAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1];
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110540;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * mx * (ring[i][1] * my) - ring[i][0] * mx * (ring[j][1] * my);
  }
  return Math.abs(s / 2);
}

function centroidOf(ring: LngLat[]): LngLat {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length];
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

/** Flat [lng, lat, …] at 6dp, closing vertex dropped — deck.gl closes rings
 *  itself and the duplicate is pure payload. */
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

/** Axis-aligned square of `edge` metres centred on a point. */
function squareAt([lng, lat]: LngLat, edge: number): LngLat[] {
  const dy = edge / 2 / 110540;
  const dx = edge / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng - dx, lat - dy],
    [lng + dx, lat - dy],
    [lng + dx, lat + dy],
    [lng - dx, lat + dy],
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Quadkeys
// ─────────────────────────────────────────────────────────────────────────────

function tileOf(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [
    Math.floor(((lng + 180) / 360) * n),
    Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n),
  ];
}

function quadkey(x: number, y: number, z: number): string {
  let out = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    out += (x & mask ? 1 : 0) + (y & mask ? 2 : 0);
  }
  return out;
}

function quadkeysCovering(box: Box, z: number): string[] {
  const [x0, y0] = tileOf(box[0], box[3], z);
  const [x1, y1] = tileOf(box[2], box[1], z);
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(quadkey(x, y, z));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream 1 — Microsoft Global ML Building Footprints
// ─────────────────────────────────────────────────────────────────────────────

interface RawFootprint {
  ring: LngLat[];
  c: LngLat;
}

async function fetchFootprints(
  box: Box,
): Promise<{ rows: RawFootprint[]; vintage: string; parts: string[] }> {
  const csv = (await cachedBinary(MS_MANIFEST, "MS footprint manifest")).toString("utf8");
  const want = new Set(quadkeysCovering(box, QUADKEY_ZOOM));
  const parts: string[] = [];
  let vintage = "unknown";

  for (const line of csv.split("\n")) {
    // Location,QuadKey,Url,Size,UploadDate — Location has no comma in it.
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const rest = line.slice(comma + 1);
    const qk = rest.slice(0, rest.indexOf(","));
    if (!want.has(qk)) continue;
    const url = rest.slice(rest.indexOf(",") + 1).split(",")[0];
    if (!url.startsWith("http")) continue;
    parts.push(url);
    const m = url.match(/global-buildings\/(\d{4}-\d{2}-\d{2})\//);
    if (m) vintage = m[1];
  }

  if (parts.length === 0) {
    warn(
      `MS manifest has no part covering quadkeys ${[...want].join(", ")} — no footprints available`,
    );
    return { rows: [], vintage, parts };
  }

  const rows: RawFootprint[] = [];
  for (const url of parts) {
    const gz = await cachedBinary(
      url,
      `footprint part ${url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("/") + 18)}`,
    );
    const rl = createInterface({
      input: Readable.from(gz).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    let kept = 0;
    let seen = 0;
    for await (const line of rl) {
      if (!line) continue;
      seen += 1;
      const feat = JSON.parse(line) as { geometry: { coordinates: LngLat[][] } };
      const ring = feat.geometry?.coordinates?.[0];
      if (!ring || ring.length < 4) continue;
      const c = centroidOf(ring);
      if (!inBox(box, c[0], c[1])) continue;
      rows.push({ ring, c });
      kept += 1;
    }
    log(
      "footprints",
      `${kept.toLocaleString()} of ${seen.toLocaleString()} kept from ${url.match(/quadkey=(\d+)/)?.[1] ?? "?"}`,
    );
  }
  return { rows, vintage, parts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream 2 — CAL FIRE DINS
// ─────────────────────────────────────────────────────────────────────────────

interface DinsRecord {
  c: LngLat;
  damage: StructureDamage;
  type: string;
}

const DAMAGE_MAP: [RegExp, StructureDamage][] = [
  [/^destroyed/i, "destroyed"],
  [/^major/i, "major"],
  [/^minor/i, "minor"],
  [/^affected/i, "affected"],
  [/^no damage/i, "none"],
  [/^inaccessible/i, "inaccessible"],
];

function damageOf(raw: string | null): StructureDamage {
  for (const [re, v] of DAMAGE_MAP) if (raw && re.test(raw)) return v;
  return "inaccessible";
}

/** DINS publishes 30-odd structure classes; the map only needs the family. */
function structureClassOf(raw: string | null): string {
  if (!raw) return "Unknown";
  if (/mobile home|motor home/i.test(raw)) return "Mobile home";
  if (/multi family/i.test(raw)) return "Multi-family";
  if (/single family/i.test(raw)) return "Single family";
  if (/mixed commercial|commercial/i.test(raw)) return "Commercial";
  if (/school|church|hospital|infrastructure|utility/i.test(raw)) return "Institutional";
  if (/outbuilding|utility misc/i.test(raw)) return "Outbuilding";
  return raw;
}

async function fetchDins(scenarioId: string, box: Box): Promise<DinsRecord[]> {
  const incident = DINS_INCIDENT[scenarioId];
  if (!incident) {
    warn(
      `no CAL FIRE damage-inspection incident is mapped for "${scenarioId}" — the structure ` +
        `layer will carry imagery-derived footprints ONLY, every one tagged presence "imagery", ` +
        `and no structure in it is confirmed to have existed at T+0`,
    );
    return [];
  }

  const where = `INCIDENTNAME='${incident.name}' AND COUNTY='${incident.county}'`;
  const base =
    `${DINS}/query?f=json&where=${encodeURIComponent(where)}` +
    `&geometry=${box.join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=DAMAGE,STRUCTURETYPE` +
    `&orderByFields=OBJECTID&resultRecordCount=${PAGE}`;

  const out: DinsRecord[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let page: {
      features?: {
        attributes: Record<string, string | null>;
        geometry?: { x: number; y: number };
      }[];
      exceededTransferLimit?: boolean;
      error?: { message: string };
    };
    try {
      page = await getJson(`${base}&resultOffset=${offset}`, "DINS");
    } catch (e) {
      warn(
        `DINS page at offset ${offset} failed (${e instanceof Error ? e.message : String(e)}) — ` +
          `structure inventory is TRUNCATED at ${out.length} inspected records`,
      );
      break;
    }
    if (page.error) {
      warn(`DINS returned an error (${page.error.message}) — inventory truncated at ${out.length}`);
      break;
    }
    const feats = page.features ?? [];
    for (const f of feats) {
      if (!f.geometry) continue;
      out.push({
        c: [f.geometry.x, f.geometry.y],
        damage: damageOf(f.attributes.DAMAGE),
        type: structureClassOf(f.attributes.STRUCTURETYPE),
      });
    }
    if (feats.length < PAGE) break;
  }
  if (out.length === 0) {
    // A mapped incident that returns nothing is the quiet failure mode: the
    // layer would still build, from imagery alone, with the confident note.
    warn(
      `DINS returned ZERO records for INCIDENTNAME='${incident.name}' AND COUNTY='${incident.county}' — ` +
        `either the mapping is wrong or the incident is not in the programme. The structure layer falls ` +
        `back to imagery-derived footprints ONLY and nothing in it is confirmed to have existed at T+0`,
    );
  }
  log(
    "dins",
    `${out.length.toLocaleString()} inspected structures for the ${incident.name} incident`,
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hazard arrival
// ─────────────────────────────────────────────────────────────────────────────

/**
 * First frame tick whose footprint contains the point, or null.
 *
 * A linear scan is 97 frames x 20k structures x ~350 ring vertices, which is
 * minutes. A pure binary search assumes the footprint only ever grows, and an
 * interpolated perimeter that splits into 19 disjoint fronts does not quite
 * guarantee that. So: coarse stride to bracket, linear refine inside the
 * bracket. ~20 tests per structure, and correct even if a frame briefly
 * shrinks.
 */
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
    // The stride can step over a late arrival that only the final frame shows.
    const last = frames.length - 1;
    if (last % stride !== 0 && hit(last)) lo = last;
    else return null;
  }
  for (let i = Math.max(0, lo - stride + 1); i <= lo; i++) if (hit(i)) return frames[i].t;
  return frames[lo].t;
}

// ─────────────────────────────────────────────────────────────────────────────

interface ZoneIndexEntry {
  id: string;
  community: string;
  rings: LngLat[][];
  box: Box;
}

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario: ScenarioMeta = getScenario(scenarioId);
  const dataDir = join(ROOT, "public", "data", scenario.id);

  const zoneLayer = JSON.parse(readFileSync(join(dataDir, "zones.json"), "utf8")) as ZoneLayer;
  const hazard = JSON.parse(readFileSync(join(dataDir, "hazard.json"), "utf8")) as HazardTrack;

  // Communities come off the county's own published zone layer, which also
  // carries StructureC — the number the cross-check is against.
  const official = new Map<string, { community: string; structures: number }>();
  const officialPath = join(dataDir, "official-zones.geojson");
  if (existsSync(officialPath)) {
    const fc = JSON.parse(readFileSync(officialPath, "utf8")) as {
      features: { properties: Record<string, string | number> }[];
    };
    for (const f of fc.features) {
      const id = String(f.properties.Zone ?? "");
      if (!id) continue;
      official.set(id, {
        community: String(f.properties.Community ?? "Unassigned"),
        structures: Number(f.properties.StructureC ?? 0),
      });
    }
  } else {
    warn(`${officialPath} absent — no official structure count to cross-check against`);
  }

  const zones: ZoneIndexEntry[] = zoneLayer.zones.map((z: EvacZone) => ({
    id: z.id,
    community: official.get(z.id)?.community ?? "Unassigned",
    rings: z.geometry,
    box: z.geometry.map(boxOf).reduce(unionBox),
  }));

  // The console's bbox and the county's zones disagree at the edges, and both
  // are things an operator will pan to. Take the union, padded a little.
  let box: Box = [...scenario.bbox] as Box;
  box = extentBox(scenario.bbox as Box, zones, warn);
  box = [box[0] - 0.002, box[1] - 0.002, box[2] + 0.002, box[3] + 0.002];
  log("extent", `${box.map((v) => v.toFixed(4)).join(", ")} (scenario bbox ∪ evacuation zones)`);

  const { rows: footprints, vintage, parts } = await fetchFootprints(box);
  const dins = await fetchDins(scenario.id, box);

  // ── join ──────────────────────────────────────────────────────────────────
  // Grid hash at roughly the join radius, so a lookup touches 9 cells.
  const cell = JOIN_RADIUS_M / 111320;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  footprints.forEach((f, i) => {
    const k = key(f.c[0], f.c[1]);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  });

  const matched = new Array<DinsRecord | null>(footprints.length).fill(null);
  const claimed = new Uint8Array(footprints.length);
  const orphanDins: DinsRecord[] = [];
  const radDeg = JOIN_RADIUS_M / 111320;
  const latScale = Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);

  for (const rec of dins) {
    const cx = Math.floor(rec.c[0] / cell);
    const cy = Math.floor(rec.c[1] / cell);
    let best = -1;
    let bestD = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const i of grid.get(`${gx}:${gy}`) ?? []) {
          if (claimed[i]) continue;
          const dx = (footprints[i].c[0] - rec.c[0]) * latScale;
          const dy = footprints[i].c[1] - rec.c[1];
          const d = Math.hypot(dx, dy);
          if (d < bestD && d <= radDeg) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0) {
      claimed[best] = 1;
      matched[best] = rec;
    } else {
      orphanDins.push(rec);
    }
  }
  log(
    "join",
    `${dins.length - orphanDins.length} inspected structures matched a traced footprint, ` +
      `${orphanDins.length} did not (destroyed and never rebuilt — drawn as derived squares)`,
  );

  // Median traced footprint area, for the squares. Derived from THIS scenario's
  // own surviving buildings rather than a constant, so a town of cabins and a
  // town of ranch houses get different squares.
  const areas = footprints.map((f) => ringAreaM2(f.ring)).filter((a) => a > 15 && a < 1200);
  areas.sort((a, b) => a - b);
  const medianArea = areas.length > 40 ? areas[Math.floor(areas.length / 2)] : 0;
  const squareEdge = medianArea > 0 ? Math.sqrt(medianArea) : FALLBACK_EDGE_M;
  if (medianArea === 0) {
    warn(
      `fewer than 40 usable traced footprints — derived squares fall back to ${FALLBACK_EDGE_M} m`,
    );
  }
  log(
    "squares",
    `derived-square edge ${squareEdge.toFixed(1)} m (median traced footprint ${medianArea.toFixed(0)} m²)`,
  );

  // ── assemble ──────────────────────────────────────────────────────────────
  const frames = hazard.frames
    .filter((f) => f.rings.length > 0)
    .map((f) => ({ t: f.t, rings: f.rings, boxes: f.rings.map(boxOf) }));
  const stride = Math.max(1, Math.round(Math.sqrt(frames.length)));
  if (frames.length === 0)
    warn("hazard track has no frame with a perimeter — every structure will read as safe");

  const buildings: DetailBuilding[] = [];
  const crossCheck = new Map<string, StructureCrossCheck>();
  let fromImagery = 0;
  let fromPoint = 0;
  let inspected = 0;
  let destroyed = 0;
  let everInHazard = 0;

  const push = (
    ring: LngLat[],
    c: LngLat,
    source: FootprintSource,
    rec: DinsRecord | null,
  ): void => {
    let zoneId: string | null = null;
    let community = "Unassigned";
    for (const z of zones) {
      if (!inBox(z.box, c[0], c[1])) continue;
      if (!inRings(z.rings, c[0], c[1])) continue;
      zoneId = z.id;
      community = z.community;
      break;
    }
    const h = frames.length > 0 ? firstInside(frames, c[0], c[1], stride) : null;
    const simplified = source === "imagery" ? rdp(ring, SIMPLIFY_TOLERANCE) : ring;

    const b: DetailBuilding = {
      ring: flatten(simplified),
      c: [Math.round(c[0] * DP) / DP, Math.round(c[1] * DP) / DP],
      a: Math.round(ringAreaM2(ring)),
      z: zoneId,
      h,
      p: rec ? "inspected" : "imagery",
      f: source,
    };
    if (rec) {
      b.d = rec.damage;
      b.s = rec.type;
      inspected += 1;
      if (rec.damage === "destroyed") destroyed += 1;
    }
    if (source === "imagery") fromImagery += 1;
    else fromPoint += 1;
    if (h !== null) everInHazard += 1;

    const cc = crossCheck.get(community) ?? { community, official: 0, ours: 0, inspected: 0 };
    cc.ours += 1;
    if (rec) cc.inspected += 1;
    crossCheck.set(community, cc);

    buildings.push(b);
  };

  for (let i = 0; i < footprints.length; i++) {
    push(footprints[i].ring, footprints[i].c, "imagery", matched[i]);
  }
  for (const rec of orphanDins) push(squareAt(rec.c, squareEdge), rec.c, "derived-from-point", rec);

  // Official totals per community, from the county layer, for the cross-check.
  for (const z of zones) {
    const o = official.get(z.id);
    if (!o) continue;
    const cc = crossCheck.get(o.community) ?? {
      community: o.community,
      official: 0,
      ours: 0,
      inspected: 0,
    };
    cc.official += o.structures;
    crossCheck.set(o.community, cc);
  }

  const hasDins = dins.length > 0;
  const payload: BuildingsPayload = {
    scenarioId: scenario.id,
    buildings,
    imageryVintage: vintage,
    counts: { total: buildings.length, fromImagery, fromPoint, inspected, destroyed, everInHazard },
    crossCheck: [...crossCheck.values()].sort((a, b) => b.official - a.official || b.ours - a.ours),
    sources: [
      {
        name: "Microsoft Global ML Building Footprints",
        url: parts[0] ?? MS_MANIFEST,
        role: `traced outlines, release ${vintage} — imagery POST-DATES the event`,
        count: footprints.length,
      },
      ...(hasDins
        ? [
            {
              name: "CAL FIRE Damage Inspection (DINS)",
              url: DINS,
              role: "observed pre-event structure inventory with damage outcome",
              count: dins.length,
            },
          ]
        : []),
    ],
    note: hasDins
      ? `Structures standing at T+0, from ${dins.length.toLocaleString()} CAL FIRE damage inspections of the ` +
        `${DINS_INCIDENT[scenario.id]?.name} incident. Outlines are Microsoft ML footprints (release ${vintage}) ` +
        `where one survives within ${JOIN_RADIUS_M} m; the ${orphanDins.length.toLocaleString()} inspected ` +
        `structures with no surviving outline are drawn as ${squareEdge.toFixed(0)} m squares and tagged ` +
        `derived-from-point. ${(footprints.length - (dins.length - orphanDins.length)).toLocaleString()} ` +
        `further footprints appear in post-event imagery with no inspection record — they are tagged presence ` +
        `"imagery" and may be rebuilds. Hazard arrival is the first perimeter frame containing the centroid.`
      : `Machine-learned footprints only, Microsoft release ${vintage}. NO inspection record exists for this ` +
        `scenario, so no structure here is confirmed to have existed at T+0 and the count is a lower bound ` +
        `on the pre-event inventory wherever the event destroyed structures.`,
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(dataDir, "detail");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "buildings.json");
  writeFileSync(outFile, JSON.stringify(payload));
  const bytes = statSync(outFile).size;

  console.log("");
  for (const cc of payload.crossCheck) {
    if (cc.official === 0 && cc.ours < 50) continue;
    const ratio = cc.official > 0 ? (cc.ours / cc.official).toFixed(2) : "—";
    log(
      "crosscheck",
      `${cc.community.padEnd(20)} county ${String(cc.official).padStart(6)}  ours ${String(cc.ours).padStart(6)}  ` +
        `inspected ${String(cc.inspected).padStart(6)}  ratio ${ratio}`,
    );
  }
  log(
    "counts",
    `${buildings.length.toLocaleString()} structures — ${fromImagery.toLocaleString()} traced, ` +
      `${fromPoint.toLocaleString()} derived squares, ${inspected.toLocaleString()} inspected ` +
      `(${destroyed.toLocaleString()} destroyed), ${everInHazard.toLocaleString()} reached by the hazard`,
  );
  log("written", `${outFile} (${(bytes / 1e6).toFixed(2)} MB, ${warnings} warning(s))`);
}

main().catch((err) => {
  console.error(`[buildings] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

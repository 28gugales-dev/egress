/**
 * Pulls the drivable road network for a scenario from OpenStreetMap Overpass
 * and emits public/data/<scenario>/network.json as a RoadNetwork.
 *
 *   pnpm data:network [scenarioId]        # default camp-fire-2018
 *   REFRESH=1 pnpm data:network           # ignore scripts/.cache
 *
 * Topology matters more than geometry here: the solver needs true graph edges,
 * so OSM ways are split at every node that two or more ways share, then the
 * resulting degree-2 junctions (one OSM way continued by another, same road)
 * are merged back so the graph carries decisions, not bookkeeping.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRAFLOW_CLASSES, DEFAULT_SPEED, LANE_CAPACITY, SCENARIOS } from "../src/lib/constants";
import type { LngLat, RoadClass, RoadEdge, RoadNetwork, RoadNode } from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

const KEEP_CLASSES: RoadClass[] = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "service",
];

/** Directional lanes assumed when OSM has no lanes tag at all. */
const DEFAULT_LANES: Record<RoadClass, number> = {
  motorway: 2,
  trunk: 2,
  primary: 1,
  secondary: 1,
  tertiary: 1,
  residential: 1,
  unclassified: 1,
  service: 1,
};

/** A boundary node only counts as an exit if a real through-route runs over it. */
const SINK_BOUNDARY_CLASSES: RoadClass[] = ["motorway", "trunk", "primary"];
const SINK_BOUNDARY_M = 400;
const SINK_SNAP_WARN_M = 2000;

const DP_TOLERANCE_M = 8;
const COORD_DECIMALS = 6;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
const MAX_ATTEMPTS = 9;
/** Matches the server-side [timeout:180] so a hung mirror rotates, not stalls. */
const REQUEST_TIMEOUT_MS = 180_000;

interface ExplicitSink {
  label: string;
  position: LngLat;
  /** Restricts snapping to nodes touching a road with this name. */
  namePattern?: RegExp;
}

/**
 * Boundary crossings that the generic rule cannot see. Paradise has no
 * motorway or trunk inside the bbox at all — its four real egress routes are
 * tagged secondary (Skyway, Clark) and tertiary (Neal, Pentz), so they have to
 * be named. Coordinates are the surveyed OSM crossing of the bbox edge.
 */
const EXPLICIT_SINKS: Record<string, ExplicitSink[]> = {
  "camp-fire-2018": [
    {
      label: "Skyway south — toward Chico",
      position: [-121.71733, 39.71133],
      namePattern: /^skyway/i,
    },
    { label: "Neal Road south", position: [-121.71995, 39.68011], namePattern: /^neal/i },
    { label: "Clark Road south", position: [-121.62702, 39.68005], namePattern: /^clark/i },
    { label: "Pentz Road south", position: [-121.56982, 39.68066], namePattern: /^pentz/i },
  ],
  // PCH is trunk/motorway and Topanga Canyon Blvd is primary, so both are
  // picked up by the boundary rule where they cross the bbox. Sunset is tagged
  // secondary for its whole length and would otherwise be missed — which would
  // strand the only eastbound exit from the community. Coordinate is the
  // easternmost Sunset vertex inside the bbox, read off the Overpass pull.
  "palisades-fire-2025": [
    {
      label: "Sunset Boulevard east — toward Brentwood and the 405",
      position: [-118.50501, 34.05097],
      namePattern: /sunset/i,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

const EARTH_R = 6_371_008.8;
const DEG = Math.PI / 180;

function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLng = (b[0] - a[0]) * DEG;
  const la1 = a[1] * DEG;
  const la2 = b[1] * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathLength(pts: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
  return total;
}

/** Douglas-Peucker in local metres. Endpoints are always preserved. */
function simplify(pts: LngLat[], toleranceM: number): LngLat[] {
  if (pts.length <= 2) return pts;

  const lat0 = pts[Math.floor(pts.length / 2)][1];
  const mx = EARTH_R * DEG * Math.cos(lat0 * DEG);
  const my = EARTH_R * DEG;
  const xs = pts.map((p) => p[0] * mx);
  const ys = pts.map((p) => p[1] * my);

  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    if (last - first < 2) continue;

    const ax = xs[first];
    const ay = ys[first];
    const bx = xs[last];
    const by = ys[last];
    const dx = bx - ax;
    const dy = by - ay;
    const denom = dx * dx + dy * dy;

    let worst = -1;
    let worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = xs[i] - ax;
      const py = ys[i] - ay;
      let d: number;
      if (denom === 0) {
        d = Math.hypot(px, py);
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / denom));
        d = Math.hypot(px - t * dx, py - t * dy);
      }
      if (d > worst) {
        worst = d;
        worstIdx = i;
      }
    }

    if (worst > toleranceM && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([first, worstIdx], [worstIdx, last]);
    }
  }

  const out: LngLat[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function roundCoord(p: LngLat): LngLat {
  const f = 10 ** COORD_DECIMALS;
  return [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f];
}

/** Metres from a point to the bbox boundary — inside or just outside. */
function distanceToBoundary(p: LngLat, bbox: [number, number, number, number]): number {
  const [w, s, e, n] = bbox;
  const mLat = EARTH_R * DEG;
  const mLon = mLat * Math.cos(p[1] * DEG);
  const inside = p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
  if (inside) {
    return Math.min(
      Math.abs(p[0] - w) * mLon,
      Math.abs(p[0] - e) * mLon,
      Math.abs(p[1] - s) * mLat,
      Math.abs(p[1] - n) * mLat,
    );
  }
  const cx = Math.min(Math.max(p[0], w), e);
  const cy = Math.min(Math.max(p[1], s), n);
  return Math.hypot((p[0] - cx) * mLon, (p[1] - cy) * mLat);
}

// ─────────────────────────────────────────────────────────────────────────────
// OSM tag parsing
// ─────────────────────────────────────────────────────────────────────────────

type Tags = Record<string, string>;

function toRoadClass(highway: string | undefined): RoadClass | null {
  if (!highway) return null;
  const base = highway.endsWith("_link") ? highway.slice(0, -"_link".length) : highway;
  return (KEEP_CLASSES as string[]).includes(base) ? (base as RoadClass) : null;
}

/** 1 = with the way, -1 = against it, 0 = two-way. */
function parseOneway(tags: Tags, roadClass: RoadClass): 1 | -1 | 0 {
  const raw = (tags.oneway ?? "").trim().toLowerCase();
  if (raw === "yes" || raw === "true" || raw === "1") return 1;
  if (raw === "-1" || raw === "reverse") return -1;
  if (raw === "no" || raw === "false" || raw === "0") return 0;
  const junction = (tags.junction ?? "").toLowerCase();
  if (junction === "roundabout" || junction === "circular") return 1;
  // OSM treats motorway (and its links) as implicitly one-way.
  return roadClass === "motorway" ? 1 : 0;
}

function parseLaneCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number.parseFloat(raw.split(";")[0]);
  if (!Number.isFinite(v) || v < 1) return null;
  return Math.floor(v);
}

function directionalLanes(tags: Tags, roadClass: RoadClass, oneway: boolean): number {
  const fwd = parseLaneCount(tags["lanes:forward"]);
  const bwd = parseLaneCount(tags["lanes:backward"]);
  const total = parseLaneCount(tags.lanes);
  if (oneway) return total ?? fwd ?? DEFAULT_LANES[roadClass];
  // Asymmetric tagging: the edge carries one number, so take the forward side.
  if (fwd) return fwd;
  if (bwd) return bwd;
  if (total) return Math.max(1, Math.floor(total / 2));
  return DEFAULT_LANES[roadClass];
}

function parseSpeed(raw: string | undefined, roadClass: RoadClass): number {
  const fallback = DEFAULT_SPEED[roadClass];
  if (!raw) return fallback;
  const first = raw.split(";")[0].trim().toLowerCase();
  const m = first.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/);
  if (!m) return fallback; // "walk", "US:urban", "signals", etc.
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return m[2] === "mph" ? Math.round(v * 1.609344) : Math.round(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass fetch
// ─────────────────────────────────────────────────────────────────────────────

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}
interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Tags;
}
type OsmElement = OsmNode | OsmWay | { type: string; id: number };

interface OverpassResponse {
  elements: OsmElement[];
  generator?: string;
  osm3s?: { timestamp_osm_base?: string };
}

function buildQuery(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  const classRe = `^(${KEEP_CLASSES.join("|")})(_link)?$`;
  return [
    "[out:json][timeout:180];",
    `way["highway"~"${classRe}"](${s},${w},${n},${e});`,
    "out body;",
    ">;",
    "out skel qt;",
  ].join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(
  query: string,
  cacheFile: string,
): Promise<{ data: OverpassResponse; source: string } | null> {
  if (process.env.REFRESH !== "1") {
    try {
      const cached = await readFile(cacheFile, "utf8");
      console.log(`[fetch] cache hit ${path.basename(cacheFile)} (${cached.length} bytes)`);
      return { data: JSON.parse(cached) as OverpassResponse, source: "scripts/.cache" };
    } catch {
      // fall through to network
    }
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "egress-evac-planner/0.1 (offline research pipeline)",
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429 || res.status === 503 || res.status === 504) {
        const wait = 2000 * 2 ** Math.floor(attempt / OVERPASS_ENDPOINTS.length);
        console.log(`[fetch] ${endpoint} -> ${res.status}, rotating in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        console.log(`[fetch] ${endpoint} -> HTTP ${res.status}`);
        await sleep(1500);
        continue;
      }

      const text = await res.text();
      const data = JSON.parse(text) as OverpassResponse;
      if (!Array.isArray(data.elements)) throw new Error("no elements array");
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, text, "utf8");
      console.log(`[fetch] ${new URL(endpoint).host} ok — ${text.length} bytes, cached`);
      return { data, source: new URL(endpoint).host };
    } catch (err) {
      console.log(`[fetch] ${endpoint} failed: ${(err as Error).message}`);
      await sleep(1500);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph construction
// ─────────────────────────────────────────────────────────────────────────────

interface WorkEdge {
  id: string;
  from: string;
  to: string;
  roadClass: RoadClass;
  lanes: number;
  oneway: boolean;
  length: number;
  speed: number;
  capacity: number;
  contraflowEligible: boolean;
  geometry: LngLat[];
  /** OSM node id per geometry vertex — kept so sinks can split mid-edge. */
  refs: string[];
  name?: string;
  dead: boolean;
}

interface Graph {
  edges: WorkEdge[];
  positions: Map<string, LngLat>;
}

function buildGraph(data: OverpassResponse): Graph {
  const positions = new Map<string, LngLat>();
  const ways: OsmWay[] = [];

  for (const el of data.elements) {
    if (el.type === "node") {
      const n = el as OsmNode;
      positions.set(String(n.id), [n.lon, n.lat]);
    } else if (el.type === "way") {
      const w = el as OsmWay;
      if (w.tags && toRoadClass(w.tags.highway) && Array.isArray(w.nodes)) ways.push(w);
    }
  }
  console.log(`[parse] ${ways.length} drivable ways, ${positions.size} raw nodes`);

  // A node is a graph node when 2+ ways touch it, a way starts/ends on it, or a
  // single way passes through it twice (figure-eight, lollipop loops).
  const wayRefs = new Map<string, number>();
  const forced = new Set<string>();
  for (const w of ways) {
    const seen = new Set<string>();
    for (const raw of w.nodes) {
      const id = String(raw);
      if (seen.has(id)) forced.add(id);
      seen.add(id);
    }
    for (const id of seen) wayRefs.set(id, (wayRefs.get(id) ?? 0) + 1);
    forced.add(String(w.nodes[0]));
    forced.add(String(w.nodes[w.nodes.length - 1]));
  }
  const isJunction = (id: string) => forced.has(id) || (wayRefs.get(id) ?? 0) >= 2;

  const edges: WorkEdge[] = [];
  let dropped = 0;

  for (const w of ways) {
    const tags = w.tags as Tags;
    const roadClass = toRoadClass(tags.highway) as RoadClass;

    // Drop refs we have no coordinate for, and collapse repeated refs.
    const refs: string[] = [];
    for (const raw of w.nodes) {
      const id = String(raw);
      if (!positions.has(id)) continue;
      if (refs.length && refs[refs.length - 1] === id) continue;
      refs.push(id);
    }
    if (refs.length < 2) {
      dropped++;
      continue;
    }

    const dir = parseOneway(tags, roadClass);
    const oneway = dir !== 0;
    const lanes = directionalLanes(tags, roadClass, oneway);
    const speed = parseSpeed(tags.maxspeed, roadClass);
    const name = tags.name;
    const capacity = Math.round(lanes * LANE_CAPACITY[roadClass]);
    const contraflowEligible = CONTRAFLOW_CLASSES.includes(roadClass) && !oneway;

    let start = 0;
    let seq = 0;
    for (let i = 1; i < refs.length; i++) {
      const last = i === refs.length - 1;
      if (!last && !isJunction(refs[i])) continue;

      const slice = refs.slice(start, i + 1);
      start = i;
      if (slice.length < 2 || slice[0] === slice[slice.length - 1]) continue;

      // oneway=-1 means travel runs against the way's node order.
      const segRefs = dir === -1 ? slice.slice().reverse() : slice;
      const geometry = segRefs.map((id) => positions.get(id) as LngLat);

      const length = pathLength(geometry);
      if (length < 0.5) continue;

      edges.push({
        id: `w${w.id}-${seq++}`,
        from: segRefs[0],
        to: segRefs[segRefs.length - 1],
        roadClass,
        lanes,
        oneway,
        length,
        speed,
        capacity,
        contraflowEligible,
        geometry,
        refs: segRefs,
        name,
        dead: false,
      });
    }
  }

  if (dropped) console.log(`[split] ${dropped} ways skipped (fewer than 2 resolvable nodes)`);
  console.log(`[split] ${edges.length} segments after splitting at intersections`);
  return { edges, positions };
}

/** Two edges may fuse only if nothing about the road changes across the node. */
function compatible(a: WorkEdge, b: WorkEdge): boolean {
  return (
    a.roadClass === b.roadClass &&
    a.oneway === b.oneway &&
    a.lanes === b.lanes &&
    a.speed === b.speed &&
    a.capacity === b.capacity &&
    a.contraflowEligible === b.contraflowEligible &&
    (a.name ?? "") === (b.name ?? "")
  );
}

function reversed(e: WorkEdge): WorkEdge {
  return {
    ...e,
    from: e.to,
    to: e.from,
    geometry: e.geometry.slice().reverse(),
    refs: e.refs.slice().reverse(),
  };
}

/**
 * Collapse degree-2 junctions. These are artefacts of OSM way splitting, not
 * routing decisions — no turn is possible there. Geometry is concatenated, so
 * nothing is lost; only the redundant graph node disappears.
 */
function mergeDegreeTwo(edges: WorkEdge[]): number {
  let removed = 0;

  for (let pass = 0; pass < 40; pass++) {
    const inc = new Map<string, number[]>();
    const touch = (node: string, i: number) => {
      const list = inc.get(node);
      if (list) list.push(i);
      else inc.set(node, [i]);
    };
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.dead) continue;
      touch(e.from, i);
      touch(e.to, i);
    }

    const touched = new Set<number>();
    let mergedThisPass = 0;

    for (const [node, list] of inc) {
      if (list.length !== 2) continue;
      const [ia, ib] = list;
      if (ia === ib) continue; // self-loop through the node
      if (touched.has(ia) || touched.has(ib)) continue;

      let a = edges[ia];
      let b = edges[ib];
      if (a.dead || b.dead || !compatible(a, b)) continue;

      if (a.oneway) {
        // Direction must chain: ...->node->...
        if (a.to === node && b.from === node) {
          // ok
        } else if (b.to === node && a.from === node) {
          const t = a;
          a = b;
          b = t;
        } else {
          continue;
        }
      } else {
        if (a.from === node) a = reversed(a);
        if (b.to === node) b = reversed(b);
        if (a.to !== node || b.from !== node) continue;
      }

      if (a.from === b.to) continue; // would close a ring and orphan the node

      const merged: WorkEdge = {
        ...a,
        from: a.from,
        to: b.to,
        length: a.length + b.length,
        geometry: a.geometry.concat(b.geometry.slice(1)),
        refs: a.refs.concat(b.refs.slice(1)),
        dead: false,
      };
      edges[ia] = merged;
      edges[ib] = { ...b, dead: true };
      touched.add(ia);
      touched.add(ib);
      mergedThisPass++;
      removed++;
    }

    console.log(`[merge] pass ${pass + 1}: fused ${mergedThisPass} degree-2 junctions`);
    if (!mergedThisPass) break;
  }

  return removed;
}

/**
 * Resolves an explicit sink to a real graph node. The hand-entered coordinates
 * are bbox crossings, which almost always land mid-edge — so the edge is split
 * there rather than snapping to whatever intersection happens to be nearest,
 * which on a rural arterial can be kilometres away.
 */
function resolveExplicitSink(
  edges: WorkEdge[],
  spec: ExplicitSink,
): { nodeId: string; distance: number; named: boolean; split: boolean } | null {
  let best: { edgeIdx: number; vertex: number; d: number; named: boolean } | null = null;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.dead) continue;
    const named = spec.namePattern ? Boolean(e.name && spec.namePattern.test(e.name)) : true;
    // A vertex on the named road always beats a merely-closer one elsewhere.
    if (best?.named && !named) continue;
    for (let v = 0; v < e.geometry.length; v++) {
      const d = haversine(e.geometry[v], spec.position);
      if (!best || (named && !best.named) || d < best.d) {
        best = { edgeIdx: i, vertex: v, d, named };
      }
    }
  }
  if (!best) return null;

  const e = edges[best.edgeIdx];
  const last = e.geometry.length - 1;
  if (best.vertex === 0) {
    return { nodeId: e.from, distance: best.d, named: best.named, split: false };
  }
  if (best.vertex === last) {
    return { nodeId: e.to, distance: best.d, named: best.named, split: false };
  }

  const headGeom = e.geometry.slice(0, best.vertex + 1);
  const tailGeom = e.geometry.slice(best.vertex);
  const headRefs = e.refs.slice(0, best.vertex + 1);
  const tailRefs = e.refs.slice(best.vertex);
  edges[best.edgeIdx] = {
    ...e,
    id: `${e.id}s0`,
    to: headRefs[headRefs.length - 1],
    geometry: headGeom,
    refs: headRefs,
    length: pathLength(headGeom),
  };
  edges.push({
    ...e,
    id: `${e.id}s1`,
    from: tailRefs[0],
    geometry: tailGeom,
    refs: tailRefs,
    length: pathLength(tailGeom),
  });
  return { nodeId: e.refs[best.vertex], distance: best.d, named: best.named, split: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Last-resort grid so downstream stages can still run. It is NOT real road
 * geometry and the caller shouts about it.
 */
function synthesizeNetwork(bbox: [number, number, number, number]): Graph {
  const [w, s, e, n] = bbox;
  const cols = 44;
  const rows = 44;
  const positions = new Map<string, LngLat>();
  const edges: WorkEdge[] = [];

  const id = (r: number, c: number) => `syn-${r}-${c}`;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      positions.set(id(r, c), [w + ((e - w) * c) / cols, s + ((n - s) * r) / rows]);
    }
  }

  const classOf = (r: number, c: number): RoadClass => {
    if (r % 11 === 0 || c % 11 === 0) return "primary";
    if (r % 5 === 0 || c % 5 === 0) return "secondary";
    return "residential";
  };

  const push = (a: string, b: string, roadClass: RoadClass) => {
    const geometry = [positions.get(a) as LngLat, positions.get(b) as LngLat];
    const lanes = DEFAULT_LANES[roadClass];
    edges.push({
      id: `syn${edges.length}`,
      from: a,
      to: b,
      roadClass,
      lanes,
      oneway: false,
      length: pathLength(geometry),
      speed: DEFAULT_SPEED[roadClass],
      capacity: Math.round(lanes * LANE_CAPACITY[roadClass]),
      contraflowEligible: CONTRAFLOW_CLASSES.includes(roadClass),
      geometry,
      refs: [a, b],
      name: `Synthetic ${roadClass}`,
      dead: false,
    });
  };

  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (c < cols) push(id(r, c), id(r, c + 1), classOf(r, c));
      if (r < rows) push(id(r, c), id(r + 1, c), classOf(r, c));
    }
  }
  return { edges, positions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(
      `Unknown scenario "${scenarioId}". Known: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
    return;
  }
  const bbox = scenario.bbox;
  console.log(`[scenario] ${scenario.id} — ${scenario.place}, bbox ${bbox.join(",")}`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const query = buildQuery(bbox);
  const hash = createHash("sha1").update(query).digest("hex").slice(0, 10);
  const cacheFile = path.join(here, ".cache", `overpass-${scenario.id}-${hash}.json`);

  const fetched = await fetchOverpass(query, cacheFile);

  let graph: Graph = { edges: [], positions: new Map() };
  let source = "";
  let synthetic = false;

  if (fetched) {
    graph = buildGraph(fetched.data);
    const osmBase = fetched.data.osm3s?.timestamp_osm_base;
    source = `OpenStreetMap contributors (ODbL) via Overpass API${osmBase ? ` — OSM base ${osmBase}` : ""}`;
    if (graph.edges.length === 0) {
      console.log("[parse] zero drivable edges returned — falling back to synthetic grid");
      graph = synthesizeNetwork(bbox);
      synthetic = true;
    }
  } else {
    graph = synthesizeNetwork(bbox);
    synthetic = true;
  }

  if (synthetic) {
    source = "SYNTHETIC uniform grid — NOT real OpenStreetMap geometry";
    console.log(
      "!!!! LOUD WARNING: Overpass unreachable on all three mirrors. SYNTHESIZED a 44x44 " +
        "uniform lat/lon grid covering the scenario bbox: every node position, every edge " +
        "geometry, all road names, all lane counts and all speeds are FABRICATED " +
        "(primary every 11th line, secondary every 5th, residential otherwise). " +
        "Nothing in network.json is real. Re-run with REFRESH=1 once Overpass responds. !!!!",
    );
  }

  const beforeMerge = graph.edges.filter((e) => !e.dead).length;
  const removed = mergeDegreeTwo(graph.edges);
  console.log(
    `[merge] ${beforeMerge} -> ${graph.edges.filter((e) => !e.dead).length} edges (${removed} fusions)`,
  );

  // ── Sinks ────────────────────────────────────────────────────────────────
  const explicitSinkIds: string[] = [];
  for (const spec of EXPLICIT_SINKS[scenario.id] ?? []) {
    const hit = resolveExplicitSink(graph.edges, spec);
    if (!hit) {
      console.log(`[sinks] explicit "${spec.label}" — no candidate edge, skipped`);
      continue;
    }
    explicitSinkIds.push(hit.nodeId);
    const flag = hit.distance > SINK_SNAP_WARN_M ? "  <-- WARNING: far snap" : "";
    console.log(
      `[sinks] explicit "${spec.label}" -> node ${hit.nodeId} (${hit.distance.toFixed(0)} m, ${
        hit.named ? "name match" : "nearest"
      }, ${hit.split ? "edge split" : "existing junction"})${flag}`,
    );
  }

  const live = graph.edges.filter((e) => !e.dead);

  // Only nodes that survive as edge endpoints stay in the payload.
  const usedNodes = new Set<string>();
  const nodeClasses = new Map<string, Set<RoadClass>>();
  for (const e of live) {
    for (const id of [e.from, e.to]) {
      usedNodes.add(id);
      let cs = nodeClasses.get(id);
      if (!cs) nodeClasses.set(id, (cs = new Set()));
      cs.add(e.roadClass);
    }
  }

  const sinks = new Set<string>();
  for (const id of usedNodes) {
    const pos = graph.positions.get(id);
    if (!pos) continue;
    if (distanceToBoundary(pos, bbox) > SINK_BOUNDARY_M) continue;
    const cs = nodeClasses.get(id);
    if (cs && SINK_BOUNDARY_CLASSES.some((c) => cs.has(c))) sinks.add(id);
  }
  console.log(
    `[sinks] ${sinks.size} from the boundary rule (<=${SINK_BOUNDARY_M} m from bbox edge on ${SINK_BOUNDARY_CLASSES.join("/")})`,
  );
  for (const id of explicitSinkIds) sinks.add(id);

  // ── Emit ─────────────────────────────────────────────────────────────────
  let rawPoints = 0;
  let keptPoints = 0;
  const outEdges: RoadEdge[] = live.map((e) => {
    rawPoints += e.geometry.length;
    const geometry = simplify(e.geometry, DP_TOLERANCE_M).map(roundCoord);
    keptPoints += geometry.length;
    const edge: RoadEdge = {
      id: e.id,
      from: e.from,
      to: e.to,
      roadClass: e.roadClass,
      lanes: e.lanes,
      oneway: e.oneway,
      length: Math.round(e.length * 10) / 10,
      speed: e.speed,
      capacity: e.capacity,
      contraflowEligible: e.contraflowEligible,
      geometry,
    };
    if (e.name) edge.name = e.name;
    return edge;
  });
  console.log(
    `[simplify] Douglas-Peucker ${DP_TOLERANCE_M} m: ${rawPoints} -> ${keptPoints} vertices`,
  );

  const outNodes: RoadNode[] = [...usedNodes]
    .filter((id) => graph.positions.has(id))
    .map((id) => {
      const node: RoadNode = { id, position: roundCoord(graph.positions.get(id) as LngLat) };
      if (sinks.has(id)) node.isSink = true;
      return node;
    });

  // Disconnected fragments are real (corridors that only rejoin outside the
  // bbox), but the solver needs to know the sinks sit on the main component.
  const adjacency = new Map<string, string[]>();
  for (const id of usedNodes) adjacency.set(id, []);
  for (const e of outEdges) {
    adjacency.get(e.from)?.push(e.to);
    adjacency.get(e.to)?.push(e.from);
  }
  const seen = new Set<string>();
  let components = 0;
  let largest = 0;
  let largestRoot = "";
  for (const id of usedNodes) {
    if (seen.has(id)) continue;
    components++;
    let size = 0;
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const v = stack.pop() as string;
      size++;
      for (const w of adjacency.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    if (size > largest) {
      largest = size;
      largestRoot = id;
    }
  }
  const mainComponent = new Set<string>([largestRoot]);
  const stack = [largestRoot];
  while (stack.length) {
    const v = stack.pop() as string;
    for (const w of adjacency.get(v) ?? []) {
      if (!mainComponent.has(w)) {
        mainComponent.add(w);
        stack.push(w);
      }
    }
  }
  const sinksOnMain = [...sinks].filter((s) => mainComponent.has(s)).length;
  console.log(
    `[graph] ${components} components, largest ${largest}/${usedNodes.size} nodes (${((100 * largest) / usedNodes.size).toFixed(1)}%), ${sinksOnMain}/${sinks.size} sinks on it`,
  );

  const network: RoadNetwork = {
    scenarioId: scenario.id,
    nodes: outNodes,
    edges: outEdges,
    sinks: [...sinks].sort(),
    generatedAt: new Date().toISOString(),
    source,
  };

  const outDir = path.join(repoRoot, "public", "data", scenario.id);
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "network.json");
  const json = JSON.stringify(network);
  await writeFile(outFile, json, "utf8");

  const laneKm = outEdges.reduce((sum, e) => sum + (e.lanes * e.length) / 1000, 0);
  const bytes = Buffer.byteLength(json, "utf8");
  console.log(`[write] ${outFile}  ${bytes} bytes (${(bytes / 1_048_576).toFixed(2)} MB)`);
  console.log(
    `[done] nodes=${outNodes.length}  edges=${outEdges.length}  laneKm=${laneKm.toFixed(1)}  sinks=${network.sinks.length}  size=${(bytes / 1_048_576).toFixed(2)}MB`,
  );
  if (bytes > 6 * 1_048_576) {
    console.log(
      "[warn] payload exceeds the ~6 MB budget — raise DP_TOLERANCE_M or trim service roads",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

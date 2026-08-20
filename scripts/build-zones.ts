/**
 * build-zones.ts — build the evacuation zone set from population + network + hazard.
 *
 * TWO PATHS, and the script says out loud which one ran.
 *
 * OFFICIAL (preferred) — when public/data/<scenario>/official-zones.geojson is
 * present, the county's own published polygons ARE the zone set. Their ids are
 * kept verbatim, because the entire product claim is that Egress emits a release
 * sequence keyed to the naming the county already runs. `BUT-TOP-01` makes that
 * claim literally true; a derived `PAR-E001` only asserts it. Population is
 * attached by AREAL APPORTIONMENT — census block groups are far coarser than
 * these zones and routinely straddle four or five of them, so each zone takes
 * the fraction of every block group its polygon actually covers, never the whole
 * block group and never nothing. Run scripts/fetch-evac-zones.ts first.
 *
 * DERIVED (fallback) — no official layer for this county, so we derive zones the
 * way a county planner would: every household drains onto ONE arterial, so the
 * zone boundary that matters is the catchment of that arterial, not a census line.
 *
 *   1. multi-source Dijkstra (reversed graph, travel-time weights) from every
 *      sink gives each node its shortest time out and a successor pointer.
 *   2. each population cell snaps to its nearest REACHABLE node, walks the
 *      successor chain to a sink, and is keyed by the first trunk-class edge
 *      it touches — its primary egress corridor.
 *   3. cells sharing a corridor AND spatially contiguous become a cluster;
 *      oversized clusters split along the corridor so wave sizing has
 *      resolution; the set is rebalanced toward 15-25 zones.
 *   4. cell polygons are dissolved by shared-edge cancellation (with a convex
 *      hull fallback guarded on area sanity).
 *   5. zones are numbered by hazard ETA ascending, so -E001 is always the one
 *      that burns first. The UI treats that ordering as load-bearing.
 *
 * Usage: tsx scripts/build-zones.ts [scenarioId]
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SPEED, getScenario, LANE_CAPACITY } from "../src/lib/constants";
import type {
  EvacZone,
  HazardFrame,
  HazardTrack,
  LngLat,
  PopulationCell,
  PopulationLayer,
  RoadClass,
  RoadEdge,
  RoadNetwork,
  ScenarioMeta,
  Tick,
  ZoneLayer,
} from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classes that count as an egress corridor; everything below is a feeder.
 *
 * tertiary is in deliberately. In a mountain town OSM tags the roads that
 * actually carry the evacuation — Pentz Rd, Neal Rd, Pearson Rd — as tertiary,
 * and only Skyway/Clark reach secondary. Cutting tertiary would key the whole
 * town off one corridor and collapse the zoning to a handful of zones.
 */
const TRUNK_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
]);

/**
 * The subset a dispatcher would actually name. TRUNK_CLASSES has to keep
 * tertiary so corridor keying works, but a route label that opens on a tertiary
 * feeder reads like a driveway direction; the label starts at the first of these
 * the path reaches and only falls back to tertiary when it reaches none.
 */
const ARTERIAL_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  "motorway",
  "trunk",
  "primary",
  "secondary",
]);

/** A label longer than this stops being something anyone says out loud. */
const MAX_ROUTE_LABEL_SEGMENTS = 3;

/** Above this, a zone is too coarse to stage as one wave. */
const MAX_ZONE_HOUSEHOLDS = 1400;
const MIN_ZONES = 15;
const MAX_ZONES = 25;

/**
 * OFFICIAL PATH ONLY. A block group is listed in a zone's blockGroupIds once it
 * contributes at least this share of its own area. Below it the zone still gets
 * the households — apportionment never discards a fraction — but naming a block
 * group that a zone clips by 0.2% would make the provenance list unreadable.
 */
const MIN_BLOCK_GROUP_SHARE = 0.01;

/**
 * OFFICIAL PATH ONLY. Overlap below this fraction of a block group's area is
 * boundary noise between two polygon sets digitised from different sources, not
 * shared territory, so it is dropped into the outside bucket rather than seeding
 * a phantom contributor.
 */
const SHARE_EPSILON = 1e-6;

/** ~1.1 m at these latitudes. Coarse enough to survive float noise in shared
 *  census boundaries, fine enough not to weld distinct vertices together. */
const SNAP_DECIMALS = 5;

const ZONE_PREFIX: Record<string, string> = {
  "camp-fire-2018": "PAR",
  "conyers-plume-2024": "CON",
  "marshall-fire-2021": "BLD",
  // Derived, so deliberately NOT the county's own LOS-Q**** naming: Los Angeles
  // publishes one zone for the whole community, and a derived sub-zone must not
  // borrow an id the county would read as theirs.
  "palisades-fire-2025": "PAC",
};

const COMPASS = [
  "North",
  "Northeast",
  "East",
  "Southeast",
  "South",
  "Southwest",
  "West",
  "Northwest",
] as const;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────────────────────────────────────────────────────────
// Small geometry / math helpers
// ─────────────────────────────────────────────────────────────────────────────

type Ring = LngLat[];

function log(msg: string): void {
  console.log(`[zones] ${msg}`);
}

function loud(msg: string): void {
  console.warn(`\n**** SYNTHETIC DATA **** ${msg}\n`);
}

/** Distinct from loud(): nothing was invented here, something was left out. */
function loudDrop(msg: string): void {
  console.warn(`\n**** UNCOVERED POPULATION **** ${msg}\n`);
}

/** Distinct again: uncovered population is a category, unbalanced books are a bug. */
function loudBalance(msg: string): void {
  console.warn(`\n**** CONSERVATION FAILURE **** ${msg}\n`);
}

function metersBetween(a: LngLat, b: LngLat): number {
  const latRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * 111320 * Math.cos(latRad);
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

/** Drops a repeated closing vertex so segment emission never yields a zero-length edge. */
function openRing(ring: Ring): Ring {
  if (ring.length < 2) return ring.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring.slice();
}

/** Degrees-squared. Only ever compared against other areas in the same locality. */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function ensureCCW(ring: Ring): Ring {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

function ringCentroid(rings: Ring[]): LngLat {
  let cx = 0;
  let cy = 0;
  let area = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const cross = a[0] * b[1] - b[0] * a[1];
      area += cross;
      cx += (a[0] + b[0]) * cross;
      cy += (a[1] + b[1]) * cross;
    }
  }
  area /= 2;
  if (Math.abs(area) < 1e-14) {
    // Degenerate sliver: fall back to the vertex mean.
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const ring of rings) {
      for (const p of ring) {
        sx += p[0];
        sy += p[1];
        n++;
      }
    }
    return n > 0 ? [sx / n, sy / n] : [0, 0];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function bboxOf(rings: Ring[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return [minX, minY, maxX, maxY];
}

function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/** Even-odd ray cast across every ring, so holes subtract correctly. */
function pointInRings(pt: LngLat, rings: Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][1];
      const yj = ring[j][1];
      if (yi > pt[1] !== yj > pt[1]) {
        const x = ((ring[j][0] - ring[i][0]) * (pt[1] - yi)) / (yj - yi) + ring[i][0];
        if (pt[0] < x) inside = !inside;
      }
    }
  }
  return inside;
}

function orient(a: LngLat, b: LngLat, c: LngLat): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: LngLat, b: LngLat, p: LngLat): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * Full polygon overlap test: crossing edges OR either polygon fully containing
 * the other. A fire ring can swallow a whole zone without crossing one of its
 * edges, and that case is exactly the one that matters.
 */
function ringsIntersect(a: Ring[], b: Ring[]): boolean {
  const ba = bboxOf(a);
  const bb = bboxOf(b);
  if (!bboxOverlap(ba, bb)) return false;

  for (const ra of a) {
    for (let i = 0; i < ra.length; i++) {
      const a1 = ra[i];
      const a2 = ra[(i + 1) % ra.length];
      for (const rb of b) {
        for (let j = 0; j < rb.length; j++) {
          if (segmentsIntersect(a1, a2, rb[j], rb[(j + 1) % rb.length])) return true;
        }
      }
    }
  }
  if (a.length > 0 && a[0].length > 0 && pointInRings(a[0][0], b)) return true;
  if (b.length > 0 && b[0].length > 0 && pointInRings(b[0][0], a)) return true;
  return false;
}

function convexHull(points: LngLat[]): Ring {
  if (points.length < 3) return points.slice();
  const pts = points
    .slice()
    .sort((p, q) => (p[0] === q[0] ? p[1] - q[1] : p[0] - q[0]))
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
  if (pts.length < 3) return pts;

  const build = (src: LngLat[]): LngLat[] => {
    const out: LngLat[] = [];
    for (const p of src) {
      while (out.length >= 2 && orient(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  const lower = build(pts);
  const upper = build(pts.slice().reverse());
  return ensureCCW(lower.concat(upper));
}

function compassSector(from: LngLat, to: LngLat): string {
  const latRad = (from[1] * Math.PI) / 180;
  const dx = (to[0] - from[0]) * Math.cos(latRad);
  const dy = to[1] - from[1];
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return "Central";
  const bearing = (((90 - (Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
}

function fmtTick(t: Tick): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Areal apportionment — exact polygon overlap in a local metric frame
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A degree of longitude is ~0.79 of a degree of latitude at this parallel, so a
 * lng/lat "area" is a sheared one. Share is a ratio and would survive the shear,
 * but the leftover area is reported in km² and the sliver thresholds below are
 * in m², so project once and let every number downstream be a real area.
 */
function projector(origin: LngLat): (p: LngLat) => LngLat {
  const kx = 111320 * Math.cos((origin[1] * Math.PI) / 180);
  return (p) => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * 110540];
}

/** A projected ring plus the sign its winding earns it: +1 outer, -1 hole. */
interface SignedRing {
  ring: Ring;
  sign: number;
  bbox: [number, number, number, number];
}

/**
 * Winding decides the sign rather than ring order, because a hole digitised CCW
 * would otherwise be added to the polygon it is supposed to subtract from.
 */
function signedRings(rings: Ring[], project: (p: LngLat) => LngLat): SignedRing[] {
  const out: SignedRing[] = [];
  for (const r of rings) {
    const ring = openRing(r).map(project);
    if (ring.length < 3) continue;
    const a = signedArea(ring);
    if (Math.abs(a) < 1) continue; // under a square metre: digitising noise
    out.push({ ring, sign: a > 0 ? 1 : -1, bbox: bboxOf([ring]) });
  }
  return out;
}

/** Net m²: holes subtract, so this is the polygon's true measure. */
function ringsArea(rs: SignedRing[]): number {
  return rs.reduce((a, r) => a + r.sign * Math.abs(signedArea(r.ring)), 0);
}

interface FanTri {
  tri: Ring;
  sign: number;
  bbox: [number, number, number, number];
}

/**
 * Fan decomposition from vertex 0. For ANY simple ring the signed triangles
 * (v0, vi, vi+1) sum to that ring's indicator function — the shoelace identity
 * one dimension up — so the negative slices cancel the parts of the fan that
 * stick out of a concave polygon. That buys exact clipping against the county's
 * long, hooked zones without ear clipping and without assuming convexity.
 */
function fanTriangles(rs: SignedRing[]): FanTri[] {
  const out: FanTri[] = [];
  for (const r of rs) {
    const v0 = r.ring[0];
    for (let i = 1; i + 1 < r.ring.length; i++) {
      const t: Ring = [v0, r.ring[i], r.ring[i + 1]];
      const a = signedArea(t);
      if (Math.abs(a) < 1e-6) continue; // collinear: contributes nothing either way
      out.push({ tri: ensureCCW(t), sign: r.sign * (a > 0 ? 1 : -1), bbox: bboxOf([t]) });
    }
  }
  return out;
}

function cutAt(p: LngLat, q: LngLat, ps: number, qs: number): LngLat {
  const t = ps / (ps - qs);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/**
 * Sutherland-Hodgman against a CONVEX clip. A concave subject comes back with
 * degenerate bridge edges, but they lie exactly on the clip boundary and are
 * traversed both ways, so they contribute nothing to the shoelace sum and the
 * area is exact even though the ring itself is not clean.
 */
function convexClipArea(subject: Ring, clip: Ring): number {
  let poly: Ring = subject;
  for (let c = 0; c < clip.length && poly.length >= 3; c++) {
    const a = clip[c];
    const b = clip[(c + 1) % clip.length];
    const input = poly;
    const next: Ring = [];
    let prev = input[input.length - 1];
    let prevSide = orient(a, b, prev);
    for (const cur of input) {
      const curSide = orient(a, b, cur);
      if (curSide >= 0) {
        if (prevSide < 0) next.push(cutAt(prev, cur, prevSide, curSide));
        next.push(cur);
      } else if (prevSide >= 0) {
        next.push(cutAt(prev, cur, prevSide, curSide));
      }
      prev = cur;
      prevSide = curSide;
    }
    poly = next;
  }
  return poly.length < 3 ? 0 : Math.abs(signedArea(poly));
}

/** Overlap in m², holes on both sides respected. */
function overlapArea(subject: SignedRing[], clipTris: FanTri[]): number {
  let sum = 0;
  for (const s of subject) {
    for (const t of clipTris) {
      if (!bboxOverlap(s.bbox, t.bbox)) continue;
      const a = convexClipArea(s.ring, t.tri);
      if (a !== 0) sum += s.sign * t.sign * a;
    }
  }
  return sum;
}

/**
 * Apportioned counts are fractional. Rounding each one where it is produced
 * loses or invents whole households across 46 zones, so the column is floored
 * and the remainder handed to the largest fractional parts until it sums to
 * `target` exactly.
 */
function largestRemainder(values: number[], target: number): number[] {
  const out = values.map((v) => Math.floor(v));
  let drift = target - out.reduce((a, b) => a + b, 0);
  const byFrac = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  if (byFrac.length === 0) return out;
  for (let k = 0; drift > 0; k++) {
    out[byFrac[k % byFrac.length].i]++;
    drift--;
  }
  // Only reachable if target was forced below the floor sum; take from the
  // smallest fractions first so the largest shares keep their rounding up.
  for (let k = byFrac.length - 1; drift < 0 && k >= 0; k--) {
    const i = byFrac[k].i;
    if (out[i] > 0) {
      out[i]--;
      drift++;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polygon dissolve — cancel shared boundaries, stitch the survivors into rings
// ─────────────────────────────────────────────────────────────────────────────

function qkey(p: LngLat): string {
  return `${p[0].toFixed(SNAP_DECIMALS)},${p[1].toFixed(SNAP_DECIMALS)}`;
}

interface Seg {
  a: LngLat;
  b: LngLat;
  ka: string;
  kb: string;
  used: boolean;
}

function dissolve(cellRings: Ring[][]): { rings: Ring[]; fallback: boolean } {
  const allPoints: LngLat[] = [];
  let cellsNet = 0;

  const pending = new Map<string, Seg>();
  for (const rings of cellRings) {
    for (let r = 0; r < rings.length; r++) {
      const ring = openRing(rings[r]);
      if (ring.length < 3) continue;
      // Outer rings CCW, holes CW: with consistent winding a boundary shared by
      // two neighbours is traversed in opposite directions and cancels.
      const oriented = r === 0 ? ensureCCW(ring) : ring;
      cellsNet += signedArea(oriented);
      for (const p of oriented) allPoints.push(p);

      for (let i = 0; i < oriented.length; i++) {
        const a = oriented[i];
        const b = oriented[(i + 1) % oriented.length];
        const ka = qkey(a);
        const kb = qkey(b);
        if (ka === kb) continue;
        const twin = pending.get(`${kb}|${ka}`);
        if (twin) {
          pending.delete(`${kb}|${ka}`);
        } else {
          pending.set(`${ka}|${kb}`, { a, b, ka, kb, used: false });
        }
      }
    }
  }

  const hull = (): { rings: Ring[]; fallback: boolean } => ({
    rings: [convexHull(allPoints)],
    fallback: true,
  });

  if (pending.size === 0) return hull();

  const outgoing = new Map<string, Seg[]>();
  for (const seg of pending.values()) {
    const list = outgoing.get(seg.ka);
    if (list) list.push(seg);
    else outgoing.set(seg.ka, [seg]);
  }

  const rings: Ring[] = [];
  const budget = pending.size + 8;
  for (const start of pending.values()) {
    if (start.used) continue;
    const ring: Ring = [start.a];
    let cur = start;
    cur.used = true;
    let steps = 0;
    let closed = false;

    while (steps++ < budget) {
      ring.push(cur.b);
      if (cur.kb === start.ka) {
        closed = true;
        break;
      }
      const cands = (outgoing.get(cur.kb) ?? []).filter((s) => !s.used);
      if (cands.length === 0) break;
      // At a pinch vertex take the sharpest right turn: that keeps the interior
      // on the left and stops the walk from cutting across the union.
      let best = cands[0];
      if (cands.length > 1) {
        const inx = cur.b[0] - cur.a[0];
        const iny = cur.b[1] - cur.a[1];
        let bestTurn = Infinity;
        for (const c of cands) {
          const ox = c.b[0] - c.a[0];
          const oy = c.b[1] - c.a[1];
          const turn = Math.atan2(inx * oy - iny * ox, inx * ox + iny * oy);
          if (turn < bestTurn) {
            bestTurn = turn;
            best = c;
          }
        }
      }
      best.used = true;
      cur = best;
    }

    if (closed && ring.length >= 4) {
      ring.pop(); // drop the duplicated closing vertex
      if (Math.abs(signedArea(ring)) > 1e-12) rings.push(ring);
    }
  }

  if (rings.length === 0) return hull();

  // TIGER boundaries meet at T-junctions, so cancellation leaves hairline
  // slivers behind. They are noise at map scale and they wreck fill rendering,
  // so drop anything under 0.1% of the zone's own area.
  const totalAbs = rings.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  const solid = rings.filter((r) => Math.abs(signedArea(r)) >= totalAbs * 0.001);
  const out = solid.length > 0 ? solid : rings;

  const net = out.reduce((s, r) => s + signedArea(r), 0);
  // A neighbour with extra vertices along a shared boundary breaks cancellation
  // outright. Area sanity is the catch; the hull is conservative and only ever
  // over-covers, which errs toward an earlier hazard ETA.
  if (cellsNet > 0 && (net <= 0 || net / cellsNet > 2 || net / cellsNet < 0.5)) return hull();

  out.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  return { rings: out, fallback: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph: reversed multi-source Dijkstra to the nearest sink
// ─────────────────────────────────────────────────────────────────────────────

class MinHeap {
  private idx: number[] = [];
  private key: number[] = [];

  get size(): number {
    return this.idx.length;
  }

  push(i: number, k: number): void {
    this.idx.push(i);
    this.key.push(k);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      this.swap(p, c);
      c = p;
    }
  }

  pop(): { i: number; k: number } {
    const i = this.idx[0];
    const k = this.key[0];
    const li = this.idx.pop() as number;
    const lk = this.key.pop() as number;
    if (this.idx.length > 0) {
      this.idx[0] = li;
      this.key[0] = lk;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let s = p;
        if (l < this.key.length && this.key[l] < this.key[s]) s = l;
        if (r < this.key.length && this.key[r] < this.key[s]) s = r;
        if (s === p) break;
        this.swap(s, p);
        p = s;
      }
    }
    return { i, k };
  }

  private swap(a: number, b: number): void {
    const ti = this.idx[a];
    this.idx[a] = this.idx[b];
    this.idx[b] = ti;
    const tk = this.key[a];
    this.key[a] = this.key[b];
    this.key[b] = tk;
  }
}

interface Graph {
  nodeIds: string[];
  nodePos: LngLat[];
  /** Seconds to the nearest sink following forward arcs. Infinity if stranded. */
  dist: Float64Array;
  /** Forward edge to take from node i. -1 at sinks and stranded nodes. */
  succEdge: Int32Array;
  succNode: Int32Array;
  edges: RoadEdge[];
}

function travelSeconds(e: RoadEdge): number {
  const speed = e.speed > 0 ? e.speed : DEFAULT_SPEED[e.roadClass];
  const len = Math.max(e.length, 1);
  return len / ((speed * 1000) / 3600);
}

function buildGraph(net: RoadNetwork): Graph {
  const index = new Map<string, number>();
  const nodeIds: string[] = [];
  const nodePos: LngLat[] = [];
  for (const n of net.nodes) {
    if (index.has(n.id)) continue;
    index.set(n.id, nodeIds.length);
    nodeIds.push(n.id);
    nodePos.push(n.position);
  }

  // rev[b] holds forward arcs a -> b, so relaxing outward from sinks walks
  // backwards through the network while the recorded successor points forwards.
  const revHead: number[][] = Array.from({ length: nodeIds.length }, () => []);
  const revFrom: number[] = [];
  const revEdge: number[] = [];
  const revCost: number[] = [];

  let dropped = 0;
  for (let ei = 0; ei < net.edges.length; ei++) {
    const e = net.edges[ei];
    const u = index.get(e.from);
    const v = index.get(e.to);
    if (u === undefined || v === undefined) {
      dropped++;
      continue;
    }
    const cost = travelSeconds(e);
    revHead[v].push(revFrom.length);
    revFrom.push(u);
    revEdge.push(ei);
    revCost.push(cost);
    if (!e.oneway) {
      revHead[u].push(revFrom.length);
      revFrom.push(v);
      revEdge.push(ei);
      revCost.push(cost);
    }
  }
  if (dropped > 0) log(`warn: dropped ${dropped} edges with unknown endpoints`);

  const n = nodeIds.length;
  const dist = new Float64Array(n).fill(Infinity);
  const succEdge = new Int32Array(n).fill(-1);
  const succNode = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);

  const heap = new MinHeap();
  const sinkIds =
    net.sinks.length > 0 ? net.sinks : net.nodes.filter((x) => x.isSink).map((x) => x.id);
  for (const sid of sinkIds) {
    const si = index.get(sid);
    if (si === undefined) continue;
    dist[si] = 0;
    heap.push(si, 0);
  }

  while (heap.size > 0) {
    const { i, k } = heap.pop();
    if (done[i] || k > dist[i]) continue;
    done[i] = 1;
    for (const slot of revHead[i]) {
      const a = revFrom[slot];
      const nd = dist[i] + revCost[slot];
      if (nd < dist[a]) {
        dist[a] = nd;
        succEdge[a] = revEdge[slot];
        succNode[a] = i;
        heap.push(a, nd);
      }
    }
  }

  return { nodeIds, nodePos, dist, succEdge, succNode, edges: net.edges };
}

/** Coarse hash grid; ~1.1 km cells at these latitudes. */
class NodeGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly step = 0.01;

  constructor(pos: LngLat[]) {
    for (let i = 0; i < pos.length; i++) {
      const k = this.key(pos[i][0], pos[i][1]);
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private key(lng: number, lat: number): string {
    return `${Math.floor(lng / this.step)}:${Math.floor(lat / this.step)}`;
  }

  candidates(pt: LngLat, minWanted = 24, maxRing = 12): number[] {
    const cx = Math.floor(pt[0] / this.step);
    const cy = Math.floor(pt[1] / this.step);
    const out: number[] = [];
    for (let r = 0; r <= maxRing; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.cells.get(`${cx + dx}:${cy + dy}`);
          if (list) out.push(...list);
        }
      }
      if (out.length >= minWanted && r >= 1) break;
    }
    return out;
  }
}

/**
 * Nearest node that can actually reach a sink — OSM extracts always contain
 * orphaned service-road fragments, and snapping onto one silently voids a cell.
 * Nodes that ARE sinks are deprioritised: their path is empty, which tells the
 * UI nothing about which corridor the cell feeds.
 */
function snapRoutable(g: Graph, grid: NodeGrid, pt: LngLat): { node: number; reachable: boolean } {
  const cands = grid.candidates(pt);
  cands.sort((a, b) => metersBetween(pt, g.nodePos[a]) - metersBetween(pt, g.nodePos[b]));
  for (const c of cands) {
    if (Number.isFinite(g.dist[c]) && g.succEdge[c] >= 0) return { node: c, reachable: true };
  }
  for (const c of cands) {
    if (Number.isFinite(g.dist[c])) return { node: c, reachable: true };
  }
  // The hash grid gave up: a block group can sit in a genuine hole in the OSM
  // extract. Networks here are ~5k nodes, so a linear scan is free insurance.
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < g.nodePos.length; i++) {
    if (!Number.isFinite(g.dist[i]) || g.succEdge[i] < 0) continue;
    const d = metersBetween(pt, g.nodePos[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) return { node: best, reachable: true };
  return { node: cands.length > 0 ? cands[0] : -1, reachable: false };
}

function walkPath(g: Graph, from: number): { edgeIds: string[]; edgeIdx: number[]; sink: number } {
  const edgeIds: string[] = [];
  const edgeIdx: number[] = [];
  let cur = from;
  let guard = 0;
  while (cur >= 0 && g.succEdge[cur] >= 0 && guard++ < 20000) {
    const ei = g.succEdge[cur];
    edgeIdx.push(ei);
    edgeIds.push(g.edges[ei].id);
    cur = g.succNode[cur];
  }
  return { edgeIds, edgeIdx, sink: cur };
}

// ─────────────────────────────────────────────────────────────────────────────
// Road names
// ─────────────────────────────────────────────────────────────────────────────

const SUFFIX_ALIAS: Record<string, string> = {
  rd: "road",
  st: "street",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  dr: "drive",
  ln: "lane",
  hwy: "highway",
  pkwy: "parkway",
  ct: "court",
  cir: "circle",
  ter: "terrace",
  pl: "place",
  wy: "way",
};

const DROPPABLE_SUFFIX = new Set(Object.values(SUFFIX_ALIAS));

/** "Neal Rd", "Neal Road" and "neal  rd." must key to the same corridor. */
function normalizeRoadName(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => SUFFIX_ALIAS[t] ?? t);
  if (tokens.length === 0) return "";
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && DROPPABLE_SUFFIX.has(last)) tokens.pop();
  return tokens.join(" ");
}

/**
 * Names the arterials the zone actually leaves on. A path starts on somebody's
 * cul-de-sac; listing that tells an incident commander nothing, so trunk-class
 * names come first and local streets are only a fallback.
 */
function routeNames(edges: RoadEdge[], idxs: number[], trunkOnly: boolean): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const i of idxs) {
    const e = edges[i];
    if (trunkOnly && !TRUNK_CLASSES.has(e.roadClass)) continue;
    const n = e.name?.trim();
    if (!n) continue;
    const key = normalizeRoadName(n);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(n);
    if (names.length >= 4) break;
  }
  return names;
}

/**
 * "Middle Libby Road -> Pearson Road -> Clark Road" is where the car starts, not
 * where the evacuation goes. Cut the path at the first named arterial edge and
 * read forward from there, so the label lands on "Pearson Road -> Skyway".
 *
 * The cut is by EDGE index, not by name: Pearson Rd is tagged tertiary for its
 * upper half and secondary for its lower, and de-duplicating names before
 * classifying would file the whole road as tertiary and drop it.
 */
function routeLabel(edges: RoadEdge[], idxs: number[]): string {
  const firstArterial = idxs.findIndex(
    (i) => ARTERIAL_CLASSES.has(edges[i].roadClass) && Boolean(edges[i].name?.trim()),
  );
  const fromArterial = firstArterial >= 0 ? idxs.slice(firstArterial) : idxs;
  const names = routeNames(edges, fromArterial, true).slice(0, MAX_ROUTE_LABEL_SEGMENTS);
  const use =
    names.length > 0 ? names : routeNames(edges, idxs, false).slice(0, MAX_ROUTE_LABEL_SEGMENTS);
  if (use.length === 0) {
    const cls = idxs.find((i) => TRUNK_CLASSES.has(edges[i].roadClass));
    return cls === undefined
      ? "Unnamed local roads -> network exit"
      : `Unnamed ${edges[cls].roadClass} -> network exit`;
  }
  return use.join(" -> ");
}

/** Head of the route, for the zone's human label. */
function routeHead(edges: RoadEdge[], idxs: number[]): string {
  const names = routeNames(edges, idxs, true);
  if (names.length > 0) return names[0];
  const any = routeNames(edges, idxs, false);
  return any.length > 0 ? any[0] : "Local roads";
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading, with per-input synthetic fallback
// ─────────────────────────────────────────────────────────────────────────────

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    console.warn(
      `[zones] warn: ${path} is unparseable (${(err as Error).message}) — treating as missing`,
    );
    return null;
  }
}

/**
 * Synthetic network: a lattice of residential streets over the scenario bbox
 * with four named arterials running to five sinks on the bbox rim. Geometry is
 * invented; class/lane/capacity/speed follow the real constants so downstream
 * capacity maths stays honest.
 */
function synthNetwork(s: ScenarioMeta): RoadNetwork {
  const [w, sLat, e, nLat] = s.bbox;
  const COLS = 15;
  const ROWS = 15;
  const nodes: RoadNetwork["nodes"] = [];
  const edges: RoadEdge[] = [];
  const id = (c: number, r: number) => `sx-${c}-${r}`;
  const lng = (c: number) => w + ((e - w) * (c + 0.5)) / COLS;
  const lat = (r: number) => sLat + ((nLat - sLat) * (r + 0.5)) / ROWS;

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) nodes.push({ id: id(c, r), position: [lng(c), lat(r)] });
  }

  const arterials: Record<number, { name: string; cls: RoadClass; lanes: number }> = {
    3: { name: "Corridor A", cls: "secondary", lanes: 1 },
    7: { name: "Corridor B", cls: "primary", lanes: 2 },
    11: { name: "Corridor C", cls: "secondary", lanes: 1 },
  };
  const crossRow = 1;
  const crossName = "Cross Route";

  const push = (
    from: string,
    to: string,
    cls: RoadClass,
    lanes: number,
    a: LngLat,
    b: LngLat,
    name?: string,
  ) => {
    const length = metersBetween(a, b);
    const speed = DEFAULT_SPEED[cls];
    edges.push({
      id: `sx-e${edges.length}`,
      from,
      to,
      roadClass: cls,
      lanes,
      oneway: false,
      length,
      speed,
      capacity: lanes * LANE_CAPACITY[cls],
      contraflowEligible: cls === "primary" || cls === "secondary",
      geometry: [a, b],
      name,
    });
  };

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const art = arterials[c];
      if (r + 1 < ROWS) {
        const cls: RoadClass = art ? art.cls : "residential";
        push(
          id(c, r),
          id(c, r + 1),
          cls,
          art ? art.lanes : 1,
          [lng(c), lat(r)],
          [lng(c), lat(r + 1)],
          art?.name,
        );
      }
      if (c + 1 < COLS) {
        const cross = r === crossRow;
        const cls: RoadClass = cross ? "secondary" : "residential";
        push(
          id(c, r),
          id(c + 1, r),
          cls,
          cross ? 1 : 1,
          [lng(c), lat(r)],
          [lng(c + 1), lat(r)],
          cross ? crossName : undefined,
        );
      }
    }
  }

  // Sinks: bottom of each arterial plus the two ends of the cross route.
  const sinkNodes = [id(3, 0), id(7, 0), id(11, 0), id(0, crossRow), id(COLS - 1, crossRow)];
  for (const n of nodes) if (sinkNodes.includes(n.id)) n.isSink = true;

  return {
    scenarioId: s.id,
    nodes,
    edges,
    sinks: sinkNodes,
    generatedAt: new Date().toISOString(),
    source: "SYNTHETIC lattice (build-zones fallback)",
  };
}

/**
 * Synthetic population: a 9x7 lattice of square pseudo-block-groups sharing
 * exact vertices, with a Gaussian density bump on the scenario centre. Totals
 * are pinned to the scenario's published order of magnitude.
 */
function synthPopulation(s: ScenarioMeta): PopulationLayer {
  const [w, sLat, e, nLat] = s.bbox;
  const COLS = 9;
  const ROWS = 7;
  const xs = Array.from({ length: COLS + 1 }, (_, i) => w + ((e - w) * i) / COLS);
  const ys = Array.from({ length: ROWS + 1 }, (_, i) => sLat + ((nLat - sLat) * i) / ROWS);

  const targetPop = s.id === "camp-fire-2018" ? 26000 : 30000;
  const raw: { cx: number; cy: number; wgt: number; ring: Ring; key: string }[] = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const cx = (xs[c] + xs[c + 1]) / 2;
      const cy = (ys[r] + ys[r + 1]) / 2;
      const dx = (cx - s.center[0]) / (e - w);
      const dy = (cy - s.center[1]) / (nLat - sLat);
      const wgt = Math.exp(-6 * (dx * dx + dy * dy)) + 0.06;
      raw.push({
        cx,
        cy,
        wgt,
        key: `${c}-${r}`,
        ring: [
          [xs[c], ys[r]],
          [xs[c + 1], ys[r]],
          [xs[c + 1], ys[r + 1]],
          [xs[c], ys[r + 1]],
        ],
      });
    }
  }
  const totalW = raw.reduce((a, b) => a + b.wgt, 0);

  const cells: PopulationCell[] = raw.map((cell, i) => {
    const population = Math.max(40, Math.round((targetPop * cell.wgt) / totalW));
    const households = Math.round(population / 2.45);
    return {
      id: `06007${String(900000 + i).padStart(7, "0")}`,
      centroid: [cell.cx, cell.cy] as LngLat,
      geometry: [cell.ring],
      population,
      households,
      noVehicleHouseholds: Math.round(households * 0.066),
      vehiclesAvailable: Math.round(households * 1.85),
      age65Plus: Math.round(population * 0.25),
      withDisability: Math.round(population * 0.17),
      limitedEnglishHouseholds: Math.round(households * 0.03),
      languages: ["en", "es"],
      mobileHomes: Math.round(households * 0.14),
    };
  });

  return {
    scenarioId: s.id,
    cells,
    totals: {
      population: cells.reduce((a, c) => a + c.population, 0),
      households: cells.reduce((a, c) => a + c.households, 0),
      noVehicleHouseholds: cells.reduce((a, c) => a + c.noVehicleHouseholds, 0),
      vehicles: cells.reduce((a, c) => a + c.vehiclesAvailable, 0),
    },
    source: "SYNTHETIC lattice (build-zones fallback)",
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Synthetic hazard: a single circular front seeded off the NE corner of the
 * bbox, advancing SW at a constant rate and growing linearly, sampled at the
 * scenario frameStep. No perimeter observations involved.
 */
function synthHazard(s: ScenarioMeta): HazardTrack {
  const [w, sLat, e, nLat] = s.bbox;
  const originLng = e + (e - w) * 0.08;
  const originLat = nLat + (nLat - sLat) * 0.05;
  const endLng = w + (e - w) * 0.25;
  const endLat = sLat + (nLat - sLat) * 0.35;

  const frames: HazardFrame[] = [];
  for (let t = 0; t <= s.duration; t += s.frameStep) {
    const f = t / s.duration;
    const cx = originLng + (endLng - originLng) * f;
    const cy = originLat + (endLat - originLat) * f;
    const rad = ((e - w) * (0.04 + 0.32 * f)) / 2;
    const ring: Ring = [];
    for (let k = 0; k < 36; k++) {
      const th = (k / 36) * Math.PI * 2;
      ring.push([cx + rad * 1.25 * Math.cos(th), cy + rad * Math.sin(th)]);
    }
    frames.push({ t, rings: [ring], closedEdgeIds: [], provenance: "interpolated" });
  }

  return {
    scenarioId: s.id,
    kind: s.hazardKind,
    frames,
    wind: frames.map((f) => ({ t: f.t, speed: 15, direction: 45 })),
    source: "SYNTHETIC advancing circle (build-zones fallback)",
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustering
// ─────────────────────────────────────────────────────────────────────────────

interface CellRoute {
  cell: PopulationCell;
  node: number;
  reachable: boolean;
  edgeIds: string[];
  edgeIdx: number[];
  corridorKey: string;
  corridorName: string;
  timeToSink: number;
}

interface Cluster {
  cells: number[];
  corridorKey: string;
  corridorName: string;
}

function householdsOf(cluster: Cluster, routes: CellRoute[]): number {
  return cluster.cells.reduce((a, i) => a + routes[i].cell.households, 0);
}

/** Shared quantized vertices give true contiguity; sparse cells get a nearest-
 *  centroid fallback so an isolated block group still joins something. */
function buildAdjacency(cells: PopulationCell[]): Set<number>[] {
  const adj: Set<number>[] = cells.map(() => new Set<number>());
  const byVertex = new Map<string, Set<number>>();
  for (let i = 0; i < cells.length; i++) {
    for (const ring of cells[i].geometry) {
      for (const p of ring) {
        const k = qkey(p);
        const set = byVertex.get(k);
        if (set) set.add(i);
        else byVertex.set(k, new Set([i]));
      }
    }
  }
  for (const set of byVertex.values()) {
    if (set.size < 2) continue;
    const arr = [...set];
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        adj[arr[a]].add(arr[b]);
        adj[arr[b]].add(arr[a]);
      }
    }
  }
  for (let i = 0; i < cells.length; i++) {
    // Only rescue genuinely isolated cells. Linking cells that already have a
    // neighbour invents contiguity and produces multi-part zones.
    if (adj[i].size >= 1) continue;
    const near = cells
      .map((c, j) => ({ j, d: metersBetween(cells[i].centroid, c.centroid) }))
      .filter((x) => x.j !== i && x.d < 4000)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const n of near) {
      adj[i].add(n.j);
      adj[n.j].add(i);
    }
  }
  return adj;
}

function components(members: number[], adj: Set<number>[]): number[][] {
  const inSet = new Set(members);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const start of members) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp: number[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      comp.push(cur);
      for (const nb of adj[cur]) {
        if (inSet.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/** Split along the corridor: farthest-from-sink first, so the pieces map onto
 *  the order a staged release would actually call them. */
function splitCluster(cluster: Cluster, routes: CellRoute[], parts: number): Cluster[] {
  if (parts <= 1 || cluster.cells.length <= 1) return [cluster];
  const ordered = cluster.cells.slice().sort((a, b) => routes[b].timeToSink - routes[a].timeToSink);
  const total = ordered.reduce((a, i) => a + routes[i].cell.households, 0);
  const target = total / parts;

  const out: Cluster[] = [];
  let bucket: number[] = [];
  let acc = 0;
  for (let k = 0; k < ordered.length; k++) {
    bucket.push(ordered[k]);
    acc += routes[ordered[k]].cell.households;
    const remainingCells = ordered.length - k - 1;
    const remainingBuckets = parts - out.length - 1;
    const forced = remainingCells === remainingBuckets; // or the tail runs out of cells
    if (remainingBuckets > 0 && (forced || (acc >= target && remainingCells >= remainingBuckets))) {
      out.push({ ...cluster, cells: bucket });
      bucket = [];
      acc = 0;
    }
  }
  if (bucket.length > 0) out.push({ ...cluster, cells: bucket });
  return out.length > 0 ? out : [cluster];
}

function rebalance(clusters: Cluster[], routes: CellRoute[], adj: Set<number>[]): Cluster[] {
  let work = clusters.slice();

  // Too many: fold the smallest into an adjacent neighbour, same corridor first.
  let guard = 0;
  while (work.length > MAX_ZONES && guard++ < 500) {
    work.sort((a, b) => householdsOf(a, routes) - householdsOf(b, routes));
    const victim = work[0];
    const victimCells = new Set(victim.cells);
    let best = -1;
    let bestScore = Infinity;
    for (let i = 1; i < work.length; i++) {
      const cand = work[i];
      let touches = false;
      for (const c of cand.cells) {
        for (const nb of adj[c]) {
          if (victimCells.has(nb)) {
            touches = true;
            break;
          }
        }
        if (touches) break;
      }
      const hh = householdsOf(cand, routes);
      const score =
        (touches ? 0 : 1_000_000) + (cand.corridorKey === victim.corridorKey ? 0 : 100_000) + hh;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    work[best] = { ...work[best], cells: work[best].cells.concat(victim.cells) };
    work.splice(0, 1);
  }

  // Too few: halve the fattest cluster that still has cells to give.
  guard = 0;
  while (work.length < MIN_ZONES && guard++ < 500) {
    work.sort((a, b) => householdsOf(b, routes) - householdsOf(a, routes));
    const target = work.find((c) => c.cells.length >= 2);
    if (!target) break;
    const pieces = splitCluster(target, routes, 2);
    if (pieces.length < 2) break;
    work = work.filter((c) => c !== target).concat(pieces);
  }

  return work;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone drafts — the shape both paths converge on before ids and labels
// ─────────────────────────────────────────────────────────────────────────────

interface Draft {
  /** The county's own id on the official path; null when we number it ourselves. */
  id: string | null;
  geometry: Ring[];
  centroid: LngLat;
  /** Prepended to the label. Community name on the official path. */
  labelPrefix: string;
  households: number;
  population: number;
  noVehicleHouseholds: number;
  vehicles: number;
  mobileHomes: number;
  blockGroupIds: string[];
  primaryRouteEdgeIds: string[];
  primaryRouteLabel: string;
  routeHead: string;
  hazardEta: Tick;
  officialStructures?: number;
}

/** First hazard frame whose footprint touches these rings. */
function hazardEtaOf(rings: Ring[], frames: HazardFrame[], fallback: Tick): Tick {
  for (const f of frames) {
    if (f.rings.length === 0) continue;
    if (ringsIntersect(rings, f.rings)) return f.t;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Official zones — the county's own published polygons, ids kept verbatim
// ─────────────────────────────────────────────────────────────────────────────

interface OfficialZone {
  id: string;
  community: string;
  subZone: string;
  rings: Ring[];
  centroid: LngLat;
  officialStructures?: number;
}

interface OfficialFeature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

interface OfficialFile {
  features?: OfficialFeature[];
  egress?: { source?: string; provenance?: string; idField?: string };
}

/**
 * GeoJSON rings repeat their first vertex and this project's do not, and
 * pointInRings / ringCentroid / dissolve are all calibrated on outer-CCW
 * winding. Normalise on the way in rather than special-casing every consumer.
 */
function geojsonRings(geom: { type: string; coordinates: unknown }): Ring[] {
  const polys: number[][][][] =
    geom.type === "Polygon"
      ? [geom.coordinates as number[][][]]
      : geom.type === "MultiPolygon"
        ? (geom.coordinates as number[][][][])
        : [];

  const out: Ring[] = [];
  for (const poly of polys) {
    for (let r = 0; r < poly.length; r++) {
      const ring = openRing(poly[r].map((p) => [p[0], p[1]] as LngLat));
      if (ring.length < 3) continue;
      // Outer ring CCW; interior rings keep their winding so holes subtract.
      out.push(r === 0 ? ensureCCW(ring) : ring);
    }
  }
  return out;
}

function readOfficialZones(path: string): { zones: OfficialZone[]; source: string } | null {
  const file = readJson<OfficialFile>(path);
  if (!file) return null;
  if (!Array.isArray(file.features) || file.features.length === 0) {
    console.warn(`[zones] warn: ${path} carries no features — using the derived path instead`);
    return null;
  }

  const idField = file.egress?.idField ?? "Zone";
  const zones: OfficialZone[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const f of file.features) {
    const p = f.properties ?? {};
    const raw = p[idField];
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || !f.geometry) {
      skipped++;
      continue;
    }
    if (seen.has(id)) {
      console.warn(`[zones] warn: duplicate official zone id ${id} — keeping the first`);
      continue;
    }
    const rings = geojsonRings(f.geometry);
    if (rings.length === 0) {
      skipped++;
      continue;
    }
    seen.add(id);
    zones.push({
      id,
      community: typeof p.Community === "string" ? p.Community.trim() : "",
      subZone: typeof p.SubZone === "string" ? p.SubZone.trim() : "",
      rings,
      centroid: ringCentroid(rings),
      officialStructures: typeof p.StructureC === "number" ? p.StructureC : undefined,
    });
  }

  if (skipped > 0) log(`warn: ${skipped} official feature(s) had no usable ${idField}/geometry`);
  if (zones.length === 0) {
    console.warn(`[zones] warn: ${path} yielded no usable zones — using the derived path instead`);
    return null;
  }
  return { zones, source: file.egress?.provenance ?? file.egress?.source ?? path };
}

/** Everything EvacZone carries as a count, and where it lives on a block group. */
const METRICS = [
  "households",
  "population",
  "noVehicleHouseholds",
  "vehicles",
  "mobileHomes",
] as const;
type Metric = (typeof METRICS)[number];

const METRIC_OF: Record<Metric, (c: PopulationCell) => number> = {
  households: (c) => c.households,
  population: (c) => c.population,
  noVehicleHouseholds: (c) => c.noVehicleHouseholds,
  vehicles: (c) => c.vehiclesAvailable,
  mobileHomes: (c) => c.mobileHomes,
};

/** The fraction of one block group's own area that landed inside one zone. */
interface ZoneShare {
  cellIdx: number;
  share: number;
}

interface OfficialResult {
  drafts: Draft[];
  /** The population layer's own household total — what everything must reconcile to. */
  inputHouseholds: number;
  /** Fractional households landing inside SOME mapped zone, before rounding. */
  insideHouseholds: number;
  /** Integer households actually written to zones.json. */
  assignedHouseholds: number;
  outsideHouseholds: number;
  outsidePopulation: number;
  outsideAreaKm2: number;
  fullyOutside: { id: string; households: number }[];
  partlyOutside: { id: string; households: number; pct: number }[];
  zeroZones: { id: string; structures: number; reason: string }[];
  offNetworkZones: number;
  overlapAnomalies: number;
}

/**
 * The official polygons ARE the zone set. Population is attached to them, never
 * the other way round — and it is attached BY AREA.
 *
 * A census block group out here is several times the size of a county
 * evacuation zone and routinely straddles four or five of them, so "the zone
 * containing the centroid" hands a whole block group to one zone and leaves its
 * neighbours reading as empty while the county lists a thousand structures in
 * them. Areal apportionment gives every zone the fraction of each block group
 * its polygon actually covers — the standard coarse-to-fine transfer, and the
 * only one that keeps the totals whole.
 *
 * Block-group area falling outside every zone is kept and reported, never
 * redistributed: rural block groups genuinely run past the edge of the county's
 * mapped system, and pushing those households inward would invent an evacuation
 * order nobody would issue.
 *
 * officialStructures still rides along. Apportioned ACS households and the
 * county's standing-structure count measure different things, and the honest
 * move is still to show both rather than reconcile them behind the operator.
 */
function officialDrafts(
  official: { zones: OfficialZone[]; source: string },
  scenario: ScenarioMeta,
  routes: CellRoute[],
  g: Graph,
  grid: NodeGrid,
  frames: HazardFrame[],
): OfficialResult {
  const project = projector(scenario.center);
  const zoneRings = official.zones.map((z) => signedRings(z.rings, project));
  const zoneBox = zoneRings.map((rs) => bboxOf(rs.map((r) => r.ring)));
  const zoneTris = zoneRings.map(fanTriangles);

  const shares: ZoneShare[][] = official.zones.map(() => []);
  const fullyOutside: { id: string; households: number }[] = [];
  const partlyOutside: { id: string; households: number; pct: number }[] = [];
  let outsideHouseholds = 0;
  let outsidePopulation = 0;
  let outsideArea = 0;
  let overlapAnomalies = 0;
  let inputHouseholds = 0;
  let overlapPairs = 0;

  for (let ci = 0; ci < routes.length; ci++) {
    const cell = routes[ci].cell;
    inputHouseholds += cell.households;

    const rs = signedRings(cell.geometry, project);
    const area = ringsArea(rs);
    if (!(area > 1)) {
      loudDrop(
        `block group ${cell.id} has a degenerate polygon (${area.toFixed(1)} m²), so no share could ` +
          `be computed. Its ${cell.households} households / ${cell.population} people are counted as ` +
          `outside the mapped zones rather than guessed into one.`,
      );
      outsideHouseholds += cell.households;
      outsidePopulation += cell.population;
      fullyOutside.push({ id: cell.id, households: cell.households });
      continue;
    }

    const box = bboxOf(rs.map((r) => r.ring));
    let covered = 0;
    let hitZones = 0;
    for (let zi = 0; zi < official.zones.length; zi++) {
      if (!bboxOverlap(box, zoneBox[zi])) continue;
      const inter = overlapArea(rs, zoneTris[zi]);
      if (inter <= area * SHARE_EPSILON) continue;
      const share = inter / area;
      covered += share;
      hitZones++;
      overlapPairs++;
      shares[zi].push({ cellIdx: ci, share });
    }

    if (covered > 1.02) {
      // The county's zones are meant to tile without overlapping. More than 100%
      // of a block group means either they double-cover it or the clip is wrong,
      // and normalising it away would hide whichever it is.
      overlapAnomalies++;
      loudBalance(
        `block group ${cell.id} apportions to ${(covered * 100).toFixed(1)}% of itself across ` +
          `${hitZones} zones — over 100%. Either the official polygons overlap each other or the ` +
          `clip is wrong. Nothing was normalised; the excess surfaces in the conservation line below.`,
      );
    }

    const outside = Math.max(0, 1 - covered);
    outsideHouseholds += cell.households * outside;
    outsidePopulation += cell.population * outside;
    outsideArea += area * outside;
    if (covered <= SHARE_EPSILON) {
      fullyOutside.push({ id: cell.id, households: cell.households });
    } else if (outside > MIN_BLOCK_GROUP_SHARE) {
      partlyOutside.push({ id: cell.id, households: cell.households, pct: outside * 100 });
    }
  }

  const floats = Object.fromEntries(
    METRICS.map((m) => [
      m,
      official.zones.map((_, zi) =>
        shares[zi].reduce((a, s) => a + METRIC_OF[m](routes[s.cellIdx].cell) * s.share, 0),
      ),
    ]),
  ) as Record<Metric, number[]>;

  const rounded = Object.fromEntries(
    METRICS.map((m) => [
      m,
      largestRemainder(floats[m], Math.round(floats[m].reduce((a, b) => a + b, 0))),
    ]),
  ) as Record<Metric, number[]>;

  const zeroZones: { id: string; structures: number; reason: string }[] = [];
  let offNetworkZones = 0;

  const drafts: Draft[] = official.zones.map((z, zi) => {
    const parts = shares[zi].slice().sort((a, b) => b.share - a.share);
    // Every contributor over the threshold — but never an empty list on a zone
    // that did get households. A sliver of a huge rural block group can clear
    // 1% of nothing, and population with no provenance is unauditable.
    const named = parts.filter((p) => p.share >= MIN_BLOCK_GROUP_SHARE);
    const contributors = named.length > 0 ? named : parts.slice(0, 1);

    // Weight by the households a block group actually LENDS this zone, so a
    // near-empty block group covering most of it cannot drag the centroid away.
    const weight = (p: ZoneShare) => Math.max(routes[p.cellIdx].cell.households * p.share, 1e-9);

    // The area centroid can fall outside a concave zone; prefer a point that is
    // actually inside so the route snap and compass sector describe this zone.
    let centroid = z.centroid;
    if (!pointInRings(centroid, z.rings) && parts.length > 0) {
      const w = parts.reduce((a, p) => a + weight(p), 0);
      const weighted: LngLat = [
        parts.reduce((a, p) => a + routes[p.cellIdx].cell.centroid[0] * weight(p), 0) / w,
        parts.reduce((a, p) => a + routes[p.cellIdx].cell.centroid[1] * weight(p), 0) / w,
      ];
      if (pointInRings(weighted, z.rings)) centroid = weighted;
    }

    const snap = snapRoutable(g, grid, centroid);
    let path = snap.node >= 0 ? walkPath(g, snap.node) : { edgeIds: [], edgeIdx: [], sink: -1 };
    if (path.edgeIds.length === 0 && parts.length > 0) {
      // Modal fallback: the path most of this zone's apportioned households take.
      const tally = new Map<string, { n: number; idx: number }>();
      for (const p of parts) {
        const k = routes[p.cellIdx].edgeIds.join(",");
        if (!k) continue;
        const cur = tally.get(k);
        if (cur) cur.n += weight(p);
        else tally.set(k, { n: weight(p), idx: p.cellIdx });
      }
      const top = [...tally.values()].sort((a, b) => b.n - a.n)[0];
      if (top)
        path = { edgeIds: routes[top.idx].edgeIds, edgeIdx: routes[top.idx].edgeIdx, sink: -1 };
    }
    const onNetwork = path.edgeIds.length > 0;
    if (!onNetwork) offNetworkZones++;

    if (rounded.households[zi] === 0) {
      zeroZones.push({
        id: z.id,
        structures: z.officialStructures ?? 0,
        reason:
          parts.length === 0
            ? "no block-group polygon overlaps it at all"
            : `${parts.length} block group(s) overlap it but apportion ${floats.households[zi].toFixed(2)} households`,
      });
    }

    return {
      id: z.id,
      geometry: z.rings,
      centroid,
      labelPrefix: z.community,
      households: rounded.households[zi],
      population: rounded.population[zi],
      noVehicleHouseholds: rounded.noVehicleHouseholds[zi],
      vehicles: rounded.vehicles[zi],
      mobileHomes: rounded.mobileHomes[zi],
      blockGroupIds: contributors.map((p) => routes[p.cellIdx].cell.id).sort(),
      primaryRouteEdgeIds: path.edgeIds,
      // An honest label beats routeLabel's "unnamed local roads" for a zone the
      // road extract never covered — Concow and Butte Valley run off its edge.
      primaryRouteLabel: onNetwork
        ? routeLabel(g.edges, path.edgeIdx)
        : "Outside the modelled road network",
      routeHead: onNetwork ? routeHead(g.edges, path.edgeIdx) : z.subZone || "Unrouted",
      hazardEta: hazardEtaOf(z.rings, frames, scenario.duration),
      officialStructures: z.officialStructures,
    };
  });

  log(
    `apportionment: ${routes.length} block groups clipped against ${official.zones.length} zones — ` +
      `${overlapPairs} block-group/zone overlaps, ${shares.filter((s) => s.length > 0).length} zones touched`,
  );

  return {
    drafts,
    inputHouseholds,
    insideHouseholds: floats.households.reduce((a, b) => a + b, 0),
    assignedHouseholds: rounded.households.reduce((a, b) => a + b, 0),
    outsideHouseholds,
    outsidePopulation,
    outsideAreaKm2: outsideArea / 1e6,
    fullyOutside,
    partlyOutside,
    zeroZones,
    offNetworkZones,
    overlapAnomalies,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived zones — the fallback when no county layer is published
// ─────────────────────────────────────────────────────────────────────────────

function derivedDrafts(
  scenario: ScenarioMeta,
  pop: PopulationLayer,
  routes: CellRoute[],
  g: Graph,
  grid: NodeGrid,
  frames: HazardFrame[],
  corridorCount: number,
): Draft[] {
  // ── cluster by corridor + contiguity, split, rebalance ────────────────────
  const adj = buildAdjacency(pop.cells);
  const byCorridor = new Map<string, number[]>();
  routes.forEach((r, i) => {
    const list = byCorridor.get(r.corridorKey);
    if (list) list.push(i);
    else byCorridor.set(r.corridorKey, [i]);
  });

  let clusters: Cluster[] = [];
  for (const [key, members] of byCorridor) {
    const name = routes[members[0]].corridorName;
    for (const comp of components(members, adj)) {
      clusters.push({ cells: comp, corridorKey: key, corridorName: name });
    }
  }
  const rawCount = clusters.length;

  const split: Cluster[] = [];
  for (const c of clusters) {
    const hh = householdsOf(c, routes);
    const parts = Math.max(1, Math.ceil(hh / MAX_ZONE_HOUSEHOLDS));
    split.push(...splitCluster(c, routes, parts));
  }
  // The greedy fill can leave the tail bucket over the cap, so keep halving the
  // offenders until only indivisible single block groups remain above it.
  const exhausted = new Set<Cluster>();
  for (let pass = 0; pass < 80; pass++) {
    const idx = split.findIndex(
      (c) =>
        !exhausted.has(c) && c.cells.length >= 2 && householdsOf(c, routes) > MAX_ZONE_HOUSEHOLDS,
    );
    if (idx < 0) break;
    const pieces = splitCluster(split[idx], routes, 2);
    if (pieces.length < 2) {
      exhausted.add(split[idx]);
      continue;
    }
    split.splice(idx, 1, ...pieces);
  }
  clusters = rebalance(split, routes, adj);
  log(
    `clusters: ${corridorCount} corridors -> ${rawCount} contiguous -> ${split.length} after size split -> ${clusters.length} after rebalance`,
  );
  const oversize = clusters.filter((c) => householdsOf(c, routes) > MAX_ZONE_HOUSEHOLDS);
  if (oversize.length > 0) {
    log(
      `warn: ${oversize.length} zone(s) still over ${MAX_ZONE_HOUSEHOLDS} households — indivisible, the block group itself is that big (${oversize
        .map((c) => `${householdsOf(c, routes)}hh/${c.cells.length}bg`)
        .join(", ")})`,
    );
  }

  // ── geometry, aggregates, route, hazard ETA ───────────────────────────────
  let hullFallbacks = 0;

  const drafts: Draft[] = clusters.map((cluster) => {
    const cells = cluster.cells.map((i) => routes[i].cell);
    const { rings, fallback } = dissolve(cells.map((c) => c.geometry.map((r) => openRing(r))));
    if (fallback) hullFallbacks++;

    let centroid = ringCentroid(rings);
    if (!pointInRings(centroid, rings)) {
      const hh = cells.reduce((a, c) => a + Math.max(c.households, 1), 0);
      const weighted: LngLat = [
        cells.reduce((a, c) => a + c.centroid[0] * Math.max(c.households, 1), 0) / hh,
        cells.reduce((a, c) => a + c.centroid[1] * Math.max(c.households, 1), 0) / hh,
      ];
      centroid = pointInRings(weighted, rings)
        ? weighted
        : cells.slice().sort((a, b) => b.households - a.households)[0].centroid;
    }

    // Route from the merged zone's own centroid — clusters can be merged across
    // corridors during rebalance, so a per-cell route would be stale here.
    const snap = snapRoutable(g, grid, centroid);
    let path = snap.node >= 0 ? walkPath(g, snap.node) : { edgeIds: [], edgeIdx: [], sink: -1 };
    if (path.edgeIds.length === 0) {
      // Modal fallback: the path most households in this zone actually take.
      const tally = new Map<string, { n: number; idx: number }>();
      for (const i of cluster.cells) {
        const k = routes[i].edgeIds.join(",");
        if (!k) continue;
        const cur = tally.get(k);
        if (cur) cur.n += routes[i].cell.households;
        else tally.set(k, { n: routes[i].cell.households, idx: i });
      }
      const top = [...tally.values()].sort((a, b) => b.n - a.n)[0];
      if (top)
        path = { edgeIds: routes[top.idx].edgeIds, edgeIdx: routes[top.idx].edgeIdx, sink: -1 };
    }

    return {
      id: null,
      geometry: rings,
      centroid,
      labelPrefix: "",
      households: cells.reduce((a, c) => a + c.households, 0),
      population: cells.reduce((a, c) => a + c.population, 0),
      noVehicleHouseholds: cells.reduce((a, c) => a + c.noVehicleHouseholds, 0),
      vehicles: cells.reduce((a, c) => a + c.vehiclesAvailable, 0),
      mobileHomes: cells.reduce((a, c) => a + c.mobileHomes, 0),
      blockGroupIds: cells.map((c) => c.id).sort(),
      primaryRouteEdgeIds: path.edgeIds,
      primaryRouteLabel: routeLabel(g.edges, path.edgeIdx),
      routeHead: routeHead(g.edges, path.edgeIdx),
      hazardEta: hazardEtaOf(rings, frames, scenario.duration),
    };
  });
  log(
    `geometry: dissolved ${drafts.length} zones${hullFallbacks > 0 ? ` (${hullFallbacks} hull fallbacks)` : ""}`,
  );
  return drafts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario = getScenario(scenarioId);
  if (scenario.id !== scenarioId) {
    console.warn(`[zones] unknown scenario "${scenarioId}" — falling back to ${scenario.id}`);
  }
  log(`scenario ${scenario.id} — ${scenario.place}`);

  const dataDir = join(ROOT, "public", "data", scenario.id);
  mkdirSync(dataDir, { recursive: true });

  // ── stage 1: inputs ────────────────────────────────────────────────────────
  const synthesized: string[] = [];
  let net = readJson<RoadNetwork>(join(dataDir, "network.json"));
  if (!net) {
    net = synthNetwork(scenario);
    synthesized.push("network.json");
    loud(
      `network.json was missing at ${join(dataDir, "network.json")} — SYNTHESIZED a 15x15 lattice road network (${net.edges.length} edges, ${net.sinks.length} sinks) with placeholder arterials named Corridor A / B / C and Cross Route — deliberately not real road names. Corridors, route edge ids and route labels below are NOT OpenStreetMap data.`,
    );
  }
  let pop = readJson<PopulationLayer>(join(dataDir, "population.json"));
  if (!pop) {
    pop = synthPopulation(scenario);
    synthesized.push("population.json");
    loud(
      `population.json was missing at ${join(dataDir, "population.json")} — SYNTHESIZED ${pop.cells.length} square pseudo-block-groups with a Gaussian density bump totalling ${pop.totals.population} people / ${pop.totals.households} households. Block group ids, household counts, no-vehicle counts and mobile-home counts below are NOT US Census ACS data.`,
    );
  }
  let haz = readJson<HazardTrack>(join(dataDir, "hazard.json"));
  if (!haz) {
    haz = synthHazard(scenario);
    synthesized.push("hazard.json");
    loud(
      `hazard.json was missing at ${join(dataDir, "hazard.json")} — SYNTHESIZED ${haz.frames.length} frames of a single circular front advancing SW across the bbox. Every hazardEta below is NOT derived from NIFC/WFIGS perimeters.`,
    );
  }

  log(
    `network: ${net.nodes.length} nodes / ${net.edges.length} edges / ${net.sinks.length} sinks (${net.source})`,
  );
  log(
    `population: ${pop.cells.length} cells / ${pop.totals.population} people / ${pop.totals.households} households (${pop.source})`,
  );
  log(`hazard: ${haz.frames.length} frames (${haz.source})`);

  // ── stage 2: shortest time to a sink for every node ───────────────────────
  const t0 = Date.now();
  const g = buildGraph(net);
  let reachableNodes = 0;
  for (let i = 0; i < g.dist.length; i++) if (Number.isFinite(g.dist[i])) reachableNodes++;
  log(
    `dijkstra: ${reachableNodes}/${g.nodeIds.length} nodes can reach a sink (${Date.now() - t0} ms)`,
  );
  if (reachableNodes === 0) {
    console.error("[zones] FATAL: no node reaches a sink — network has no usable sinks.");
    process.exit(1);
  }

  const grid = new NodeGrid(g.nodePos);

  // ── stage 3: route each cell, key it by its first trunk-class edge ────────
  const routes: CellRoute[] = [];
  let unreachableCells = 0;
  for (const cell of pop.cells) {
    const snap = snapRoutable(g, grid, cell.centroid);
    const path = snap.node >= 0 ? walkPath(g, snap.node) : { edgeIds: [], edgeIdx: [], sink: -1 };

    let key = "";
    let display = "";
    for (const ei of path.edgeIdx) {
      const e = g.edges[ei];
      if (!TRUNK_CLASSES.has(e.roadClass)) continue;
      if (e.name) {
        key = `road:${normalizeRoadName(e.name)}`;
        display = e.name;
        break;
      }
      if (!key) {
        // Unnamed trunk: hold it, but keep scanning for a named one so a whole
        // arterial does not shatter into per-segment corridors.
        key = `edge:${e.id}`;
        display = `${e.roadClass} corridor`;
      }
    }
    if (!key) {
      // No trunk edge at all: fall back to the last named road, then the sink.
      for (let i = path.edgeIdx.length - 1; i >= 0; i--) {
        const e = g.edges[path.edgeIdx[i]];
        if (e.name) {
          key = `road:${normalizeRoadName(e.name)}`;
          display = e.name;
          break;
        }
      }
    }
    if (!key) {
      key = `sink:${path.sink >= 0 ? g.nodeIds[path.sink] : "none"}`;
      display = "Local street network";
    }

    if (!snap.reachable) unreachableCells++;
    routes.push({
      cell,
      node: snap.node,
      reachable: snap.reachable,
      edgeIds: path.edgeIds,
      edgeIdx: path.edgeIdx,
      corridorKey: key,
      corridorName: display,
      timeToSink: snap.node >= 0 && Number.isFinite(g.dist[snap.node]) ? g.dist[snap.node] : 1e9,
    });
  }
  const corridorCount = new Set(routes.map((r) => r.corridorKey)).size;
  log(
    `routed ${routes.length - unreachableCells}/${routes.length} cells to a sink across ${corridorCount} corridors` +
      (unreachableCells > 0 ? ` (${unreachableCells} stranded, kept for coverage)` : ""),
  );

  // ── stage 4: pick the zone set ────────────────────────────────────────────
  const officialPath = join(dataDir, "official-zones.geojson");
  const official = readOfficialZones(officialPath);
  const frames = haz.frames.slice().sort((a, b) => a.t - b.t);

  let drafts: Draft[];
  let officialResult: OfficialResult | null = null;

  if (official) {
    log("");
    log(`PATH: OFFICIAL — ${official.zones.length} county zones read from ${officialPath}`);
    log(`      provenance: ${official.source}`);
    log("      zone ids below are the COUNTY'S OWN and are emitted verbatim, never renumbered.");
    officialResult = officialDrafts(official, scenario, routes, g, grid, frames);
    drafts = officialResult.drafts;
  } else {
    log("");
    log(`PATH: DERIVED — no official zone layer at ${officialPath}`);
    log("      zones below are CLUSTERED from block groups onto egress corridors, and their ids");
    log("      are OURS, not the county's. They do not paste into the county's tool as-is.");
    log(`      to use real ids: npx tsx scripts/fetch-evac-zones.ts ${scenario.id}`);
    drafts = derivedDrafts(scenario, pop, routes, g, grid, frames, corridorCount);
  }

  // ── stage 5: order by urgency, then id and label ──────────────────────────
  // Ordering by hazard ETA keeps the UI's urgency sort load-bearing on both
  // paths. On the official path it is ONLY an ordering: the ids are never
  // renumbered, because "BUT-TOP-01" meaning the county's BUT-TOP-01 is the
  // whole reason the official path exists.
  drafts.sort((a, b) => a.hazardEta - b.hazardEta || b.households - a.households);
  const prefix = ZONE_PREFIX[scenario.id] ?? scenario.place.slice(0, 3).toUpperCase();
  const labelSeen = new Map<string, number>();

  const zones: EvacZone[] = drafts.map((d, i) => {
    const head = `${d.routeHead} ${compassSector(scenario.center, d.centroid)}`.trim();
    const base = d.labelPrefix ? `${d.labelPrefix} — ${head}` : head;
    const n = (labelSeen.get(base) ?? 0) + 1;
    labelSeen.set(base, n);
    const zone: EvacZone = {
      id: d.id ?? `${prefix}-E${String(i + 1).padStart(3, "0")}`,
      label: n === 1 ? base : `${base} ${n}`,
      geometry: d.geometry,
      centroid: d.centroid,
      blockGroupIds: d.blockGroupIds,
      households: d.households,
      population: d.population,
      noVehicleHouseholds: d.noVehicleHouseholds,
      vehicles: d.vehicles,
      mobileHomes: d.mobileHomes,
      primaryRouteEdgeIds: d.primaryRouteEdgeIds,
      primaryRouteLabel: d.primaryRouteLabel,
      hazardEta: d.hazardEta,
    };
    if (d.officialStructures !== undefined) zone.officialStructures = d.officialStructures;
    return zone;
  });

  const layer: ZoneLayer = {
    scenarioId: scenario.id,
    zones,
    generatedAt: new Date().toISOString(),
  };
  const outPath = join(dataDir, "zones.json");
  writeFileSync(outPath, JSON.stringify(layer));
  log(`wrote ${outPath} (${statSync(outPath).size} bytes)`);

  // ── report ────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const rpad = (s: string, n: number) => s.padStart(n);
  console.log("");
  const labelW = Math.max(12, ...zones.map((z) => z.label.length)) + 2;
  console.log(
    `${pad("ID", 12)}${rpad("HH", 7)}${officialResult ? rpad("STRUCT", 8) : ""}${rpad("NOVEH", 7)}${rpad("POP", 8)}${rpad("ETA", 8)}  ${pad("LABEL", labelW)}ROUTE`,
  );
  console.log("-".repeat(60 + labelW));
  for (const z of zones) {
    const struct = z.officialStructures === undefined ? "" : rpad(String(z.officialStructures), 8);
    console.log(
      `${pad(z.id, 12)}${rpad(String(z.households), 7)}${struct}${rpad(String(z.noVehicleHouseholds), 7)}${rpad(
        String(z.population),
        8,
      )}${rpad(fmtTick(z.hazardEta), 8)}  ${pad(z.label, labelW)}${z.primaryRouteLabel}`,
    );
  }
  console.log("-".repeat(60 + labelW));
  const tHH = zones.reduce((a, z) => a + z.households, 0);
  const tNV = zones.reduce((a, z) => a + z.noVehicleHouseholds, 0);
  const tPOP = zones.reduce((a, z) => a + z.population, 0);
  const tSTRUCT = zones.reduce((a, z) => a + (z.officialStructures ?? 0), 0);
  console.log(
    `${pad(`${zones.length} zones`, 12)}${rpad(String(tHH), 7)}${officialResult ? rpad(String(tSTRUCT), 8) : ""}${rpad(String(tNV), 7)}${rpad(String(tPOP), 8)}`,
  );
  const coverage = pop.totals.households > 0 ? (tHH / pop.totals.households) * 100 : 100;
  log(`coverage: ${coverage.toFixed(1)}% of population-layer households assigned to a zone`);

  if (officialResult) {
    const r = officialResult;
    log(
      `official zone ids kept verbatim: ${zones.length} zones, sorted by hazard ETA only — first is ${zones[0]?.id}, last is ${zones[zones.length - 1]?.id}`,
    );
    log(
      `ACS households ${tHH} vs county structure count ${tSTRUCT} — these measure different things ` +
        `(occupied households vs standing structures) and are carried side by side on purpose, not reconciled`,
    );
    // The books balance in THREE terms, not two: zones + outside-the-mapped-
    // system = the population layer. The outside term is a real category, and
    // stating it is what stops apportionment quietly eating a rural block group.
    const outsideHH = Math.round(r.outsideHouseholds);
    const reconciled = r.assignedHouseholds + outsideHH;
    const gap = r.inputHouseholds - reconciled;
    log(
      `CONSERVATION: ${r.assignedHouseholds} households apportioned into zones + ${outsideHH} outside the ` +
        `mapped zones = ${reconciled}, against ${r.inputHouseholds} in population.json ` +
        `(pre-round inside total ${r.insideHouseholds.toFixed(2)}; gap ${gap})`,
    );
    if (Math.abs(gap) > r.inputHouseholds * 0.005) {
      loudBalance(
        `apportionment does not reconcile: ${gap} households unaccounted for ` +
          `(${((Math.abs(gap) / Math.max(r.inputHouseholds, 1)) * 100).toFixed(2)}% of ${r.inputHouseholds}), ` +
          `with ${r.overlapAnomalies} block group(s) apportioning to over 100% of themselves. That is a BUG in the ` +
          `clip or the rounding, not a data category — this zones.json must not be shipped as-is.`,
      );
    }
    if (outsideHH > 0) {
      loudDrop(
        `${outsideHH} households / ${Math.round(r.outsidePopulation)} people — ${r.outsideAreaKm2.toFixed(1)} km² of ` +
          `block-group area — fall OUTSIDE every mapped evacuation zone. This is a legitimate category, not a loss: ` +
          `the county has simply not zoned that ground. ${r.fullyOutside.length} block group(s) lie wholly outside` +
          (r.fullyOutside.length > 0
            ? ` (${r.fullyOutside.map((c) => `${c.id} ${c.households}hh`).join(", ")})`
            : "") +
          `; ${r.partlyOutside.length} more spill past a zone edge` +
          (r.partlyOutside.length > 0
            ? ` (${r.partlyOutside.map((c) => `${c.id} ${c.pct.toFixed(0)}% out`).join(", ")})`
            : "") +
          `. So the ${tHH} households above are ${coverage.toFixed(1)}% of the ${pop.totals.households} in the ` +
          `population bbox, and the remainder is located, not missing.`,
      );
    }
    if (r.zeroZones.length > 0) {
      log(
        `${r.zeroZones.length}/${zones.length} zones hold ZERO apportioned households after areal apportionment, ` +
          `carrying ${r.zeroZones.reduce((a, z) => a + z.structures, 0)} official structures between them. Their ` +
          `officialStructures are kept, so they must not be read as unpopulated:`,
      );
      for (const z of r.zeroZones) log(`  ${z.id}: ${z.structures} structures — ${z.reason}`);
    }
    if (r.offNetworkZones > 0) {
      log(
        `${r.offNetworkZones}/${zones.length} zones could not be routed — they lie outside the OSM extract's bbox ` +
          `(Concow and Butte Valley run off its edge). Their primaryRouteEdgeIds are empty rather than guessed.`,
      );
    }
  }
  const cut = zones.filter((z) => z.hazardEta < scenario.burnoverAt).length;
  log(
    `${cut}/${zones.length} zones are reached by the hazard before burnover (T+${fmtTick(scenario.burnoverAt)})`,
  );
  if (synthesized.length > 0) {
    loud(
      `zones.json for ${scenario.id} was built on SYNTHESIZED inputs: ${synthesized.join(", ")}. Re-run after the fetchers land real data.`,
    );
  }
}

main();

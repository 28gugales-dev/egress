/**
 * simulate.ts — corridor queueing model. Writes run_baseline, run_planned, param_grid.
 *
 * WHAT THIS IS, SAID OUT LOUD
 *
 * This is a DETERMINISTIC MACROSCOPIC QUEUEING MODEL, not a microsimulation.
 * There are no vehicles with car-following behaviour, no lane changes, no
 * intersections, no signal timing, no route re-choice mid-trip. Every road that
 * matters is reduced to ONE number — its directional capacity in vehicles per
 * hour — and every zone is reduced to a departure time and a vehicle count.
 *
 * The whole model is four lines per egress corridor c:
 *
 *     demand_c(t)  = vehicles assigned to c that have departed by t
 *     served_c(t)  = min(demand_c(t), served_c(t-dt) + capacity_c(t) * dt/3600)
 *     queue_c(t)   = demand_c(t) - served_c(t)
 *     clearance_c  = time queue_c returns to zero, plus corridor travel time
 *
 * Total clearance is the max over corridors. That is the entire solver. It is
 * deliberately small enough that an incident commander can check it by hand,
 * and it reproduces the one phenomenon the product is about: a corridor loaded
 * past its capacity backs up, and the backup does not clear until the demand
 * stops. Queues are then laid back along each zone's real route geometry so the
 * congestion renders on the map and so a queued vehicle sitting on an edge the
 * fire has closed can be counted.
 *
 * WHAT IT DOES NOT MODEL — state these before anyone asks
 *   - No spill-back between corridors. A jam on Clark does not physically block
 *     the feeder streets of a zone routed onto Pentz. Real gridlock is worse
 *     than this model, so every clearance figure here is OPTIMISTIC.
 *   - Closed edges are counted for EXPOSURE but do not throttle throughput. A
 *     vehicle sitting on a burning road at T+4h is reported in the hazard, and
 *     it still eventually clears. Gating flow on closure instead would deadlock
 *     the run outright, because the interpolated fire footprint closes 4,008 of
 *     4,905 edges — including the corridor throats — by roughly T+4h. Counting
 *     exposure without gating flow is the generous-to-the-baseline choice, and
 *     it is the seam in this model most worth naming first.
 *   - No intersection interaction, no merge loss, no incident/crash blockage.
 *     Paradise had vehicle fires and abandoned cars blocking lanes. Not here.
 *   - Queue storage is computed per zone route, so two zones sharing a road
 *     each get the full storage of that road. Again optimistic.
 *   - Departure is instantaneous at the wave time, not a loading curve.
 *
 * WHAT IS REAL
 *   - Zone ids, households, no-vehicle households and hazard ETAs: zones.json,
 *     read fresh at run time (Butte County's own BUT-* naming).
 *   - Corridor capacities: cross-checked against network.json edge capacities.
 *   - Route geometry and corridor assignment: the free-flow shortest-path tree
 *     over the OSM network — which is exactly what a navigation app computes,
 *     and therefore exactly what the baseline should use.
 *   - Edge closures and hazard exposure: hazard.json closedEdgeIds per frame.
 *   - Buses, shelters, pickup points: facilities.json.
 *
 * THE COUNTERFACTUAL, IN ONE SENTENCE
 *   Baseline routes every zone the way a navigation app does — individually
 *   fastest road — which piles 12,000 vehicles onto the two 800-900 veh/hr
 *   corridors while Skyway's 1,800 runs half empty. Planned reassigns zones to
 *   balance load against capacity, stages the releases in hazard-ETA order, and
 *   reverses the contraflow-eligible lanes. Same roads, same people, same
 *   compliance.
 *
 * Usage: npx tsx scripts/simulate.ts camp-fire-2018
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PARAMS,
  DEFAULT_PARAMS,
  DISPATCH_ORIGINS,
  getScenario,
  PARAM_AXES,
} from "../src/lib/constants";
import type {
  ContraflowOrder,
  EvacPlan,
  EvacZone,
  Facility,
  FacilityLayer,
  HazardTrack,
  LngLat,
  ParamGrid,
  PickupStop,
  PopulationLayer,
  ReleaseWave,
  RoadEdge,
  RoadNetwork,
  RunFrame,
  RunKind,
  RunParams,
  RunSummary,
  ScenarioMeta,
  SimulationRun,
  Tick,
  Trip,
  VehicleManifest,
  ZoneLayer,
  ZoneStatus,
} from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables — every one of these is a stated assumption, not a fitted parameter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The named egress corridors out of each community and their directional
 * capacity in veh/hr, measured at the THROAT — the lane count where the road
 * actually leaves the area, not its widest segment. Capacities are asserted
 * here and CROSS-CHECKED against the maximum capacity carried by any edge of
 * that name in network.json; a mismatch prints a warning rather than being
 * silently absorbed.
 *
 * Only roads on this list count toward the aggregate egress denominator. Real
 * escape paths the routing finds that are not on it are still metered
 * individually, at their own capacity, but pooling them into the denominator
 * would flatter every utilisation figure.
 *
 * Paradise: Pearson Rd is deliberately absent — it feeds Clark, it is not an
 * independent way off the ridge, and counting it would double-count Clark's
 * throat.
 *
 * Pacific Palisades: Palisades Drive, Temescal Canyon Rd and Chautauqua Blvd
 * are likewise absent, and that absence IS the scenario. None of them leaves
 * the community; all three drain into Sunset or PCH, so the whole Highlands —
 * one tertiary road, 800 veh/hr — discharges through a corridor already
 * carrying everyone else.
 */
const CORRIDOR_CAPACITY_BY_SCENARIO: Record<string, Record<string, number>> = {
  "camp-fire-2018": {
    Skyway: 1800,
    "Clark Road": 900,
    "Pentz Road": 800,
    "Neal Road": 800,
    "Honey Run Road": 800,
  },
  "palisades-fire-2025": {
    // PCH has two throats in opposite directions — 3 lanes east toward Santa
    // Monica (5,100) and 2 lanes west toward Malibu (3,400). The corridor model
    // keys on road name and meters one exit node, so only the busier throat is
    // declared. That is deliberately conservative, and it is also closer to the
    // event: westbound PCH was itself under an evacuation order (Big Rock) two
    // hours and eleven minutes after ignition.
    "Pacific Coast Highway": 5100,
    "West Sunset Boulevard": 1800,
    "North Topanga Canyon Boulevard": 1000,
  },
};

/** Set once per run from CORRIDOR_CAPACITY_BY_SCENARIO. */
let CORRIDOR_CAPACITY: Record<string, number> = {};

/** Jam spacing: vehicle length plus gap, metres. Standard queueing figure. */
const VEH_LENGTH_M = 7.5;

/** Wave spacing in the staged plan. */
const WAVE_SPACING: Tick = 2700;

/** A wave may load a corridor to this fraction of capacity before the planner
 *  pushes the next zone to a later wave. */
const WAVE_LOAD_TARGET = 0.85;

/** A zone will not be reassigned off its fastest corridor for more than this
 *  much extra free-flow driving. Beyond it the reassignment stops being an
 *  instruction anyone would follow. */
const MAX_DETOUR_SECONDS = 1200;

/** No wave departs later than its zone's hazard ETA minus this margin. */
const HAZARD_MARGIN: Tick = 900;

/** Type C school bus. Documented constant, not derived from the data. */
const BUS_SEATS = 44;
const AMBULANCE_SEATS = 2;

/** Dwell at each pickup, seconds. Loading mobility-limited passengers. */
const STOP_DWELL: Tick = 180;

/** A shelter must stay outside the fire footprint for this long after the drop.
 *  Unloading a bus somewhere that burns forty minutes later is not a plan. */
const SHELTER_SAFETY_MARGIN: Tick = 3600;

/** One rendered trip per this many vehicles. Purely a display density. */
const VEHICLES_PER_TRIP = 25;

/** Max vertices kept per rendered trip path. */
const TRIP_PATH_POINTS = 40;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────────────────────────────────────────────────────────
// IO + logging
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[sim] ${msg}`);
}

function loud(msg: string): void {
  console.warn(`\n**** SYNTHETIC DATA **** ${msg}\n`);
}

/** Nothing invented — something real was left out or overridden. */
function loudNote(msg: string): void {
  console.warn(`\n**** MODEL NOTE **** ${msg}\n`);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    console.warn(`[sim] failed to parse ${path}: ${(err as Error).message}`);
    return null;
  }
}

function requireJson<T>(path: string, what: string): T {
  const v = readJson<T>(path);
  if (!v) {
    console.error(
      `[sim] FATAL: ${what} missing or unparseable at ${path}. Run the fetchers first; ` +
        `this script will not invent a road network or a population.`,
    );
    process.exit(1);
  }
  return v;
}

function fmtHrs(t: Tick): string {
  if (!Number.isFinite(t)) return "never";
  const h = Math.floor(t / 3600);
  const m = Math.round((t % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function mbOf(path: string): string {
  return `${(statSync(path).size / 1e6).toFixed(2)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/** Equirectangular metres. Adapted from scripts/build-zones.ts. */
function metersBetween(a: LngLat, b: LngLat): number {
  const latRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * 111320 * Math.cos(latRad);
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

/** Even-odd ray cast over outer rings. Adapted from scripts/build-zones.ts. */
function pointInRings(pt: LngLat, rings: LngLat[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph — MinHeap / buildGraph / walkPath adapted from scripts/build-zones.ts.
// Copied rather than imported: build-zones.ts calls main() at module scope, so
// importing it would rebuild zones.json as a side effect of running the sim.
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

interface Arc {
  to: number;
  edge: number;
  cost: number;
}

interface Graph {
  index: Map<string, number>;
  nodeIds: string[];
  nodePos: LngLat[];
  edges: RoadEdge[];
  /** Forward arcs out of each node — used for bus routing. */
  fwd: Arc[][];
  /** Reverse arcs into each node — used for the to-sink trees. */
  rev: Arc[][];
}

/** Result of a reverse (to-destination) Dijkstra: time out plus a successor
 *  pointer chain that walks FORWARD toward the destination. */
interface OutTree {
  dist: Float64Array;
  succEdge: Int32Array;
  succNode: Int32Array;
}

function travelSeconds(e: RoadEdge): number {
  const speed = e.speed > 0 ? e.speed : 30;
  return Math.max(e.length, 1) / ((speed * 1000) / 3600);
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

  const fwd: Arc[][] = Array.from({ length: nodeIds.length }, () => []);
  const rev: Arc[][] = Array.from({ length: nodeIds.length }, () => []);
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
    fwd[u].push({ to: v, edge: ei, cost });
    rev[v].push({ to: u, edge: ei, cost });
    if (!e.oneway) {
      fwd[v].push({ to: u, edge: ei, cost });
      rev[u].push({ to: v, edge: ei, cost });
    }
  }
  if (dropped > 0) log(`warn: dropped ${dropped} edges with unknown endpoints`);
  return { index, nodeIds, nodePos, edges: net.edges, fwd, rev };
}

/**
 * Multi-source reverse Dijkstra. `seeds` are (node, initialCost) pairs; the
 * relaxation walks backwards through the network while the recorded successor
 * pointers walk forwards toward the seed. Seeding with a nonzero initial cost is
 * how "time to a sink VIA corridor c" is expressed: seed the corridor's exit
 * node with the time from there to the sink.
 */
function outTree(g: Graph, seeds: Array<[number, number]>, base?: OutTree): OutTree {
  const n = g.nodeIds.length;
  const dist = new Float64Array(n).fill(Infinity);
  const succEdge = new Int32Array(n).fill(-1);
  const succNode = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  for (const [node, cost] of seeds) {
    if (node < 0 || node >= n || !(cost < dist[node])) continue;
    dist[node] = cost;
    // A seeded node inherits its onward path from the base tree, so walking the
    // chain from any upstream node runs through the seed and out to a sink.
    if (base) {
      succEdge[node] = base.succEdge[node];
      succNode[node] = base.succNode[node];
    }
    heap.push(node, cost);
  }
  while (heap.size > 0) {
    const { i, k } = heap.pop();
    if (done[i] || k > dist[i]) continue;
    done[i] = 1;
    for (const a of g.rev[i]) {
      const nd = dist[i] + a.cost;
      if (nd < dist[a.to]) {
        dist[a.to] = nd;
        succEdge[a.to] = a.edge;
        succNode[a.to] = i;
        heap.push(a.to, nd);
      }
    }
  }
  return { dist, succEdge, succNode };
}

/** Forward Dijkstra from one origin. Used to route buses to their pickups. */
function forwardTree(
  g: Graph,
  from: number,
): { dist: Float64Array; prevNode: Int32Array; prevEdge: Int32Array } {
  const n = g.nodeIds.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  if (from >= 0) {
    dist[from] = 0;
    heap.push(from, 0);
  }
  while (heap.size > 0) {
    const { i, k } = heap.pop();
    if (done[i] || k > dist[i]) continue;
    done[i] = 1;
    for (const a of g.fwd[i]) {
      const nd = dist[i] + a.cost;
      if (nd < dist[a.to]) {
        dist[a.to] = nd;
        prevNode[a.to] = i;
        prevEdge[a.to] = a.edge;
        heap.push(a.to, nd);
      }
    }
  }
  return { dist, prevNode, prevEdge };
}

function walkOut(g: Graph, tree: OutTree, from: number): string[] {
  const ids: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur >= 0 && tree.succEdge[cur] >= 0 && guard++ < 20000) {
    ids.push(g.edges[tree.succEdge[cur]].id);
    cur = tree.succNode[cur];
  }
  return ids;
}

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

  nearest(pt: LngLat, ok?: (i: number) => boolean): number {
    const cx = Math.floor(pt[0] / this.step);
    const cy = Math.floor(pt[1] / this.step);
    const out: number[] = [];
    for (let r = 0; r <= 24; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.cells.get(`${cx + dx}:${cy + dy}`);
          if (list) out.push(...list);
        }
      }
      // Count only candidates that PASS the filter: the nearest two dozen nodes
      // to a mobile home park are routinely all orphaned driveway fragments, and
      // stopping on raw candidate count silently returns "no node found".
      const passing = ok ? out.reduce((a, i) => a + (ok(i) ? 1 : 0), 0) : out.length;
      if (passing >= 8 && r >= 1) break;
    }
    let best = -1;
    let bestD = Infinity;
    for (const c of out) {
      if (ok && !ok(c)) continue;
      const d = metersBetween(pt, this.posOf(c));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  private posRef: LngLat[] = [];
  attach(pos: LngLat[]): NodeGrid {
    this.posRef = pos;
    return this;
  }
  private posOf(i: number): LngLat {
    return this.posRef[i];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario inputs, resolved once
// ─────────────────────────────────────────────────────────────────────────────

interface Corridor {
  name: string;
  capacity: number;
  /**
   * True for the ridge egress system declared in CORRIDOR_CAPACITY. Corridors
   * discovered from the routes themselves (Concow out to Hwy 70) are metered
   * individually but kept OUT of the aggregate denominator: their capacity is
   * not available to Paradise, and pooling it would flatter every utilisation
   * figure and break the 5,100 veh/hr sanity anchor.
   */
  primary: boolean;
  /** Node index where the corridor discharges toward a sink. */
  exitNode: number;
  contraflow: boolean;
  /** Edge ids on this corridor that may carry reversed lanes. */
  contraflowEdgeIds: string[];
  /** Free-flow seconds from the corridor exit to a sink. */
  exitToSink: number;
  tree: OutTree;
}

interface ZonePlanInfo {
  zone: EvacZone;
  /** Network node the zone drains from. */
  node: number;
  peoplePerHousehold: number;
  /** Route to a sink under free-flow routing — what a navigation app returns. */
  selfishRoute: string[];
  selfishCorridor: number;
  selfishTravel: number;
  /** Corridor index -> [route, travelSeconds] when reachable within the detour cap. */
  options: Array<{ corridor: number; route: string[]; travel: number }>;
}

interface Inputs {
  scenario: ScenarioMeta;
  net: RoadNetwork;
  zones: EvacZone[];
  hazard: HazardTrack;
  facilities: Facility[];
  population: PopulationLayer | null;
  graph: Graph;
  edgeById: Map<string, RoadEdge>;
  corridors: Corridor[];
  zoneInfo: ZonePlanInfo[];
  /** edgeId -> frame index at which the fire closes it. */
  closureFrame: Map<string, number>;
  frameCount: number;
  /** Free-flow seconds to a sink per node. Finite == on the egress network. */
  sinkDist: Float64Array;
}

function corridorNameOf(e: RoadEdge | undefined): string | null {
  if (!e?.name) return null;
  return e.name in CORRIDOR_CAPACITY ? e.name : null;
}

function buildInputs(scenarioId: string): Inputs {
  const scenario = getScenario(scenarioId);
  const dir = join(ROOT, "public", "data", scenario.id);

  CORRIDOR_CAPACITY = CORRIDOR_CAPACITY_BY_SCENARIO[scenario.id] ?? {};
  if (Object.keys(CORRIDOR_CAPACITY).length === 0) {
    loudNote(
      `no declared egress corridors for "${scenario.id}" — every corridor will be discovered ` +
        "from the routes and NONE will count toward the aggregate denominator, so mean egress " +
        "utilisation will read 0%. Add the scenario to CORRIDOR_CAPACITY_BY_SCENARIO.",
    );
  }

  const net = requireJson<RoadNetwork>(join(dir, "network.json"), "network.json");
  const zoneLayer = requireJson<ZoneLayer>(join(dir, "zones.json"), "zones.json");
  const hazard = requireJson<HazardTrack>(join(dir, "hazard.json"), "hazard.json");
  const facLayer = readJson<FacilityLayer>(join(dir, "facilities.json"));
  const population = readJson<PopulationLayer>(join(dir, "population.json"));

  if (!facLayer) {
    loudNote(
      "facilities.json missing — bus dispatch will be SKIPPED entirely rather than " +
        "invented. run_planned will carry zero manifests.",
    );
  }
  const facilities = facLayer?.facilities ?? [];
  const zones = zoneLayer.zones;
  const edgeById = new Map(net.edges.map((e) => [e.id, e]));
  const graph = buildGraph(net);

  // Free-flow shortest path to any sink. This IS user-optimal routing: it is the
  // same objective a navigation app minimises, so the tree doubles as the
  // baseline assignment.
  const sinkIds =
    net.sinks.length > 0 ? net.sinks : net.nodes.filter((n) => n.isSink).map((n) => n.id);
  const sinkSeeds: Array<[number, number]> = [];
  for (const sid of sinkIds) {
    const si = graph.index.get(sid);
    if (si !== undefined) sinkSeeds.push([si, 0]);
  }
  if (sinkSeeds.length === 0) {
    console.error("[sim] FATAL: network.json declares no reachable sinks. Nothing to evacuate to.");
    process.exit(1);
  }
  const sinkTree = outTree(graph, sinkSeeds);

  // ── Corridors. Capacity is asserted above and verified against the network.
  const corridorNames = Object.keys(CORRIDOR_CAPACITY);
  const corridors: Corridor[] = [];
  for (const name of corridorNames) {
    const own = net.edges.filter((e) => e.name === name);
    if (own.length === 0) {
      loudNote(`corridor "${name}" has no edges in network.json — DROPPED from the model.`);
      continue;
    }
    const observed = Math.max(...own.map((e) => e.capacity));
    if (observed !== CORRIDOR_CAPACITY[name]) {
      loudNote(
        `corridor "${name}": model uses ${CORRIDOR_CAPACITY[name]} veh/hr, network.json's ` +
          `widest segment carries ${observed} veh/hr. Using the model figure — the widest ` +
          "segment is not necessarily the binding throat.",
      );
    }
    // The exit is the corridor node closest to a sink in free-flow time; that
    // throat is where the queue forms, so it is the right place to meter.
    let exitNode = -1;
    let exitCost = Infinity;
    for (const e of own) {
      for (const nid of [e.from, e.to]) {
        const ni = graph.index.get(nid);
        if (ni === undefined) continue;
        if (sinkTree.dist[ni] < exitCost) {
          exitCost = sinkTree.dist[ni];
          exitNode = ni;
        }
      }
    }
    if (exitNode < 0 || !Number.isFinite(exitCost)) {
      loudNote(`corridor "${name}" cannot reach any sink in the extract — DROPPED from the model.`);
      continue;
    }
    const cfIds = own.filter((e) => e.contraflowEligible).map((e) => e.id);
    corridors.push({
      name,
      capacity: CORRIDOR_CAPACITY[name],
      primary: true,
      exitNode,
      contraflow: cfIds.length > 0,
      contraflowEdgeIds: cfIds,
      exitToSink: exitCost,
      tree: outTree(graph, [[exitNode, exitCost]], sinkTree),
    });
  }

  // ── Zones. Snap, route, and enumerate the corridors each zone can reach.
  const grid = new NodeGrid(graph.nodePos).attach(graph.nodePos);
  const zoneInfo: ZonePlanInfo[] = [];
  const offNetwork: string[] = [];
  const extraCorridors = new Map<string, string[]>();

  for (const zone of zones) {
    let node = -1;
    if (zone.primaryRouteEdgeIds.length > 0) {
      const first = edgeById.get(zone.primaryRouteEdgeIds[0]);
      if (first) node = graph.index.get(first.from) ?? -1;
    }
    if (node < 0) {
      node = grid.nearest(
        zone.centroid,
        (i) => Number.isFinite(sinkTree.dist[i]) && sinkTree.succEdge[i] >= 0,
      );
    }
    const pph = zone.households > 0 ? zone.population / zone.households : 0;

    const selfishRoute = node >= 0 ? walkOut(graph, sinkTree, node) : [];
    const selfishTravel =
      node >= 0 && Number.isFinite(sinkTree.dist[node]) ? sinkTree.dist[node] : Infinity;

    // Which named corridor does the free-flow route actually use? Take the LAST
    // one on the path: that is the throat it exits through, not one it crosses.
    let selfishCorridor = -1;
    for (const id of selfishRoute) {
      const cn = corridorNameOf(edgeById.get(id));
      if (cn === null) continue;
      const ci = corridors.findIndex((c) => c.name === cn);
      if (ci >= 0) selfishCorridor = ci;
    }

    if (selfishRoute.length === 0 || !Number.isFinite(selfishTravel)) {
      if (zone.households > 0) offNetwork.push(zone.id);
    } else if (selfishCorridor < 0 && zone.households > 0) {
      // Real egress path that is not one of the five ridge corridors — Concow Rd
      // out to Hwy 70, for example. Not synthesis: capacity comes from the road
      // itself. Keyed by terminal edge id because these roads are often unnamed
      // in OSM, and dropping them would strand real households.
      const termId = selfishRoute[selfishRoute.length - 1];
      if (!extraCorridors.has(termId)) extraCorridors.set(termId, selfishRoute);
    }

    const options: Array<{ corridor: number; route: string[]; travel: number }> = [];
    if (node >= 0) {
      for (let ci = 0; ci < corridors.length; ci++) {
        const t = corridors[ci].tree;
        if (!Number.isFinite(t.dist[node]) || t.succEdge[node] < 0) continue;
        if (t.dist[node] - selfishTravel > MAX_DETOUR_SECONDS) continue;
        options.push({ corridor: ci, route: walkOut(graph, t, node), travel: t.dist[node] });
      }
    }
    zoneInfo.push({
      zone,
      node,
      peoplePerHousehold: pph,
      selfishRoute,
      selfishCorridor,
      selfishTravel,
      options,
    });
  }

  // Corridors discovered from the routes themselves get appended so those zones
  // are metered against a real capacity instead of being dropped.
  const extraByTerminal = new Map<string, number>();
  for (const [termId, route] of extraCorridors) {
    const term = edgeById.get(termId);
    if (!term) continue;
    const exitNode = graph.index.get(term.to) ?? graph.index.get(term.from) ?? -1;
    if (exitNode < 0 || !Number.isFinite(sinkTree.dist[exitNode])) continue;
    // Label it after the last road on the route that OSM actually names, so the
    // release table reads "Concow Road" rather than a way id.
    let label = term.name ?? "";
    if (!label) {
      for (let i = route.length - 1; i >= 0; i--) {
        const nm = edgeById.get(route[i])?.name;
        if (nm) {
          label = `${nm} (onward)`;
          break;
        }
      }
    }
    if (!label) label = `${term.roadClass} ${termId}`;
    log(
      `added egress corridor "${label}" at ${term.capacity} veh/hr (capacity read from network.json)`,
    );
    extraByTerminal.set(termId, corridors.length);
    corridors.push({
      name: label,
      capacity: term.capacity,
      primary: false,
      exitNode,
      contraflow: false,
      contraflowEdgeIds: term.contraflowEligible ? [term.id] : [],
      exitToSink: sinkTree.dist[exitNode],
      tree: outTree(graph, [[exitNode, sinkTree.dist[exitNode]]], sinkTree),
    });
  }

  // Second pass: zones that fell through now bind to the corridor their route
  // terminates on.
  for (const zi of zoneInfo) {
    if (zi.selfishCorridor >= 0 || zi.selfishRoute.length === 0) continue;
    const ci = extraByTerminal.get(zi.selfishRoute[zi.selfishRoute.length - 1]);
    if (ci === undefined) continue;
    zi.selfishCorridor = ci;
    if (!zi.options.some((o) => o.corridor === ci)) {
      zi.options.push({ corridor: ci, route: zi.selfishRoute, travel: zi.selfishTravel });
    }
  }

  const stranded = zoneInfo.filter((z) => z.zone.households > 0 && z.selfishCorridor < 0);
  if (stranded.length > 0) {
    loudNote(
      `${stranded.length} populated zones have no routable egress corridor in this extract ` +
        `(${stranded.map((z) => z.zone.id).join(", ")}). Their ` +
        `${stranded.reduce((a, z) => a + z.zone.households, 0)} households are counted as ` +
        `UNASSIGNED in every run rather than given an invented road.`,
    );
  }
  if (offNetwork.length > 0) {
    log(
      `${offNetwork.length} populated zones could not be snapped to the road graph: ${offNetwork.join(", ")}`,
    );
  }

  // ── Hazard closures, indexed by frame.
  const frameCount = Math.floor(scenario.duration / scenario.frameStep) + 1;
  const closureFrame = new Map<string, number>();
  for (const f of hazard.frames) {
    const fi = Math.round(f.t / scenario.frameStep);
    for (const id of f.closedEdgeIds) {
      const prev = closureFrame.get(id);
      if (prev === undefined || fi < prev) closureFrame.set(id, fi);
    }
  }

  return {
    scenario,
    net,
    zones,
    hazard,
    facilities,
    population,
    graph,
    edgeById,
    corridors,
    zoneInfo,
    closureFrame,
    frameCount,
    sinkDist: sinkTree.dist,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Demand
// ─────────────────────────────────────────────────────────────────────────────

interface ZoneDemand {
  zi: ZonePlanInfo;
  corridor: number;
  route: string[];
  travel: number;
  /** Vehicles released at the zone's wave time. */
  orderedVehicles: number;
  /** Vehicles that leave at T+0 without being ordered — shadow evacuation. */
  shadowVehicles: number;
  departAt: Tick;
  wave: number;
  peoplePerVehicle: number;
  routeLength: number;
}

/**
 * Vehicles a zone puts on the road.
 *
 * Ordered demand is `households * compliance * vehiclesPerHousehold` at the
 * zone's release time. Shadow demand is `households * shadowEvac *
 * vehiclesPerHousehold` at T+0, and only exists for zones that are NOT ordered
 * at T+0 — which is precisely the cost of staging: the people you did not call
 * leave anyway, and they leave immediately. The baseline orders everyone at once
 * so its shadow demand is structurally zero.
 *
 * The pair is capped at the zone's households: a household cannot evacuate twice.
 */
function zoneVehicles(zone: EvacZone, params: RunParams): { ordered: number; shadow: number } {
  const hh = zone.households;
  if (hh <= 0) return { ordered: 0, shadow: 0 };
  const ordered = hh * params.compliance;
  // Shadow demand is unconditional. Anyone who would leave without being told
  // also leaves when told, so a blanket order cannot produce LESS departure
  // than a staged one. Making this conditional on the wave made the baseline
  // move 72% of households while the plan moved ~90%, and the headline delta
  // was then comparing two different evacuations. Staging changes WHEN ordered
  // demand is released, never how many people set out.
  const shadow = hh * params.shadowEvac;
  const total = ordered + shadow;
  const scale = total > hh ? hh / total : 1;
  return {
    ordered: ordered * scale * params.vehiclesPerHousehold,
    shadow: shadow * scale * params.vehiclesPerHousehold,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assignment + wave planning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BASELINE assignment: every zone takes the individually fastest road. That is
 * what a navigation app returns and what Paradise actually did. It ignores the
 * fact that the fastest road for 6,000 households is a 900 veh/hr road.
 */
function assignSelfish(
  inputs: Inputs,
): Map<string, { corridor: number; route: string[]; travel: number }> {
  const out = new Map<string, { corridor: number; route: string[]; travel: number }>();
  for (const zi of inputs.zoneInfo) {
    if (zi.selfishCorridor < 0) continue;
    out.set(zi.zone.id, {
      corridor: zi.selfishCorridor,
      route: zi.selfishRoute,
      travel: zi.selfishTravel,
    });
  }
  return out;
}

/**
 * PLANNED assignment: system-optimal. Largest zones placed first onto whichever
 * reachable corridor currently has the lowest projected hours-of-queue, subject
 * to the detour cap. This is the single lever that turns 7 hours into 3.
 */
function assignBalanced(
  inputs: Inputs,
  params: RunParams,
): Map<string, { corridor: number; route: string[]; travel: number }> {
  const capOf = (ci: number): number =>
    inputs.corridors[ci].capacity * (params.contraflow && inputs.corridors[ci].contraflow ? 2 : 1);
  const loaded = new Float64Array(inputs.corridors.length);
  const order = [...inputs.zoneInfo]
    .filter((z) => z.options.length > 0 && z.zone.households > 0)
    .sort((a, b) => b.zone.households - a.zone.households);

  const out = new Map<string, { corridor: number; route: string[]; travel: number }>();
  for (const zi of order) {
    const v = zi.zone.households * params.compliance * params.vehiclesPerHousehold;
    let best = zi.options[0];
    let bestCost = Infinity;
    for (const opt of zi.options) {
      const hours = (loaded[opt.corridor] + v) / Math.max(capOf(opt.corridor), 1);
      // Queue hours dominate; the detour only breaks ties between corridors that
      // are equally loaded.
      const cost = hours + (opt.travel - zi.selfishTravel) / 3600;
      if (cost < bestCost) {
        bestCost = cost;
        best = opt;
      }
    }
    loaded[best.corridor] += v;
    out.set(zi.zone.id, { corridor: best.corridor, route: best.route, travel: best.travel });
  }
  // Zero-household zones still need an assignment so the release table covers
  // every zone the county would have to order.
  for (const zi of inputs.zoneInfo) {
    if (out.has(zi.zone.id)) continue;
    if (zi.options.length > 0) {
      out.set(zi.zone.id, zi.options[0]);
    } else if (zi.selfishCorridor >= 0) {
      out.set(zi.zone.id, {
        corridor: zi.selfishCorridor,
        route: zi.selfishRoute,
        travel: zi.selfishTravel,
      });
    }
  }
  return out;
}

/**
 * Stage the releases. Zones go in hazard-ETA order — the zone that burns first
 * leaves first — and each is dropped into the earliest wave whose corridor stays
 * under WAVE_LOAD_TARGET of capacity for that wave's window. A zone whose hazard
 * ETA arrives before that slot is pulled forward anyway: congestion is
 * recoverable, being overtaken by the fire is not.
 */
function planWaves(
  inputs: Inputs,
  params: RunParams,
  assignment: Map<string, { corridor: number; route: string[]; travel: number }>,
): Map<string, { wave: number; departAt: Tick; forced: boolean }> {
  const out = new Map<string, { wave: number; departAt: Tick; forced: boolean }>();
  if (!params.staged) {
    for (const zi of inputs.zoneInfo) out.set(zi.zone.id, { wave: 0, departAt: 0, forced: false });
    return out;
  }

  const capOf = (ci: number): number =>
    inputs.corridors[ci].capacity * (params.contraflow && inputs.corridors[ci].contraflow ? 2 : 1);
  const perWave = (ci: number): number => (capOf(ci) * WAVE_SPACING) / 3600;
  const load = new Map<string, number>();
  const keyOf = (ci: number, w: number): string => `${ci}:${w}`;

  const ordered = [...inputs.zoneInfo].sort(
    (a, b) => a.zone.hazardEta - b.zone.hazardEta || b.zone.households - a.zone.households,
  );

  for (const zi of ordered) {
    const asg = assignment.get(zi.zone.id);
    if (!asg) {
      out.set(zi.zone.id, { wave: 0, departAt: params.noticeTime, forced: false });
      continue;
    }
    const v = zi.zone.households * params.compliance * params.vehiclesPerHousehold;
    const budget = perWave(asg.corridor) * WAVE_LOAD_TARGET;

    let w = 0;
    for (; w < 64; w++) {
      const k = keyOf(asg.corridor, w);
      const cur = load.get(k) ?? 0;
      // A zone bigger than a whole wave budget still has to go somewhere; it
      // takes an empty wave alone rather than being split.
      if (cur === 0 || cur + v <= budget) break;
    }

    let departAt = params.noticeTime + w * WAVE_SPACING;
    let forced = false;
    const latest = zi.zone.hazardEta - HAZARD_MARGIN;
    if (departAt > latest) {
      departAt = Math.max(0, Math.min(departAt, latest));
      // Snap back onto the wave lattice so the release table stays readable.
      w = Math.max(0, Math.floor((departAt - params.noticeTime) / WAVE_SPACING));
      departAt = Math.max(0, params.noticeTime + w * WAVE_SPACING);
      if (departAt > latest) departAt = Math.max(0, latest);
      forced = true;
    }
    load.set(keyOf(asg.corridor, w), (load.get(keyOf(asg.corridor, w)) ?? 0) + v);
    out.set(zi.zone.id, { wave: w, departAt, forced });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The solver
// ─────────────────────────────────────────────────────────────────────────────

interface SolveResult {
  demands: ZoneDemand[];
  /** [zoneIdx][frame] cumulative vehicles served past the corridor throat. */
  servedByZone: Float64Array[];
  /** [zoneIdx][frame] vehicles departed but not yet served — the queue. */
  queuedByZone: Float64Array[];
  /** [zoneIdx][frame] departed and still driving toward the back of the queue. */
  inTransitByZone: Float64Array[];
  /** [zoneIdx][frame] cumulative vehicles that have reached a sink. */
  clearedByZone: Float64Array[];
  /** [corridorIdx][frame] vehicles served in that frame. */
  servedFlow: Float64Array[];
  contraflowAt: Tick | null;
  totalVehicles: number;
  unroutedVehicles: number;
  unroutedPeople: number;
}

function solve(
  inputs: Inputs,
  params: RunParams,
  assignment: Map<string, { corridor: number; route: string[]; travel: number }>,
  waves: Map<string, { wave: number; departAt: Tick; forced: boolean }>,
): SolveResult {
  const { scenario, corridors, edgeById, frameCount } = inputs;
  const step = scenario.frameStep;

  const demands: ZoneDemand[] = [];
  let unroutedVehicles = 0;
  let unroutedPeople = 0;

  for (const zi of inputs.zoneInfo) {
    const w = waves.get(zi.zone.id) ?? { wave: 0, departAt: params.noticeTime, forced: false };
    const { ordered, shadow } = zoneVehicles(zi.zone, params);
    const asg = assignment.get(zi.zone.id);
    const perVeh =
      params.vehiclesPerHousehold > 0 ? zi.peoplePerHousehold / params.vehiclesPerHousehold : 0;
    if (!asg || ordered + shadow === 0) {
      if (ordered + shadow > 0) {
        unroutedVehicles += ordered + shadow;
        unroutedPeople += (ordered + shadow) * perVeh;
      }
      demands.push({
        zi,
        corridor: -1,
        route: zi.selfishRoute,
        travel: zi.selfishTravel,
        orderedVehicles: ordered,
        shadowVehicles: shadow,
        departAt: params.staged ? w.departAt : 0,
        wave: w.wave,
        peoplePerVehicle: perVeh,
        routeLength: 0,
      });
      continue;
    }
    let routeLength = 0;
    for (const id of asg.route) routeLength += edgeById.get(id)?.length ?? 0;
    demands.push({
      zi,
      corridor: asg.corridor,
      route: asg.route,
      travel: asg.travel,
      orderedVehicles: ordered,
      shadowVehicles: shadow,
      // The baseline is the counterfactual's mirror: everybody goes at once, at
      // T+0. BASELINE_PARAMS.noticeTime is intentionally not consulted here —
      // the real orders came in staggered and late, so an instantaneous T+0
      // release is GENEROUS to what Paradise actually got.
      departAt: params.staged ? w.departAt : 0,
      wave: w.wave,
      peoplePerVehicle: perVeh,
      routeLength,
    });
  }

  // FIFO queues per corridor: whoever departed first is served first.
  const order: number[][] = corridors.map(() => []);
  for (let i = 0; i < demands.length; i++) {
    if (demands[i].corridor >= 0) order[demands[i].corridor].push(i);
  }
  for (const list of order) {
    list.sort((a, b) => demands[a].departAt - demands[b].departAt);
  }

  const servedByZone = demands.map(() => new Float64Array(frameCount));
  const queuedByZone = demands.map(() => new Float64Array(frameCount));
  const inTransitByZone = demands.map(() => new Float64Array(frameCount));
  const departedByZone = demands.map(() => new Float64Array(frameCount));
  const clearedByZone = demands.map(() => new Float64Array(frameCount));
  const servedFlow = corridors.map(() => new Float64Array(frameCount));

  const remaining = demands.map(() => 0);
  const servedCum = demands.map(() => 0);
  const contraflowAt = params.contraflow ? Math.max(0, params.noticeTime) : null;

  for (let f = 0; f < frameCount; f++) {
    const t = f * step;
    // Release: shadow demand at T+0, ordered demand at the wave time.
    for (let i = 0; i < demands.length; i++) {
      const d = demands[i];
      if (t === 0) remaining[i] += d.shadowVehicles;
      if (d.departAt >= t && d.departAt < t + step) remaining[i] += d.orderedVehicles;
      else if (t === 0 && d.departAt < 0) remaining[i] += d.orderedVehicles;
    }

    for (let ci = 0; ci < corridors.length; ci++) {
      const c = corridors[ci];
      const cfActive = contraflowAt !== null && c.contraflow && t >= contraflowAt;
      let budget = (c.capacity * (cfActive ? 2 : 1) * step) / 3600;
      for (const i of order[ci]) {
        if (budget <= 1e-9) break;
        if (remaining[i] <= 1e-9) continue;
        const take = Math.min(remaining[i], budget);
        remaining[i] -= take;
        budget -= take;
        servedCum[i] += take;
        servedFlow[ci][f] += take;
      }
    }

    for (let i = 0; i < demands.length; i++) {
      servedByZone[i][f] = servedCum[i];
      queuedByZone[i][f] = remaining[i];
      departedByZone[i][f] = servedCum[i] + remaining[i];
    }
  }

  // A vehicle is not standing in the queue the instant it leaves the driveway —
  // it has to drive to the back of the line first. Splitting departed traffic
  // into "still driving" and "stopped at the throat" is what stops the baseline
  // from reporting a 44 km standing queue at T+0, before anyone has moved.
  for (let i = 0; i < demands.length; i++) {
    const lag = Number.isFinite(demands[i].travel) ? Math.round(demands[i].travel / step) : 0;
    for (let f = 0; f < frameCount; f++) {
      const atThroat = f - lag >= 0 ? departedByZone[i][f - lag] : 0;
      const stopped = Math.max(0, Math.min(queuedByZone[i][f], atThroat - servedByZone[i][f]));
      inTransitByZone[i][f] = Math.max(0, queuedByZone[i][f] - stopped);
      queuedByZone[i][f] = stopped;
    }
  }

  // A served vehicle has passed the corridor throat but has not arrived yet.
  // Shift its arrival by that zone's free-flow travel time.
  for (let i = 0; i < demands.length; i++) {
    const lag = Number.isFinite(demands[i].travel) ? Math.round(demands[i].travel / step) : 0;
    for (let f = 0; f < frameCount; f++) {
      clearedByZone[i][f] = f - lag >= 0 ? servedByZone[i][f - lag] : 0;
    }
  }

  const totalVehicles = demands.reduce((a, d) => a + d.orderedVehicles + d.shadowVehicles, 0);
  return {
    demands,
    servedByZone,
    queuedByZone,
    inTransitByZone,
    clearedByZone,
    servedFlow,
    contraflowAt,
    totalVehicles,
    unroutedVehicles,
    unroutedPeople,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frames — queue laid back along real route geometry so it renders and so
// exposure can be read off hazard.json's closed edges.
// ─────────────────────────────────────────────────────────────────────────────

interface FrameResult {
  frames: RunFrame[];
  summary: RunSummary;
  clearanceTime: Tick;
  peakQueueMeters: number;
}

function buildFrames(inputs: Inputs, params: RunParams, res: SolveResult): FrameResult {
  const { scenario, edgeById, corridors, closureFrame, frameCount } = inputs;
  const step = scenario.frameStep;
  const burnFrame = Math.round(scenario.burnoverAt / step);

  // Storage in vehicles per edge, and the route walked from the throat backwards
  // — a queue grows upstream from the bottleneck, not downstream from the house.
  const reversedRoute = res.demands.map((d) => [...d.route].reverse());
  const storageOf = (id: string): number =>
    Math.max(1, (edgeById.get(id)?.length ?? 0) / VEH_LENGTH_M);

  const frames: RunFrame[] = [];
  let peakQueueMeters = 0;
  let vehiclesInHazardAtBurnover = 0;
  let peopleInHazardAtBurnover = 0;
  let utilSum = 0;
  let utilFrames = 0;
  let clearanceTime = 0;

  // Utilisation is measured against the capacity actually in service, so a
  // contraflowed corridor is judged on its doubled capacity, not its base.
  const activeCapAt = (t: Tick): number =>
    corridors.reduce(
      (a, c) =>
        a +
        (c.primary
          ? c.capacity *
            (res.contraflowAt !== null && c.contraflow && t >= res.contraflowAt ? 2 : 1)
          : 0),
      0,
    );

  let prevCleared = 0;

  for (let f = 0; f < frameCount; f++) {
    const t = f * step;
    const edgeLoad: Record<string, number> = {};
    const zoneRemaining: Record<string, number> = {};
    const zoneStatus: Record<string, ZoneStatus> = {};
    let vehiclesMoving = 0;
    let vehiclesCleared = 0;
    let vehiclesInHazard = 0;
    let peopleCleared = 0;
    let peopleInHazard = 0;
    const corridorQueue = new Float64Array(corridors.length);

    for (let i = 0; i < res.demands.length; i++) {
      const d = res.demands[i];
      const zone = d.zi.zone;
      const total = d.orderedVehicles + d.shadowVehicles;
      const served = res.servedByZone[i][f];
      const queued = res.queuedByZone[i][f];
      const inTransit = res.inTransitByZone[i][f];
      const cleared = res.clearedByZone[i][f];
      const undeparted = Math.max(0, total - served - queued - inTransit);

      vehiclesCleared += cleared;
      peopleCleared += cleared * d.peoplePerVehicle;
      vehiclesMoving += Math.max(0, served - cleared) + queued + inTransit;

      // Households still in the zone: everyone who has not passed the throat,
      // expressed back in households. Non-participating households are not
      // counted here — they were never in the evacuating population.
      const stillIn =
        params.vehiclesPerHousehold > 0
          ? (queued + inTransit + undeparted) / params.vehiclesPerHousehold
          : 0;
      zoneRemaining[zone.id] = Math.round(stillIn);

      // ── Lay the queue back along the route and read exposure off the closures.
      let placed = 0;
      let onClosed = 0;
      if (queued > 0.01 && d.route.length > 0) {
        const rr = reversedRoute[i];
        for (const id of rr) {
          if (placed >= queued) break;
          const cap = storageOf(id);
          const put = Math.min(cap, queued - placed);
          placed += put;
          const cf = closureFrame.get(id);
          if (cf !== undefined && cf <= f) onClosed += put;
          const occ = Math.min(1.6, put / cap);
          edgeLoad[id] = Math.min(1.6, (edgeLoad[id] ?? 0) + occ);
        }
        // Anything the route cannot physically hold is still sitting in the zone.
        onClosed += Math.max(0, queued - placed) * (t >= zone.hazardEta ? 1 : 0);
      }
      if (d.corridor >= 0) corridorQueue[d.corridor] += queued;

      // Vehicles that have not departed, and those still driving out of the
      // zone toward the queue, are in the zone; once the fire arrives there,
      // they are in the hazard.
      const undepartedExposed = t >= zone.hazardEta ? undeparted + inTransit : 0;
      const exposed = onClosed + undepartedExposed;
      vehiclesInHazard += exposed;
      peopleInHazard += exposed * d.peoplePerVehicle;

      // Status.
      let status: ZoneStatus;
      if (total <= 0) {
        status = t >= zone.hazardEta ? "cutoff" : "held";
      } else if (queued + inTransit + undeparted <= 0.5) {
        status = "cleared";
      } else if (exposed > 0.5) {
        status = "cutoff";
      } else if (served > 0.5 || queued > 0.5 || inTransit > 0.5) {
        status = "flowing";
      } else if (t >= d.departAt) {
        status = "ordered";
      } else {
        status = "held";
      }
      zoneStatus[zone.id] = status;
    }

    // Moving traffic still colours the road even when nothing is queued.
    for (let ci = 0; ci < corridors.length; ci++) {
      const flow = res.servedFlow[ci][f];
      if (flow <= 0) continue;
      const util = Math.min(1, flow / ((corridors[ci].capacity * step) / 3600));
      for (const id of corridors[ci].contraflowEdgeIds) {
        edgeLoad[id] = Math.max(edgeLoad[id] ?? 0, util * 0.9);
      }
    }
    for (const k of Object.keys(edgeLoad)) {
      const v = Math.round(edgeLoad[k] * 100) / 100;
      if (v < 0.02) delete edgeLoad[k];
      else edgeLoad[k] = v;
    }

    const frameFlow = res.servedFlow.reduce(
      (a, arr, ci) => a + (corridors[ci].primary ? arr[f] : 0),
      0,
    );
    if (frameFlow > 0) {
      utilSum += Math.min(1, frameFlow / ((activeCapAt(t) * step) / 3600));
      utilFrames++;
    }

    // The standing line on the worst corridor, in metres. Not capped at the
    // corridor's own length: past that point the queue is backed into the feeder
    // streets behind it, which is exactly what "gridlock" describes.
    let frameQueueMeters = 0;
    for (const q of corridorQueue) frameQueueMeters = Math.max(frameQueueMeters, q * VEH_LENGTH_M);

    // Clearance is the last moment anyone actually arrives, not the end of the
    // simulated window.
    if (vehiclesCleared > prevCleared + 0.5) clearanceTime = t;
    prevCleared = vehiclesCleared;

    if (f === burnFrame) {
      vehiclesInHazardAtBurnover = vehiclesInHazard;
      peopleInHazardAtBurnover = peopleInHazard;
    }

    peakQueueMeters = Math.max(peakQueueMeters, frameQueueMeters);
    frames.push({
      t,
      edgeLoad,
      zoneRemaining,
      zoneStatus,
      vehiclesMoving: Math.round(vehiclesMoving),
      vehiclesCleared: Math.round(vehiclesCleared),
      vehiclesInHazard: Math.round(vehiclesInHazard),
      peopleCleared: Math.round(peopleCleared),
      peakQueueLength: Math.round(frameQueueMeters),
    });
  }

  const last = frames[frames.length - 1];
  const evacPeople = res.demands.reduce(
    (a, d) => a + (d.orderedVehicles + d.shadowVehicles) * d.peoplePerVehicle,
    0,
  );
  const totalEvacuated = last.peopleCleared;
  const summary: RunSummary = {
    clearanceTime,
    vehiclesInHazardAtBurnover: Math.round(vehiclesInHazardAtBurnover),
    peopleInHazardAtBurnover: Math.round(peopleInHazardAtBurnover),
    peakQueueLength: Math.round(peakQueueMeters),
    totalEvacuated: Math.round(totalEvacuated),
    // People who set out to evacuate and never reached a sink inside the
    // scenario window, plus those whose zone has no routable corridor at all.
    unassigned: Math.max(0, Math.round(evacPeople - totalEvacuated)),
    meanEgressUtilization: utilFrames > 0 ? Math.round((utilSum / utilFrames) * 1000) / 1000 : 0,
  };
  return { frames, summary, clearanceTime, peakQueueMeters };
}

/** Grid-node solve: the same arithmetic with no frames, no geometry, no trips. */
function summarize(
  inputs: Inputs,
  params: RunParams,
  assignment: Map<string, { corridor: number; route: string[]; travel: number }>,
): RunSummary {
  const waves = planWaves(inputs, params, assignment);
  const res = solve(inputs, params, assignment, waves);
  return buildFrames(inputs, params, res).summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan artefacts: waves, contraflow orders, manifests
// ─────────────────────────────────────────────────────────────────────────────

function buildWaves(inputs: Inputs, params: RunParams, res: SolveResult): ReleaseWave[] {
  const byWave = new Map<number, ZoneDemand[]>();
  for (const d of res.demands) {
    const list = byWave.get(d.wave);
    if (list) list.push(d);
    else byWave.set(d.wave, [d]);
  }

  // The binding wave is the one whose last vehicle passes the throat last.
  let bindingWave = -1;
  let bindingAt = -1;
  let bindingZone = "";
  for (let i = 0; i < res.demands.length; i++) {
    const total = res.demands[i].orderedVehicles + res.demands[i].shadowVehicles;
    // A zone with no routable corridor never drains, so it would win this
    // search forever. It is reported as unassigned, not as the binding wave.
    if (total <= 0 || res.demands[i].corridor < 0) continue;
    const q = res.queuedByZone[i];
    let done = -1;
    for (let f = q.length - 1; f >= 0; f--) {
      if (q[f] > 0.5) {
        done = (f + 1) * inputs.scenario.frameStep;
        break;
      }
    }
    if (done > bindingAt) {
      bindingAt = done;
      bindingWave = res.demands[i].wave;
      bindingZone = res.demands[i].zi.zone.id;
    }
  }

  const waves: ReleaseWave[] = [];
  for (const [w, list] of [...byWave.entries()].sort((a, b) => a[0] - b[0])) {
    const departAt = Math.min(...list.map((d) => d.departAt));
    const vehicles = list.reduce((a, d) => a + d.orderedVehicles + d.shadowVehicles, 0);
    const corridorSet = new Map<number, number>();
    for (const d of list) {
      if (d.corridor < 0) continue;
      corridorSet.set(
        d.corridor,
        (corridorSet.get(d.corridor) ?? 0) + d.orderedVehicles + d.shadowVehicles,
      );
    }
    let bindingCorridor = -1;
    let worst = -1;
    for (const [ci, v] of corridorSet) {
      const cap =
        inputs.corridors[ci].capacity *
        (params.contraflow && inputs.corridors[ci].contraflow ? 2 : 1);
      const frac = v / ((cap * WAVE_SPACING) / 3600);
      if (frac > worst) {
        worst = frac;
        bindingCorridor = ci;
      }
    }
    const routeLabel =
      [...corridorSet.keys()]
        .sort((a, b) => (corridorSet.get(b) ?? 0) - (corridorSet.get(a) ?? 0))
        .map((ci) => inputs.corridors[ci].name)
        .slice(0, 3)
        .join(" + ") || "no routable corridor";

    const forced = list.filter(
      (d) => d.zi.zone.hazardEta - HAZARD_MARGIN <= d.departAt && d.zi.zone.households > 0,
    );
    const hazardEta = Math.min(...list.map((d) => d.zi.zone.hazardEta));
    const isBinding = w === bindingWave;

    let rationale: string;
    if (!params.staged) {
      rationale =
        "No staging. Every zone is ordered at T+0 and every driver takes their individually " +
        "fastest road, so the corridors load in proportion to convenience rather than capacity.";
    } else if (forced.length > 0) {
      rationale =
        `Released against corridor congestion: ${forced.length} zone(s) here have the fire ` +
        `arriving at T+${fmtHrs(hazardEta)}, which leaves no later slot. Queueing is recoverable; ` +
        `being overtaken is not.`;
    } else if (worst > WAVE_LOAD_TARGET) {
      rationale =
        `${inputs.corridors[bindingCorridor]?.name ?? "The corridor"} is loaded to ` +
        `${Math.round(worst * 100)}% of one ${WAVE_SPACING / 60}-minute window — above the ` +
        `${Math.round(WAVE_LOAD_TARGET * 100)}% target, because a single zone here is larger than ` +
        `one wave's budget and is released whole rather than split. It drains over the following ` +
        `waves, which is why the corridor stays busy after this one departs.`;
    } else if (isBinding) {
      rationale =
        `Loads ${inputs.corridors[bindingCorridor]?.name ?? "the corridor"} to ` +
        `${Math.round(worst * 100)}% of its ${WAVE_SPACING / 60}-minute capacity. This wave is the ` +
        `one that pins total clearance — pulling it earlier only moves the queue upstream.`;
    } else {
      rationale =
        `Earliest wave where ${inputs.corridors[bindingCorridor]?.name ?? "the corridor"} stays at ` +
        `${Math.round(worst * 100)}% of capacity, under the ${Math.round(WAVE_LOAD_TARGET * 100)}% target.`;
    }

    waves.push({
      wave: w,
      departAt,
      zoneIds: list.map((d) => d.zi.zone.id),
      households: list.reduce((a, d) => a + d.zi.zone.households, 0),
      noVehicleHouseholds: list.reduce((a, d) => a + d.zi.zone.noVehicleHouseholds, 0),
      routeLabel,
      egressLoad: Math.round(Math.max(0, worst) * 1000) / 1000,
      hazardEta,
      ...(isBinding ? { binding: true } : {}),
      rationale: isBinding
        ? `${rationale} Last vehicle clears at T+${fmtHrs(bindingAt)} out of ${bindingZone}.`
        : rationale,
    });
    void vehicles;
  }
  return waves;
}

function buildContraflow(
  inputs: Inputs,
  params: RunParams,
  res: SolveResult,
  clearance: Tick,
): ContraflowOrder[] {
  if (!params.contraflow || res.contraflowAt === null) return [];
  const orders: ContraflowOrder[] = [];
  const used = new Set<number>();
  for (const d of res.demands) {
    if (d.corridor >= 0 && d.orderedVehicles + d.shadowVehicles > 0) used.add(d.corridor);
  }
  for (let ci = 0; ci < inputs.corridors.length; ci++) {
    const c = inputs.corridors[ci];
    if (!c.contraflow || !used.has(ci)) continue;
    orders.push({
      edgeIds: c.contraflowEdgeIds,
      label: `${c.name} — reverse the inbound lanes`,
      activateAt: res.contraflowAt,
      releaseAt: Math.min(inputs.scenario.duration, clearance + WAVE_SPACING),
      capacityBefore: c.capacity,
      capacityAfter: c.capacity * 2,
    });
  }
  return orders;
}

interface PathResult {
  path: LngLat[];
  seconds: number;
}

/** Snap-to-snap free-flow path, used for bus legs. */
function routeBetween(
  g: Graph,
  cache: Map<number, { dist: Float64Array; prevNode: Int32Array; prevEdge: Int32Array }>,
  from: number,
  to: number,
): PathResult | null {
  if (from < 0 || to < 0) return null;
  let tree = cache.get(from);
  if (!tree) {
    tree = forwardTree(g, from);
    cache.set(from, tree);
  }
  if (!Number.isFinite(tree.dist[to])) return null;
  const edges: number[] = [];
  /* The node each edge is ENTERED from. Edge geometry is stored once, running
     e.from -> e.to, but a shortest path may walk a two-way edge either way.
     Appending it forward regardless teleports the leg to the far end and the
     displacement compounds over every later edge — it put 26% of dispatch route
     metres on no road at all. */
  const entryNodes: number[] = [];
  let cur = to;
  let guard = 0;
  while (cur !== from && tree.prevEdge[cur] >= 0 && guard++ < 20000) {
    edges.push(tree.prevEdge[cur]);
    entryNodes.push(tree.prevNode[cur]);
    cur = tree.prevNode[cur];
  }
  edges.reverse();
  entryNodes.reverse();
  const path: LngLat[] = [g.nodePos[from]];
  for (let i = 0; i < edges.length; i++) {
    const e = g.edges[edges[i]];
    const forward = g.index.get(e.from) === entryNodes[i];
    const geom = forward ? e.geometry : [...e.geometry].reverse();
    for (let k = 1; k < geom.length; k++) path.push(geom[k]);
  }
  return {
    path: path.length > 1 ? path : [g.nodePos[from], g.nodePos[to]],
    seconds: tree.dist[to],
  };
}

function timestampsAlong(path: LngLat[], startAt: Tick, seconds: number): Tick[] {
  const dists: number[] = [0];
  for (let i = 1; i < path.length; i++)
    dists.push(dists[i - 1] + metersBetween(path[i - 1], path[i]));
  const total = dists[dists.length - 1] || 1;
  return dists.map((d) => Math.round(startAt + (d / total) * seconds));
}

function buildManifests(inputs: Inputs, params: RunParams, _res: SolveResult): VehicleManifest[] {
  if (!params.busDispatch) return [];
  const { graph, facilities, scenario, sinkDist } = inputs;
  if (facilities.length === 0) return [];

  const grid = new NodeGrid(graph.nodePos).attach(graph.nodePos);
  const nodeOf = new Map<string, number>();
  const snap = (p: LngLat): number => {
    const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const hit = nodeOf.get(k);
    if (hit !== undefined) return hit;
    // Facilities and muster points routinely sit just outside the OSM extract —
    // Chico depots to the west, upper Magalia to the north. Snapping to the
    // nearest node that can still reach a sink puts the bus on the road network
    // instead of on an orphaned service-road fragment it can never leave.
    const n = grid.nearest(p, (i) => Number.isFinite(sinkDist[i]));
    nodeOf.set(k, n);
    return n;
  };

  const origins = facilities
    .filter((f) => DISPATCH_ORIGINS.includes(f.kind) && f.assets.bus > 0)
    .map((f) => ({ f, left: f.assets.bus }));
  const medics = facilities
    .filter((f) => f.kind === "ems" || f.kind === "fire_station" || f.kind === "hospital")
    .filter((f) => f.assets.ambulance > 0)
    .map((f) => ({ f, left: f.assets.ambulance }));
  // facilities.json carries no atRiskFrom for any shelter, so derive it from the
  // hazard footprint: the first frame whose rings contain the shelter is the
  // moment it stops being a destination. Without this, buses out of Concow drop
  // their passengers in Magalia — which burns.
  const shelterRisk = new Map<string, Tick>();
  for (const f of facilities) {
    if (f.kind !== "shelter") continue;
    if (f.atRiskFrom !== undefined) {
      shelterRisk.set(f.id, f.atRiskFrom);
      continue;
    }
    for (const frame of inputs.hazard.frames) {
      if (frame.rings.length > 0 && pointInRings(f.position, frame.rings)) {
        shelterRisk.set(f.id, frame.t);
        break;
      }
    }
  }
  const shelters = facilities
    .filter((f) => f.kind === "shelter" && f.capacity > 0)
    .map((f) => ({
      f,
      left: f.capacity,
      riskAt: shelterRisk.get(f.id) ?? Number.POSITIVE_INFINITY,
    }));
  const burned = shelters.filter((s) => Number.isFinite(s.riskAt));
  if (burned.length > 0) {
    log(
      `${burned.length}/${shelters.length} shelters are inside the fire footprint at some point ` +
        `(earliest T+${fmtHrs(Math.min(...burned.map((s) => s.riskAt)))}) and are withdrawn as ` +
        `destinations once it reaches them`,
    );
  }

  if (origins.length === 0 || shelters.length === 0) {
    loudNote(
      `bus dispatch requested but facilities.json has ${origins.length} bus origins and ` +
        `${shelters.length} shelters — dispatch SKIPPED rather than invented.`,
    );
    return [];
  }

  const pathCache = new Map<
    number,
    { dist: Float64Array; prevNode: Int32Array; prevEdge: Int32Array }
  >();
  const manifests: VehicleManifest[] = [];
  let busSeq = 0;
  let ambSeq = 0;
  let unmetPeople = 0;
  const unmetByZone = new Map<string, number>();
  const noteUnmet = (zoneId: string, n: number): void => {
    if (n <= 0) return;
    unmetPeople += n;
    unmetByZone.set(zoneId, (unmetByZone.get(zoneId) ?? 0) + n);
  };

  // Pickup points come from real facilities inside the zone — mobile home parks
  // and nursing homes are where the transit-dependent concentrate. A zone with
  // none falls back to its centroid, which is the honest "we don't know where".
  const pickupKinds = new Set(["mobile_home_park", "nursing_home"]);

  const needy = [...inputs.zoneInfo]
    .filter((z) => z.zone.noVehicleHouseholds > 0)
    .sort((a, b) => a.zone.hazardEta - b.zone.hazardEta);

  for (const zi of needy) {
    const zone = zi.zone;
    const people = Math.round(zone.noVehicleHouseholds * zi.peoplePerHousehold);
    if (people <= 0) continue;

    const inZone = facilities.filter(
      (f) => pickupKinds.has(f.kind) && pointInRings(f.position, zone.geometry),
    );
    const points: Array<{ label: string; position: LngLat; medical: string[] }> =
      inZone.length > 0
        ? inZone.map((f) => ({
            label: f.name,
            position: f.position,
            medical: f.kind === "nursing_home" ? ["mobility-limited residents"] : [],
          }))
        : [{ label: `${zone.label} muster point`, position: zone.centroid, medical: [] }];

    const busesNeeded = Math.ceil(people / BUS_SEATS);
    let assignedPeople = 0;
    // A depot the road graph cannot connect to this zone is out for this zone
    // only; without this one bad nearest-depot would starve every bus it needs.
    const blocked = new Set<string>();

    for (let b = 0; b < busesNeeded; b++) {
      const origin = origins
        .filter((o) => o.left > 0 && !blocked.has(o.f.id))
        .sort(
          (a, c) =>
            metersBetween(a.f.position, zone.centroid) - metersBetween(c.f.position, zone.centroid),
        )[0];
      if (!origin) {
        noteUnmet(zone.id, people - assignedPeople);
        break;
      }
      const seats = Math.min(BUS_SEATS, people - assignedPeople);
      if (seats <= 0) break;

      // Nearest-neighbour stop order from the depot.
      const mine = points.filter((_, i) => i % busesNeeded === b);
      const stopPoints = mine.length > 0 ? mine : [points[b % points.length]];
      const ordered: typeof stopPoints = [];
      let cursor = origin.f.position;
      const pool = [...stopPoints];
      while (pool.length > 0) {
        pool.sort((a, c) => metersBetween(cursor, a.position) - metersBetween(cursor, c.position));
        const next = pool.shift() as (typeof stopPoints)[number];
        ordered.push(next);
        cursor = next.position;
      }

      // Buses roll the moment the order is drafted — transit-dependent pickup is
      // the longest pole in any evacuation, so it does not wait for noticeTime.
      let clock: Tick = 0;
      let node = snap(origin.f.position);
      const path: LngLat[] = [];
      const timestamps: Tick[] = [];
      const stops: PickupStop[] = [];
      let ok = true;

      const pushLeg = (leg: PathResult | null, target: LngLat): void => {
        if (!leg) {
          ok = false;
          return;
        }
        const ts = timestampsAlong(leg.path, clock, leg.seconds);
        const startIdx = path.length === 0 ? 0 : 1;
        for (let i = startIdx; i < leg.path.length; i++) {
          path.push(leg.path[i]);
          timestamps.push(ts[i]);
        }
        clock = ts[ts.length - 1] ?? clock;
        void target;
      };

      for (let s = 0; s < ordered.length; s++) {
        const target = snap(ordered[s].position);
        pushLeg(routeBetween(graph, pathCache, node, target), ordered[s].position);
        if (!ok) break;
        node = target;
        const share = Math.round(seats / ordered.length);
        stops.push({
          seq: s + 1,
          label: ordered[s].label,
          position: ordered[s].position,
          passengers: s === ordered.length - 1 ? seats - share * (ordered.length - 1) : share,
          // No wheelchair or medical-need field exists in any source we fetched.
          // Reported as zero/empty because it is unknown, not because it is zero.
          wheelchair: 0,
          medicalNotes: ordered[s].medical,
          arriveAt: clock,
        });
        clock += STOP_DWELL;
        if (timestamps.length > 0) timestamps[timestamps.length - 1] = clock;
      }
      if (!ok || stops.length === 0) {
        blocked.add(origin.f.id);
        b--;
        continue;
      }

      // Nearest SAFE shelter the bus can actually drive to. The nearest one by
      // straight line is often across a branch of the network the road graph
      // cannot connect (Forest Ranch sits up Hwy 32, outside this extract), so
      // fall through the ranking instead of failing the whole zone on it.
      const candidates = shelters
        .filter((s) => s.left > 0 && s.riskAt > clock + SHELTER_SAFETY_MARGIN)
        .sort((a, c) => metersBetween(a.f.position, cursor) - metersBetween(c.f.position, cursor));
      let shelter: (typeof candidates)[number] | undefined;
      for (const cand of candidates.slice(0, 12)) {
        const leg = routeBetween(graph, pathCache, node, snap(cand.f.position));
        if (!leg) continue;
        pushLeg(leg, cand.f.position);
        shelter = cand;
        break;
      }
      if (!shelter || !ok) {
        blocked.add(origin.f.id);
        b--;
        continue;
      }

      origin.left -= 1;
      shelter.left -= seats;
      assignedPeople += seats;
      manifests.push({
        id: `bus-${String(++busSeq).padStart(3, "0")}`,
        kind: "bus",
        originFacilityId: origin.f.id,
        originLabel: origin.f.name,
        seats,
        wheelchairSlots: 0,
        assignedZoneIds: [zone.id],
        stops,
        dropFacilityId: shelter.f.id,
        dropLabel: shelter.f.name,
        dropAt: clock,
        slack: zone.hazardEta - clock,
        path,
        timestamps,
      });
    }

    // Ambulances for the medically dependent: nursing homes get a dedicated
    // vehicle, because a bus cannot carry a gurney.
    for (const nh of inZone.filter((f) => f.kind === "nursing_home")) {
      const medic = medics
        .filter((m) => m.left > 0)
        .sort(
          (a, c) =>
            metersBetween(a.f.position, nh.position) - metersBetween(c.f.position, nh.position),
        )[0];
      if (!medic) break;
      const start = snap(medic.f.position);
      const at = snap(nh.position);
      const legIn = routeBetween(graph, pathCache, start, at);
      if (!legIn) continue;
      let clock = legIn.seconds + STOP_DWELL;
      const medCandidates = shelters
        .filter((s) => s.left > 0 && s.riskAt > clock + SHELTER_SAFETY_MARGIN)
        .sort(
          (a, c) =>
            metersBetween(a.f.position, nh.position) - metersBetween(c.f.position, nh.position),
        );
      let shelter: (typeof medCandidates)[number] | undefined;
      let legOut: PathResult | null = null;
      for (const cand of medCandidates.slice(0, 12)) {
        legOut = routeBetween(graph, pathCache, at, snap(cand.f.position));
        if (legOut) {
          shelter = cand;
          break;
        }
      }
      if (!shelter || !legOut) continue;
      const path = [...legIn.path, ...legOut.path.slice(1)];
      const tsIn = timestampsAlong(legIn.path, 0, legIn.seconds);
      const tsOut = timestampsAlong(legOut.path, clock, legOut.seconds);
      const timestamps = [...tsIn, ...tsOut.slice(1)];
      clock = timestamps[timestamps.length - 1];
      medic.left -= 1;
      shelter.left -= AMBULANCE_SEATS;
      manifests.push({
        id: `amb-${String(++ambSeq).padStart(3, "0")}`,
        kind: "ambulance",
        originFacilityId: medic.f.id,
        originLabel: medic.f.name,
        seats: AMBULANCE_SEATS,
        wheelchairSlots: AMBULANCE_SEATS,
        assignedZoneIds: [zone.id],
        stops: [
          {
            seq: 1,
            label: nh.name,
            position: nh.position,
            passengers: AMBULANCE_SEATS,
            wheelchair: AMBULANCE_SEATS,
            medicalNotes: ["gurney transfer", "continuous care en route"],
            arriveAt: Math.round(legIn.seconds),
          },
        ],
        dropFacilityId: shelter.f.id,
        dropLabel: shelter.f.name,
        dropAt: Math.round(clock),
        slack: zone.hazardEta - Math.round(clock),
        path,
        timestamps,
      });
    }
  }

  if (unmetPeople > 0) {
    loudNote(
      `${Math.round(unmetPeople)} transit-dependent people could not be matched to a bus, a route, ` +
        `or a shelter bed with the fleet in facilities.json. They are reported unmet, not covered. ` +
        `Zones affected: ${[...unmetByZone.entries()].map(([z, n]) => `${z} ${Math.round(n)}`).join(", ")}`,
    );
  }
  void scenario;
  return manifests;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trips for deck.gl TripsLayer
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG — reruns must produce byte-identical payloads. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function routeGeometry(inputs: Inputs, route: string[]): LngLat[] {
  const pts: LngLat[] = [];
  for (const id of route) {
    const e = inputs.edgeById.get(id);
    if (!e || e.geometry.length === 0) continue;
    /* Same reversal trap as routeBetween, but only edge ids are available here,
       so direction is inferred from geometry: whichever end of this edge is
       nearer the path tail is the end we entered by. Without this the trip path
       zigzags to the far end of every backward-traversed edge and back. */
    let geom = e.geometry;
    const tail = pts[pts.length - 1];
    if (tail) {
      const head = geom[0];
      const foot = geom[geom.length - 1];
      const dHead = (tail[0] - head[0]) ** 2 + (tail[1] - head[1]) ** 2;
      const dFoot = (tail[0] - foot[0]) ** 2 + (tail[1] - foot[1]) ** 2;
      if (dFoot < dHead) geom = [...geom].reverse();
    }
    for (const p of geom) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
  }
  if (pts.length <= TRIP_PATH_POINTS) return pts;
  const out: LngLat[] = [];
  const stride = (pts.length - 1) / (TRIP_PATH_POINTS - 1);
  for (let i = 0; i < TRIP_PATH_POINTS; i++) out.push(pts[Math.round(i * stride)]);
  return out;
}

function buildTrips(inputs: Inputs, res: SolveResult, manifests: VehicleManifest[]): Trip[] {
  const rand = mulberry32(0xe6_7e_55);
  const step = inputs.scenario.frameStep;
  const trips: Trip[] = [];

  for (let i = 0; i < res.demands.length; i++) {
    const d = res.demands[i];
    const total = d.orderedVehicles + d.shadowVehicles;
    if (total < 1 || d.route.length === 0) continue;
    const base = routeGeometry(inputs, d.route);
    if (base.length < 2) continue;

    const count = Math.max(1, Math.round(total / VEHICLES_PER_TRIP));
    const weight = total / count;
    const served = res.servedByZone[i];

    for (let k = 0; k < count; k++) {
      // Each rendered trip stands for the (k+0.5)/count quantile of this zone's
      // vehicles, so its departure and its journey time come from where that
      // quantile actually sat in the queue.
      const target = ((k + 0.5) / count) * total;
      let f = 0;
      while (f < served.length - 1 && served[f] < target) f++;
      const throatAt = f * step;
      const departAt = Math.min(throatAt, d.departAt + rand() * 300);
      const arriveAt = throatAt + (Number.isFinite(d.travel) ? d.travel : 600);
      const duration = Math.max(180, arriveAt - departAt);

      // Lateral jitter only — the point COUNT must survive so path and
      // timestamps stay index-aligned for TripsLayer.
      const jitterLng = (rand() - 0.5) * 0.00022;
      const jitterLat = (rand() - 0.5) * 0.00022;
      const path: LngLat[] = base.map((p, idx) =>
        idx === 0 || idx === base.length - 1 ? p : ([p[0] + jitterLng, p[1] + jitterLat] as LngLat),
      );
      const ts = timestampsAlong(path, Math.round(departAt), Math.round(duration));
      trips.push({
        path: path.map(
          (p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6] as LngLat,
        ),
        timestamps: ts,
        zoneId: d.zi.zone.id,
        weight: Math.round(weight * 10) / 10,
        kind: "household",
      });
    }
  }

  for (const m of manifests) {
    if (m.path.length < 2) continue;
    const stride =
      m.path.length > TRIP_PATH_POINTS ? (m.path.length - 1) / (TRIP_PATH_POINTS - 1) : 1;
    const path: LngLat[] = [];
    const timestamps: Tick[] = [];
    if (stride === 1) {
      path.push(...m.path);
      timestamps.push(...m.timestamps);
    } else {
      for (let i = 0; i < TRIP_PATH_POINTS; i++) {
        const idx = Math.round(i * stride);
        path.push(m.path[idx]);
        timestamps.push(m.timestamps[idx] ?? m.dropAt);
      }
    }
    trips.push({
      path: path.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6] as LngLat),
      timestamps,
      zoneId: m.assignedZoneIds[0] ?? "",
      weight: m.seats,
      kind: m.kind === "ambulance" ? "ambulance" : "bus",
    });
  }
  return trips;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────────────────────

interface BuiltRun {
  run: SimulationRun;
  res: SolveResult;
}

function buildRun(inputs: Inputs, kind: RunKind, params: RunParams): BuiltRun {
  const assignment = kind === "baseline" ? assignSelfish(inputs) : assignBalanced(inputs, params);
  const waves = planWaves(inputs, params, assignment);
  const res = solve(inputs, params, assignment, waves);
  const framed = buildFrames(inputs, params, res);
  const manifests = buildManifests(inputs, params, res);
  const releaseWaves = buildWaves(inputs, params, res);
  const contraflow = buildContraflow(inputs, params, res, framed.clearanceTime);
  const trips = buildTrips(inputs, res, manifests);

  const plan: EvacPlan = {
    scenarioId: inputs.scenario.id,
    kind,
    waves: releaseWaves,
    contraflow,
    manifests,
    revision: 1,
    generatedAt: new Date().toISOString(),
  };

  return {
    run: {
      scenarioId: inputs.scenario.id,
      kind,
      params,
      plan,
      frames: framed.frames,
      trips,
      summary: framed.summary,
      generatedAt: new Date().toISOString(),
    },
    res,
  };
}

/**
 * The observed record, stated at the precision it actually exists at.
 *
 * No jurisdiction publishes an audited "clearance time" for either of these
 * events, so each entry reports a RANGE midpoint and says so. Inventing a
 * decimal here would be the one thing that ends the project in Q&A.
 *
 * Paradise: Cal Fire's and the Butte County Sheriff's after-action accounts
 * describe an evacuation running from roughly 08:00 through the afternoon of
 * 8 Nov 2018, with vehicles abandoned on Skyway and fatalities in vehicles.
 *
 * Pacific Palisades: the hour bounds are anchored to the archived IPAWS record
 * (research/snapshots/ipaws-palisades-2025-01-07.json) rather than to a
 * narrative — the first order lands 1h22m after ignition and orders are still
 * being issued across the footprint at 16:42 PST, 6h12m in, so the movement was
 * demonstrably still running then. Neither bound is a measured clearance.
 */
interface ObservedRecord {
  narrative: string;
  lowHours: number;
  highHours: number;
  /** How this scenario's hazard payload biases the run, in its own terms. */
  modelCaveat: string;
}

const OBSERVED: Record<string, ObservedRecord> = {
  "camp-fire-2018": {
    narrative:
      "Paradise, 8 November 2018. Evacuation of roughly 26,000 people over about four viable " +
      "egress routes ran for most of the day; drivers abandoned vehicles on Skyway and moved on " +
      "foot, and people died in vehicles on the egress roads. No audited clearance time was ever " +
      "published for the event.",
    lowHours: 6,
    highHours: 10,
    modelCaveat:
      "hazard.json's fire progression between ignition and the single observed perimeter is " +
      "interpolated, and it closes the egress corridors harder and earlier than the real fire " +
      "did — exposure figures inherit that.",
  },
  "palisades-fire-2025": {
    narrative:
      "Pacific Palisades, 7 January 2025. The fire was reported at 10:30 PST; the Los Angeles " +
      "Fire Department issued a single evacuation order covering the whole Palisades at 12:07 " +
      "PST, 97 minutes later. Los Angeles held the community in one Genasys zone — LOS-Q0767, " +
      "19,634 acres, 30,447 people — so there were no sub-zones to release in sequence. " +
      "Contemporaneous reporting describes vehicles abandoned on Palisades Drive and pushed " +
      "aside by a bulldozer to reopen the road for fire apparatus. No audited clearance time " +
      "was published.",
    lowHours: 4,
    highHours: 8,
    modelCaveat:
      "The bias runs the OTHER way here. The only archived perimeter is the final 23,448-acre " +
      "extent, 20 hours past the end of the replay, so every in-window frame is a modelled " +
      "wind-run fill, growing to roughly 240 acres by 12:22 PST and 4,000 by 18:00. No archived " +
      "record of the acreage AT those hours exists to check it against — contemporaneous press " +
      "reporting of the first afternoon is several times larger, but that is not a retrieved " +
      "figure and is not asserted here. Treat the early frames as a lower bound on the fire: " +
      "exposure and cut-off figures on this scenario are OPTIMISTIC, and a modelled baseline " +
      "that clears before the fire arrives should be read as the model failing to catch the " +
      "fire up, not as the roads having been adequate.",
  },
};

function validationFor(
  scenarioId: string,
  modeled: Tick,
  note: string,
): NonNullable<SimulationRun["validation"]> | undefined {
  const rec = OBSERVED[scenarioId];
  if (!rec) {
    loudNote(
      `no observed record for "${scenarioId}" — run_baseline.json ships WITHOUT a validation ` +
        "block rather than borrowing another scenario's. Add it to OBSERVED.",
    );
    return undefined;
  }
  return {
    observedNarrative: rec.narrative,
    modeledClearance: modeled,
    observedClearanceApprox: Math.round(((rec.lowHours + rec.highHours) / 2) * 3600),
    note:
      `APPROXIMATE. Contemporaneous accounts put the evacuation at roughly ${rec.lowHours}-${rec.highHours} ` +
      `hours; the midpoint is reported here and no finer figure is claimed. ${note} ${rec.modelCaveat}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter sweep
// ─────────────────────────────────────────────────────────────────────────────

function buildGrid(inputs: Inputs): ParamGrid {
  const entries: Record<string, RunSummary> = {};
  const t0 = Date.now();
  let n = 0;
  for (const compliance of PARAM_AXES.compliance) {
    for (const shadowEvac of PARAM_AXES.shadowEvac) {
      for (const noticeTime of PARAM_AXES.noticeTime) {
        for (const vehiclesPerHousehold of PARAM_AXES.vehiclesPerHousehold) {
          const params: RunParams = {
            ...DEFAULT_PARAMS,
            compliance,
            shadowEvac,
            noticeTime,
            vehiclesPerHousehold,
          };
          // The assignment depends on compliance and vehicles per household, so
          // it is recomputed per node rather than reused from the headline run.
          const assignment = assignBalanced(inputs, params);
          entries[`${compliance}|${shadowEvac}|${noticeTime}|${vehiclesPerHousehold}`] = summarize(
            inputs,
            params,
            assignment,
          );
          n++;
        }
      }
    }
  }
  log(`param grid: ${n} nodes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    scenarioId: inputs.scenario.id,
    axes: {
      compliance: [...PARAM_AXES.compliance],
      shadowEvac: [...PARAM_AXES.shadowEvac],
      noticeTime: [...PARAM_AXES.noticeTime],
      vehiclesPerHousehold: [...PARAM_AXES.vehiclesPerHousehold],
    },
    entries,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function closedForm(inputs: Inputs, res: SolveResult, contraflow: boolean): string {
  const veh = res.demands.reduce(
    (a, d) =>
      a +
      (d.corridor >= 0 && inputs.corridors[d.corridor].primary
        ? d.orderedVehicles + d.shadowVehicles
        : 0),
    0,
  );
  const capTotal = inputs.corridors.reduce(
    (a, c) => a + (c.primary ? c.capacity * (contraflow && c.contraflow ? 2 : 1) : 0),
    0,
  );
  const perCorridor = new Float64Array(inputs.corridors.length);
  for (const d of res.demands) {
    if (d.corridor >= 0) perCorridor[d.corridor] += d.orderedVehicles + d.shadowVehicles;
  }
  let worst = 0;
  let worstName = "-";
  for (let ci = 0; ci < inputs.corridors.length; ci++) {
    const c = inputs.corridors[ci];
    const cap = c.capacity * (contraflow && c.contraflow ? 2 : 1);
    const h = perCorridor[ci] / cap;
    if (h > worst) {
      worst = h;
      worstName = c.name;
    }
  }
  return (
    `${veh.toFixed(0)} veh | perfectly distributed ${(veh / capTotal).toFixed(2)} h | ` +
    `as assigned, binding corridor ${worstName} ${worst.toFixed(2)} h`
  );
}

function main(): void {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const inputs = buildInputs(scenarioId);
  const dir = join(ROOT, "public", "data", inputs.scenario.id);
  mkdirSync(dir, { recursive: true });

  log(`${inputs.scenario.name} — ${inputs.zones.length} zones, ${inputs.net.edges.length} edges`);
  log(
    `corridors: ${inputs.corridors.map((c) => `${c.name} ${c.capacity}${c.contraflow ? "*" : ""}`).join(", ")} ` +
      `(* = contraflow eligible; ridge total ${inputs.corridors.reduce(
        (a, c) => a + (c.primary ? c.capacity : 0),
        0,
      )} veh/hr)`,
  );
  const totalHh = inputs.zones.reduce((a, z) => a + z.households, 0);
  const totalNv = inputs.zones.reduce((a, z) => a + z.noVehicleHouseholds, 0);
  log(
    `demand basis: ${totalHh} households, ${totalNv} of them with no vehicle (read from zones.json)`,
  );
  if (inputs.population) {
    log(
      `population.json cross-check: ${inputs.population.totals.households} households countywide, ` +
        `${inputs.population.totals.noVehicleHouseholds} no-vehicle`,
    );
  }

  const baseline = buildRun(inputs, "baseline", BASELINE_PARAMS);
  const planned = buildRun(inputs, "planned", DEFAULT_PARAMS);

  baseline.run.validation = validationFor(
    inputs.scenario.id,
    baseline.run.summary.clearanceTime,
    "The modelled baseline releases every zone instantaneously at T+0, which is GENEROUS: the real " +
      "orders were staggered and late. It also omits crash and abandoned-vehicle blockage, which " +
      "occurred. Both biases make the model optimistic, so the observed event should sit at or " +
      "beyond the modelled figure. Closed edges are counted for exposure but are not used to gate " +
      "throughput: gating would deadlock the run once the footprint reaches the corridor throats.",
  );

  const grid = buildGrid(inputs);

  const outBase = join(dir, "run_baseline.json");
  const outPlan = join(dir, "run_planned.json");
  const outGrid = join(dir, "param_grid.json");
  writeFileSync(outBase, JSON.stringify(baseline.run));
  writeFileSync(outPlan, JSON.stringify(planned.run));
  writeFileSync(outGrid, JSON.stringify(grid));

  // ── The comparison IS the product.
  const b = baseline.run.summary;
  const p = planned.run.summary;
  const row = (label: string, x: string, y: string): string =>
    `  ${label.padEnd(30)} ${x.padStart(14)}   ${y.padStart(14)}`;
  console.log("");
  console.log(`  ${"".padEnd(30)} ${"BASELINE".padStart(14)}   ${"PLANNED".padStart(14)}`);
  console.log(`  ${"".padEnd(30)} ${"─".repeat(14)}   ${"─".repeat(14)}`);
  console.log(row("clearance time", fmtHrs(b.clearanceTime), fmtHrs(p.clearanceTime)));
  console.log(
    row(
      `vehicles in hazard @ T+${fmtHrs(inputs.scenario.burnoverAt)}`,
      b.vehiclesInHazardAtBurnover.toLocaleString(),
      p.vehiclesInHazardAtBurnover.toLocaleString(),
    ),
  );
  console.log(
    row(
      "people in hazard at burnover",
      b.peopleInHazardAtBurnover.toLocaleString(),
      p.peopleInHazardAtBurnover.toLocaleString(),
    ),
  );
  console.log(
    row(
      "peak standing queue",
      `${(b.peakQueueLength / 1000).toFixed(1)} km`,
      `${(p.peakQueueLength / 1000).toFixed(1)} km`,
    ),
  );
  console.log(
    row(
      "vehicles released",
      Math.round(baseline.res.totalVehicles).toLocaleString(),
      Math.round(planned.res.totalVehicles).toLocaleString(),
    ),
  );
  console.log(
    row("people evacuated", b.totalEvacuated.toLocaleString(), p.totalEvacuated.toLocaleString()),
  );
  console.log(
    row("people not out by end", b.unassigned.toLocaleString(), p.unassigned.toLocaleString()),
  );
  console.log(
    row(
      "mean egress utilisation",
      `${(b.meanEgressUtilization * 100).toFixed(0)}%`,
      `${(p.meanEgressUtilization * 100).toFixed(0)}%`,
    ),
  );
  console.log("");
  /* Both runs must move the same people or the headline delta is comparing two
     different evacuations. Assert it here rather than trusting it: this exact
     invariant broke once already, when shadow demand was made conditional on
     the release wave and the baseline quietly evacuated 18% fewer households
     than the plan it was being measured against. */
  const vehGap = Math.abs(planned.res.totalVehicles - baseline.res.totalVehicles);
  if (vehGap > 1) {
    throw new Error(
      `demand mismatch: baseline releases ${Math.round(baseline.res.totalVehicles)} vehicles, ` +
        `planned releases ${Math.round(planned.res.totalVehicles)}. Both runs must serve the same ` +
        `population — staging changes WHEN demand is released, never how much of it there is.`,
    );
  }
  log(
    `both runs release the same ${Math.round(baseline.res.totalVehicles).toLocaleString()} vehicles — ` +
      `${DEFAULT_PARAMS.compliance * 100}% ordered compliance plus ${DEFAULT_PARAMS.shadowEvac * 100}% who ` +
      `leave unprompted. The clearance gap is timing and routing, not a lighter baseline.`,
  );
  log(`closed-form check, baseline: ${closedForm(inputs, baseline.res, false)}`);
  log(`closed-form check, planned:  ${closedForm(inputs, planned.res, true)}`);
  console.log("");
  log(
    `run_baseline.json ${mbOf(outBase)} — ${baseline.run.frames.length} frames, ${baseline.run.trips.length} trips`,
  );
  log(
    `run_planned.json  ${mbOf(outPlan)} — ${planned.run.frames.length} frames, ${planned.run.trips.length} trips, ` +
      `${planned.run.plan.waves.length} waves, ${planned.run.plan.contraflow.length} contraflow orders, ` +
      `${planned.run.plan.manifests.length} manifests`,
  );
  log(`param_grid.json   ${mbOf(outGrid)} — ${Object.keys(grid.entries).length} nodes`);
  void loud;
}

main();

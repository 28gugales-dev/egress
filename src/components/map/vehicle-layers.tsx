"use client";

import type { Color, Layer, PickingInfo } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { useEffect, useState } from "react";
import {
  casingIcon,
  glyphIcon,
  glyphScale,
  type VehicleAtlas,
  type VehicleGlyph,
  vehicleAtlas,
} from "@/components/map/vehicle-icons";
import { HAZARD_RGB, PLAN_RGB, WARN_RGB, ZONE_STATUS_RGB } from "@/lib/constants";
import { type FacilityExposure, facilityExposure } from "@/lib/derive";
import { clamp, formatCount, formatShort, formatTick } from "@/lib/format";
import { actions } from "@/lib/store";
import type {
  EvacPlan,
  EvacZone,
  Facility,
  FacilityKind,
  FacilityLayer,
  HazardTrack,
  LayerVisibility,
  LngLat,
  PickupStop,
  RoadNetwork,
  Selection,
  Tick,
  VehicleManifest,
  ZoneLayer,
} from "@/types/egress";

/**
 * Dispatched vehicles, moving.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * `bus-arcs` in deck-layers.tsx draws one flat ArcLayer chord per manifest,
 * depot to zone centroid, for as long as the manifest is live. That is a
 * diagram of intent: it shows that a bus was assigned, not where it is, not
 * which roads it is on, and not whether it will get there before the fire. The
 * layers here put the fleet on its real routed geometry and move it with the
 * playhead. Both stacks read the same `layers.busArcs` toggle — no new
 * LayerVisibility key is invented here, because that key lives in store.ts.
 *
 * ── Integration point ───────────────────────────────────────────────────────
 *
 * Same contract as ./context-layers.tsx and ./detail-layers.tsx, so the wiring
 * inside `DeckOverlay` is four lines. See the report / module footer.
 *
 * ── Engines are not dispatched, and this module refuses to pretend they are ──
 *
 * facilities.json stables 64 fire engines across 32 fire stations on
 * camp-fire-2018. run_planned.json dispatches 79 manifests and not one of them
 * is an engine — 76 buses and 3 ambulances, and the type union in
 * `VehicleManifest` has no `engine` member at all. Engines are suppression and
 * rescue assets; the solver moves evacuation transport.
 *
 * So there is no engine puck driving anywhere on this map. Inventing engine
 * missions to get something fire-truck-shaped moving would be exactly the
 * silent synthesis CLAUDE.md forbids — a number, and a vehicle, nobody could
 * trace back to a payload. Instead engines are drawn as what they actually
 * are: parked inventory at a station, carrying their count, coloured by whether
 * the modelled fire footprint reaches that station and when. Eight of the
 * thirty-two stations fall inside the perimeter on this scenario, which puts
 * sixteen of the sixty-four engines inside the fire. That is a real finding
 * and it is worth a mark; a fake convoy is not.
 *
 * ── Honesty ─────────────────────────────────────────────────────────────────
 *
 * NOTHING here is observed. There is no AVL feed, no GPS, no telemetry. A puck
 * is the deterministic solver's own answer to "where would this vehicle be at
 * T+x if it drove the plan at free-flow speed", interpolated between the
 * timestamps `scripts/simulate.ts` wrote onto the manifest. The inspection card
 * says so in words, the tooltip says so in a row, and `useVehicleState` logs it
 * once per scenario. If this ever gets a real feed, the provenance string is
 * the thing that has to change first.
 *
 * ── Performance ─────────────────────────────────────────────────────────────
 *
 * The scrubber writes `t` at 30fps and these are the only layers on the map
 * that are SUPPOSED to change every frame. So the split is:
 *
 *   once per plan   route geometry, cumulative distances, dwell keyframes,
 *                   ordered road names, per-stop hazard slack  → `fleetFor`,
 *                   WeakMap-cached on the EvacPlan object.
 *   per frame       a binary search and one lerp per live vehicle. 79 vehicles
 *                   in camp-fire-2018; the whole per-frame cost is under a
 *                   thousand float ops.
 *
 * The faint route web is the one array here that does NOT want to churn, so it
 * is cached against the live set bucketed to the simulation frame step.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/** A vehicle appears this long before it rolls, so a staged fleet reads as
 *  staged rather than materialising out of nothing. */
const STAGE_LEAD: Tick = 600;

/** And lingers this long at its drop, so the arrival is legible at 60x before
 *  the puck clears. Dispatch in camp-fire-2018 completes at T+02:17 against a
 *  12h run; after that the map is honestly empty of vehicles. */
const ARRIVED_LINGER: Tick = 1800;

/** Faint-route membership is re-derived on this cadence, not every frame. Same
 *  step the simulation frames use, so the web is never a frame stale. */
const ROUTE_BUCKET: Tick = 300;

/** Scenario seconds per breath of the at-risk ring. At the default 60x
 *  playback this is a two-second pulse; when playback is paused it holds, which
 *  is correct — an instrument should not animate a frozen clock. */
const PULSE_PERIOD: Tick = 120;

/** Coordinate key precision for matching a path segment back to its road. The
 *  pipeline snaps at 5dp, so this is the tolerance that already exists. */
const KEY_DP = 5;

/** Below this the run has no room to absorb a re-route. Mirrors the field rule
 *  the teams tab already states. */
export const SLACK_WARN: Tick = 1200;

/** Rendered glyph height in pixels at the smallest and largest seat counts.
 *  The bus body fills ~85% of the cell, so 34 draws a coach about 27px long —
 *  the top of the "reads at a glance, does not swamp the street" band. */
const GLYPH_MIN_PX = 19;
const GLYPH_MAX_PX = 34;

/** Parked engines never scale with a passenger count, so they get one size. */
const ENGINE_PX = 25;

/** Below this the map is a region overview and 32 stencilled numerals beside 32
 *  station glyphs is noise. The glyph itself still draws. */
const ENGINE_COUNT_ZOOM = 12;

/** Used when a caller does not supply a camera zoom. Equals `glyphScale`'s
 *  reference zoom, so the glyphs come out at exactly their authored size —
 *  the only defensible guess when the camera is unknown. */
const DEFAULT_ZOOM = 15;

const NEUTRAL_RGB = ZONE_STATUS_RGB.held;
const OK_RGB = ZONE_STATUS_RGB.cleared;

/**
 * Manifest kind to silhouette.
 *
 * `paratransit` shares the bus body deliberately: it is a seated transport run
 * in the contract and in the solver, and minting a third silhouette for a kind
 * that never appears in any payload on disk would be drawing a distinction the
 * data does not make.
 */
function glyphFor(kind: VehicleManifest["kind"]): VehicleGlyph {
  return kind === "ambulance" ? "ambulance" : "bus";
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase
// ─────────────────────────────────────────────────────────────────────────────

export type VehiclePhase = "staged" | "to_pickup" | "loading" | "to_shelter" | "arrived";

export const VEHICLE_PHASE_LABEL: Record<VehiclePhase, string> = {
  staged: "Staged",
  to_pickup: "Running to pickup",
  loading: "Loading",
  to_shelter: "Running to shelter",
  arrived: "Arrived",
};

/**
 * Phase colours, drawn only from the sanctioned palette in lib/constants.ts.
 *
 *   held grey   nothing has happened yet
 *   warn amber  the vehicle is carrying an unmet need — running at people who
 *               cannot leave on their own, or stopped with the door open
 *   plan cyan   the need is aboard and moving, which is the plan working
 *   cleared     delivered
 *
 * `hazard` is not in this table on purpose: it is not a phase, it is an
 * override, and it wins over every entry here.
 */
const PHASE_RGB: Record<VehiclePhase, readonly [number, number, number]> = {
  staged: NEUTRAL_RGB,
  to_pickup: WARN_RGB,
  loading: WARN_RGB,
  to_shelter: PLAN_RGB,
  arrived: OK_RGB,
};

// ─────────────────────────────────────────────────────────────────────────────
// Precomputed route
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleStopWindow {
  stop: PickupStop;
  /** Where the ROAD is at this stop. The muster point itself can sit a little
   *  off the network; the vehicle is on the network. */
  roadPosition: LngLat;
  arriveAt: Tick;
  /**
   * When the vehicle rolls again. Equal to `arriveAt` for ambulances: their
   * dwell is folded into the outgoing leg by the pipeline and cannot be
   * recovered from the payload, so it is reported as zero rather than invented.
   */
  departAt: Tick;
  /** Hazard ETA at the zone this stop serves, minus arrival. Negative means the
   *  fire is modelled to get there first. */
  slack: Tick;
}

export interface VehicleRoadLeg {
  /** Position in the route. A route can re-enter the same road, so the name
   *  alone is not an identity and a render index is not data. */
  seq: number;
  name: string;
  metres: number;
}

export interface VehicleRoute {
  manifest: VehicleManifest;
  /** Dwell-expanded vertices: a stop contributes the same point twice, once at
   *  arrival and once at departure, so a loading vehicle simply stands still
   *  and the runtime needs no special case. */
  points: LngLat[];
  /** Tick at each vertex. Non-decreasing, index-aligned with `points`. */
  times: Float64Array;
  /** Cumulative metres at each vertex. Index-aligned with `points`. */
  cum: Float64Array;
  totalM: number;
  departAt: Tick;
  /** Last timestamp on the route. Equals `manifest.dropAt` on a well-formed
   *  payload; taken from the geometry so a truncated one cannot lie. */
  endAt: Tick;
  stops: VehicleStopWindow[];
  /** Ordered named roads, consecutive repeats collapsed. */
  roads: VehicleRoadLeg[];
  /** Fraction of route metres carrying a road name. */
  roadCoverage: number;
  /**
   * Metres of this route that lie on NO edge of the network — straight chords
   * between points the plan's own geometry never joined. See
   * `warnAboutGeometry`. Rendered as-is, because rewriting the solver's output
   * at draw time would make the picture something other than the plan.
   */
  offNetworkM: number;
  /** Earliest hazard ETA across the zones this vehicle serves. -1 when unknown. */
  hazardEta: Tick;
  /** Hazard ETA minus the LAST pickup arrival. The "can we even reach them"
   *  number, distinct from `manifest.slack`, which measures the drop. */
  pickupSlack: Tick;
  /** True when the plan cannot get this vehicle where it is going in time. */
  atRisk: boolean;
}

export interface VehicleFleet {
  routes: VehicleRoute[];
  byId: Map<string, VehicleRoute>;
  /** Vehicles the plan cannot deliver ahead of the hazard. */
  atRisk: VehicleRoute[];
  /** Set when a manifest carried no usable geometry and was dropped. */
  dropped: string[];
  /** Fleet-wide share of route metres that lie on no network edge. Zero on a
   *  healthy plan; see `warnAboutGeometry`. */
  offNetworkShare: number;
}

const EMPTY_FLEET: VehicleFleet = {
  routes: [],
  byId: new Map(),
  atRisk: [],
  dropped: [],
  offNetworkShare: 0,
};

/** Above this the manifest polylines are not a drivable route and the map is
 *  showing chords, so the console has to say so out loud. */
const OFF_NETWORK_ALARM = 0.02;

const geometryWarned = new WeakSet<EvacPlan>();

/**
 * Shout when the plan's own vehicle geometry is discontinuous.
 *
 * This module renders `manifest.path` exactly as `scripts/simulate.ts` wrote
 * it. It does not smooth it, snap it or re-route it — a vehicle track that gets
 * repaired at draw time is no longer the deterministic solver's answer, and the
 * whole argument for this console is that the answer is traceable.
 *
 * So when the path is not actually on the road network, the honest move is the
 * one the pipeline scripts already make for a failed fetch: name what is wrong,
 * name where it came from, and let the number be visibly missing rather than
 * quietly invented.
 */
function warnAboutGeometry(plan: EvacPlan, routes: VehicleRoute[], share: number): void {
  if (share < OFF_NETWORK_ALARM || geometryWarned.has(plan)) return;
  geometryWarned.add(plan);
  const worst = [...routes]
    .sort((a, b) => b.offNetworkM - a.offNetworkM)
    .slice(0, 3)
    .map((r) => `${r.manifest.id} ${(r.offNetworkM / 1000).toFixed(1)}km`)
    .join(", ");
  console.warn(
    `[vehicles] ${plan.scenarioId} ${plan.kind}: ${(share * 100).toFixed(1)}% of dispatch route ` +
      `metres lie on NO edge of network.json — the manifest polylines contain straight chords ` +
      `between points the road graph never joined. Worst: ${worst}. ` +
      `Vehicles are drawn on this geometry UNCORRECTED, so they will visibly jump across those ` +
      `chords. Upstream cause: routeBetween() in scripts/simulate.ts appends every edge's ` +
      `geometry with geom.slice(1) regardless of travel direction, so a two-way edge traversed ` +
      `against its digitised order is emitted forwards and ends on the wrong node — after which ` +
      `every following edge starts from a displaced point and the error compounds. Evidence: ` +
      `every block of these paths matches some edge's geometry in FORWARD order, yet consecutive ` +
      `blocks do not share an endpoint. Fix it there, re-run pnpm data:simulate, and this warning ` +
      `clears itself — nothing in this module needs to change.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/** Equirectangular metres. Spans here are single-digit kilometres, where the
 *  error against the geodesic is under a metre. */
function metres(a: LngLat, b: LngLat): number {
  const R = 6371008.8;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const x = dLng * Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  return Math.hypot(x, dLat) * R;
}

function ptKey(p: LngLat): string {
  return `${p[0].toFixed(KEY_DP)},${p[1].toFixed(KEY_DP)}`;
}

/** Degrees clockwise from map north, the compass convention. */
function bearingDeg(a: LngLat, b: LngLat): number {
  const lat = ((a[1] + b[1]) * Math.PI) / 360;
  const x = (b[0] - a[0]) * Math.cos(lat);
  const y = b[1] - a[1];
  return (Math.atan2(x, y) * 180) / Math.PI;
}

function samePoint(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * Which way the vehicle is facing at a route vertex.
 *
 * Two traps here, both of which produce a fleet that visibly spins:
 *
 *  - the dwell keyframes duplicate a vertex, so the "next" point is often the
 *    SAME point and the segment has no direction at all. Walk forward to the
 *    next distinct vertex instead of trusting index+1.
 *  - at the end of the route there is no forward vertex, and a staged or
 *    arrived vehicle still has to face somewhere sensible. Fall back to the
 *    last leg that had length, so a parked bus keeps the heading it arrived on.
 */
export function routeBearingAt(route: VehicleRoute, index: number): number {
  const pts = route.points;
  const n = pts.length;
  if (n < 2) return 0;
  let a = clamp(index, 0, n - 1);
  let b = a + 1;
  while (b < n && samePoint(pts[a], pts[b])) b++;
  if (b < n) return bearingDeg(pts[a], pts[b]);
  b = a;
  a = b - 1;
  while (a >= 0 && samePoint(pts[a], pts[b])) a--;
  return a >= 0 ? bearingDeg(pts[a], pts[b]) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Road names
//
// The manifest carries geometry but no edge ids, so the names are recovered by
// matching each SEGMENT of the path back to the edge that owns it. Segment
// matching, not vertex matching: an intersection vertex belongs to every road
// that meets there, so a vertex index reports whichever side street was indexed
// last and the route reads as a stutter of cul-de-sacs.
// ─────────────────────────────────────────────────────────────────────────────

const roadIndexCache = new WeakMap<RoadNetwork, Map<string, string | null>>();

/** Segment key -> road name, or null when the edge exists but OSM never named
 *  it. A key that is absent entirely means no edge owns that segment. */
function roadIndex(network: RoadNetwork): Map<string, string | null> {
  const hit = roadIndexCache.get(network);
  if (hit) return hit;
  const idx = new Map<string, string | null>();
  for (const edge of network.edges) {
    const name = edge.name ?? null;
    const g = edge.geometry;
    for (let i = 0; i < g.length - 1; i++) {
      const a = ptKey(g[i]);
      const b = ptKey(g[i + 1]);
      // Both directions: a bus may run an edge against its digitised order.
      if (name !== null || !idx.has(`${a}|${b}`)) idx.set(`${a}|${b}`, name);
      if (name !== null || !idx.has(`${b}|${a}`)) idx.set(`${b}|${a}`, name);
    }
  }
  roadIndexCache.set(network, idx);
  return idx;
}

/**
 * Named roads along a path, plus how much of it is not on the network at all.
 *
 * The second number is not decoration. See `warnAboutGeometry` below: a large
 * off-network share is an upstream defect, and this is where it is measured.
 */
function roadsAlong(
  path: LngLat[],
  edgeIdx: Map<string, string | null> | null,
): { roads: VehicleRoadLeg[]; namedM: number; offNetworkM: number; totalM: number } {
  const roads: VehicleRoadLeg[] = [];
  let namedM = 0;
  let offNetworkM = 0;
  let totalM = 0;
  if (path.length < 2) return { roads, namedM, offNetworkM, totalM };
  let prevKey = ptKey(path[0]);
  for (let i = 1; i < path.length; i++) {
    const key = ptKey(path[i]);
    const seg = metres(path[i - 1], path[i]);
    totalM += seg;
    const name = edgeIdx ? edgeIdx.get(`${prevKey}|${key}`) : undefined;
    prevKey = key;
    // `undefined` is "no edge owns this segment"; `null` is "an edge owns it but
    // OSM never gave it a name". Only the first is a geometry problem.
    if (name === undefined) {
      offNetworkM += seg;
      continue;
    }
    if (name === null) continue;
    namedM += seg;
    const last = roads[roads.length - 1];
    if (last && last.name === name) last.metres += seg;
    else roads.push({ seq: roads.length, name, metres: seg });
  }
  return { roads, namedM, offNetworkM, totalM };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fleet precompute
// ─────────────────────────────────────────────────────────────────────────────

interface FleetCacheEntry {
  zones: ZoneLayer | null;
  network: RoadNetwork | null;
  fleet: VehicleFleet;
}

const fleetCache = new WeakMap<EvacPlan, FleetCacheEntry>();

/**
 * Every derived quantity a vehicle layer or the inspection card needs, computed
 * once per plan. Cached on the plan object itself rather than a string key, so
 * a scenario switch drops it with the bundle and nothing has to be invalidated.
 */
export function fleetFor(
  plan: EvacPlan | null,
  zones: ZoneLayer | null,
  network: RoadNetwork | null,
): VehicleFleet {
  if (!plan || plan.manifests.length === 0) return EMPTY_FLEET;
  const hit = fleetCache.get(plan);
  if (hit && hit.zones === zones && hit.network === network) return hit.fleet;

  const zoneById = new Map<string, EvacZone>();
  for (const z of zones?.zones ?? []) zoneById.set(z.id, z);
  const idx = network ? roadIndex(network) : null;

  const routes: VehicleRoute[] = [];
  const dropped: string[] = [];
  for (const m of plan.manifests) {
    const route = buildRoute(m, zoneById, idx);
    if (route) routes.push(route);
    else dropped.push(m.id);
  }

  let off = 0;
  let all = 0;
  for (const r of routes) {
    off += r.offNetworkM;
    all += r.totalM;
  }
  const offNetworkShare = all > 0 ? off / all : 0;
  if (network) warnAboutGeometry(plan, routes, offNetworkShare);

  const fleet: VehicleFleet = {
    routes,
    byId: new Map(routes.map((r) => [r.manifest.id, r])),
    atRisk: routes.filter((r) => r.atRisk),
    dropped,
    offNetworkShare,
  };
  fleetCache.set(plan, { zones, network, fleet });
  return fleet;
}

function buildRoute(
  m: VehicleManifest,
  zoneById: Map<string, EvacZone>,
  idx: Map<string, string | null> | null,
): VehicleRoute | null {
  const src = m.path;
  const srcT = m.timestamps;
  if (!Array.isArray(src) || src.length < 2 || srcT.length !== src.length) return null;

  let hazardEta = -1;
  for (const zoneId of m.assignedZoneIds) {
    const z = zoneById.get(zoneId);
    if (!z) continue;
    if (hazardEta < 0 || z.hazardEta < hazardEta) hazardEta = z.hazardEta;
  }

  // Locate each stop's vertex. `simulate` bumps the arrival vertex's timestamp
  // to the departure time, so the stop is the first vertex whose timestamp has
  // passed the published arrival. When the two are EQUAL the dwell was folded
  // into the outgoing leg (ambulances) and there is no window to recover.
  const ordered = [...m.stops].sort((a, b) => a.seq - b.seq);
  const markAt = new Map<number, VehicleStopWindow>();
  const stops: VehicleStopWindow[] = [];
  let cursor = 0;
  for (const stop of ordered) {
    let j = cursor;
    while (j < srcT.length - 1 && srcT[j] < stop.arriveAt) j++;
    const window: VehicleStopWindow = {
      stop,
      roadPosition: src[j],
      arriveAt: stop.arriveAt,
      departAt: Math.max(stop.arriveAt, srcT[j]),
      slack: hazardEta < 0 ? Number.NaN : hazardEta - stop.arriveAt,
    };
    stops.push(window);
    // A second stop landing on the same vertex would overwrite the first; keep
    // the earlier one, which is the one whose dwell the timestamps describe.
    if (!markAt.has(j)) markAt.set(j, window);
    cursor = j;
  }

  const points: LngLat[] = [];
  const times: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const w = markAt.get(i);
    if (w && w.departAt > w.arriveAt) {
      // Arrival keyframe. The duplicate point either side of the dwell is what
      // makes "stopped with the door open" fall out of plain interpolation.
      points.push(src[i]);
      times.push(w.arriveAt);
    }
    points.push(src[i]);
    times.push(srcT[i]);
  }

  const n = points.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + metres(points[i - 1], points[i]);

  const timeArr = new Float64Array(n);
  // Clamp to non-decreasing. A payload that went backwards would otherwise make
  // the binary search below meaningless rather than merely wrong.
  let prev = times[0];
  for (let i = 0; i < n; i++) {
    prev = times[i] < prev ? prev : times[i];
    timeArr[i] = prev;
  }

  const { roads, namedM, offNetworkM, totalM } = roadsAlong(src, idx);
  const lastStop = stops[stops.length - 1];
  const pickupSlack = hazardEta < 0 || !lastStop ? Number.NaN : hazardEta - lastStop.stop.arriveAt;

  return {
    manifest: m,
    points,
    times: timeArr,
    cum,
    totalM: cum[n - 1],
    departAt: timeArr[0],
    endAt: timeArr[n - 1],
    stops,
    roads,
    roadCoverage: totalM > 0 ? namedM / totalM : 0,
    offNetworkM,
    hazardEta,
    pickupSlack,
    // Either end of the run failing is the same operational fact: the plan does
    // not get these people out ahead of the fire.
    atRisk: m.slack < 0 || (Number.isFinite(pickupSlack) && pickupSlack < 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime — the only code on the 30fps path
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleFix {
  position: LngLat;
  /** Metres travelled along the route. */
  distance: number;
  /** Index of the vertex at or before `t`. */
  index: number;
}

/** Last vertex whose timestamp is <= t. -1 before the route starts. */
function seek(times: Float64Array, t: number): number {
  if (t < times[0]) return -1;
  let lo = 0;
  let hi = times.length - 1;
  if (t >= times[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where the vehicle is at `t`. Clamped at both ends: before departure it waits
 * at its depot, after arrival it stands at its shelter. Pure, and exported so
 * the check script can assert positions without a GL context.
 */
export function vehiclePositionAt(route: VehicleRoute, t: Tick): VehicleFix {
  const { points, times, cum } = route;
  const i = seek(times, t);
  if (i < 0) return { position: points[0], distance: 0, index: 0 };
  const last = points.length - 1;
  if (i >= last) return { position: points[last], distance: cum[last], index: last };

  const dt = times[i + 1] - times[i];
  // A zero-width span is the dwell keyframe pair, or two vertices the pipeline
  // rounded onto the same second. Either way there is nothing to interpolate.
  const f = dt > 0 ? clamp((t - times[i]) / dt, 0, 1) : 0;
  const a = points[i];
  const b = points[i + 1];
  return {
    position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
    distance: cum[i] + (cum[i + 1] - cum[i]) * f,
    index: i,
  };
}

export function vehiclePhaseAt(route: VehicleRoute, t: Tick): VehiclePhase {
  if (t < route.departAt) return "staged";
  if (t >= route.endAt) return "arrived";
  for (const w of route.stops) {
    if (t >= w.arriveAt && t < w.departAt) return "loading";
  }
  const last = route.stops[route.stops.length - 1];
  return last && t >= last.departAt ? "to_shelter" : "to_pickup";
}

/** Live means drawn: staged a little early, held a little past the drop. */
export function vehicleIsLive(route: VehicleRoute, t: Tick): boolean {
  return t >= route.departAt - STAGE_LEAD && t <= route.endAt + ARRIVED_LINGER;
}

/** Next stop the vehicle has not finished loading at, or null once it is
 *  running to the shelter. */
export function nextStop(route: VehicleRoute, t: Tick): VehicleStopWindow | null {
  for (const w of route.stops) if (t < w.departAt) return w;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Datum. Tagged `_vk` — `_k` belongs to deck-layers.tsx and `_ck` to
// context-layers.tsx, so no tooltip in the chain can claim another's pick.
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleDatum {
  _vk: "vehicle";
  route: VehicleRoute;
  position: LngLat;
  phase: VehiclePhase;
  distance: number;
  selected: boolean;
  /** Which silhouette. Type is carried by SHAPE — never by colour. */
  glyph: VehicleGlyph;
  /** Degrees clockwise from north, along the route at this instant. */
  bearing: number;
}

/**
 * A fire station's stabled engines. Not a vehicle in motion and deliberately
 * not shaped like one in the code either: it has no route, no phase and no
 * progress, because the plan never moves it.
 */
export interface EngineDatum {
  _vk: "engine";
  facility: Facility;
  exposure: FacilityExposure;
  /** The modelled footprint has already reached this station at the playhead. */
  burning: boolean;
}

/**
 * One node of the selected run's CALL CHAIN.
 *
 * Not just the pickups. 74 of camp-fire-2018's 79 manifests have exactly ONE
 * pickup stop, so a layer that draws pickups alone puts a single ring on the
 * map when a bus is selected and the operator sees nothing happen. The chain an
 * operator actually reads is the whole tasking — where the vehicle rolls FROM,
 * every address it is due at, and the shelter it ends at — which is three or
 * more nodes for every manifest in the payload.
 *
 * Keeps the `_vk: "vehicle-stop"` tag it grew out of, so tooltip dispatch and
 * the click-to-select-the-vehicle path are unchanged.
 */
interface VehicleStopDatum {
  _vk: "vehicle-stop";
  route: VehicleRoute;
  kind: "origin" | "pickup" | "drop";
  /** Present only on a pickup — origin and drop are facilities, not stops. */
  window: VehicleStopWindow | null;
  position: LngLat;
  label: string;
  /** Place in the chain. Origin is 0, so the numerals read as a call order. */
  seq: number;
  total: number;
  /** Tick the plan has the vehicle at this node. */
  at: Tick;
  /** The playhead is past it: this leg of the tasking has been made. */
  done: boolean;
  /** The first node still ahead. Exactly one node in a chain carries it. */
  next: boolean;
}

/**
 * Origin, every pickup, drop — with `done` resolved at the playhead.
 *
 * Origin and drop positions come from the ROUTE geometry rather than the
 * facility layer: the plan's own first and last vertex are where the solver put
 * this vehicle, and a facility centroid a hundred metres off would draw a chain
 * that does not meet its own path. `at` for the drop is `route.endAt` for the
 * same reason — it is read off the timestamps, so a truncated payload cannot
 * report an arrival the geometry never reaches.
 *
 * Ambulances have `departAt === arriveAt`, because the pipeline folds their
 * dwell into the outgoing leg, so their pickups flip to `done` on arrival
 * rather than on departure. That is the payload telling the truth about what it
 * knows, and it is deliberately not special-cased.
 */
function callChain(route: VehicleRoute, t: Tick): VehicleStopDatum[] {
  const m = route.manifest;
  const last = route.points.length - 1;
  const nodes: Omit<VehicleStopDatum, "total" | "next">[] = [
    {
      _vk: "vehicle-stop",
      route,
      kind: "origin",
      window: null,
      position: route.points[0],
      label: m.originLabel,
      seq: 0,
      at: route.departAt,
      done: t >= route.departAt,
    },
  ];
  for (const window of route.stops) {
    nodes.push({
      _vk: "vehicle-stop",
      route,
      kind: "pickup",
      window,
      position: window.stop.position,
      label: window.stop.label,
      seq: nodes.length,
      at: window.arriveAt,
      done: t >= window.departAt,
    });
  }
  nodes.push({
    _vk: "vehicle-stop",
    route,
    kind: "drop",
    window: null,
    position: route.points[last],
    label: m.dropLabel,
    seq: nodes.length,
    at: route.endAt,
    done: t >= route.endAt,
  });

  const total = nodes.length;
  const chain = nodes.map((n) => ({ ...n, total, next: false }));
  const pending = chain.find((n) => !n.done);
  if (pending) pending.next = true;
  return chain;
}

interface VehiclePathDatum {
  _vk: "vehicle-path";
  route: VehicleRoute;
  path: LngLat[];
}

type AnyVehicleDatum = VehicleDatum | VehicleStopDatum | VehiclePathDatum | EngineDatum;

// ─────────────────────────────────────────────────────────────────────────────
// Colour
// ─────────────────────────────────────────────────────────────────────────────

function rgba(rgb: readonly [number, number, number], alpha: number): Color {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

export function vehicleRgb(
  phase: VehiclePhase,
  atRisk: boolean,
): readonly [number, number, number] {
  // A vehicle that cannot make it is the most urgent mark on the map; it
  // overrides its own phase encoding exactly the way an at-risk facility does.
  return atRisk ? HAZARD_RGB : PHASE_RGB[phase];
}

function cssRgb(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Faint route web — the one cached array here
// ─────────────────────────────────────────────────────────────────────────────

const webCache = new WeakMap<EvacPlan, { key: string; data: VehiclePathDatum[] }>();

function routeWeb(plan: EvacPlan, live: VehicleRoute[], bucket: number): VehiclePathDatum[] {
  // Membership, not just a count: one vehicle arriving as another departs
  // inside the same bucket leaves the length unchanged, and a length key would
  // hand deck the previous frame's routes. Same shape deck-layers keys its own
  // per-frame arrays with.
  const key = `${bucket}|${live.map((r) => r.manifest.id).join(",")}`;
  const hit = webCache.get(plan);
  if (hit && hit.key === key) return hit.data;
  const data = live.map<VehiclePathDatum>((route) => ({
    _vk: "vehicle-path",
    route,
    path: route.points,
  }));
  webCache.set(plan, { key, data });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildVehicleLayers — pure, so the split view can drive two stacks from one
// bundle, exactly like buildLayers and buildDetailLayers.
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleLayerArgs {
  /** The run's plan. Null before simulate has written a run; baseline runs
   *  carry zero manifests because `busDispatch` is off in BASELINE_PARAMS. */
  plan: EvacPlan | null;
  /** Supplies hazard ETA per zone, which is what slack is measured against. */
  zones: ZoneLayer | null;
  /** Supplies road names for the route readout. Null degrades to no names. */
  network: RoadNetwork | null;
  /** Stables the engines. Null draws no station inventory at all. */
  facilities?: FacilityLayer | null;
  /** Tested against station positions for the burn-over time. Null leaves the
   *  exposure `unknown` rather than reporting a station clear. */
  hazard?: HazardTrack | null;
  /** The operator's facility-kind filter, so the station glyphs disappear and
   *  reappear in step with the facility dots rather than fighting them. */
  facilityKinds?: FacilityKind[];
  /** Camera zoom. Only gates the engine count numerals. */
  zoom?: number;
  t: Tick;
  layers: LayerVisibility;
  selection: Selection;
  /** Freezes the at-risk pulse. Comes from `useVehicleState`. */
  reduceMotion?: boolean;
  /** Split view renders two stacks; ids must not collide between them. */
  idPrefix?: string;
  /** Split panes switch picking off on the pane that is not focused. */
  interactive?: boolean;
}

export function buildVehicleLayers(args: VehicleLayerArgs): Layer[] {
  const { plan, zones, network, t, layers, selection } = args;
  const prefix = args.idPrefix ? `${args.idPrefix}-` : "";
  const pick = args.interactive !== false;
  const out: Layer[] = [];
  const atlas = vehicleAtlas();
  /* One multiplier, computed once per render, applied as `sizeScale` /
     `radiusScale` to every mark this module draws. See `glyphScale`: it is a
     sublinear function of zoom, so pulling the camera back shrinks the fleet
     without letting it vanish, and nothing here can end up out of step with
     anything else. */
  const scale = glyphScale(args.zoom ?? DEFAULT_ZOOM);

  // ── 0. stabled engines ────────────────────────────────────────────────────
  // Gated on `layers.facilities`, not on the dispatch toggle: an engine is
  // inventory at a facility, and turning dispatch off must not hide the fact
  // that sixteen engines are parked inside the fire.
  if (layers.facilities) out.push(...engineLayers(args, atlas, prefix, pick));

  // Shares the dispatch toggle with the arcs it supersedes: inventing a new
  // LayerVisibility key would mean editing store.ts, which this module does not.
  if (!layers.busArcs || !plan) return out;

  const fleet = fleetFor(plan, zones, network);
  if (fleet.routes.length === 0) return out;

  const live: VehicleRoute[] = [];
  for (const r of fleet.routes) if (vehicleIsLive(r, t)) live.push(r);
  if (live.length === 0) return out;

  const selectedId = selection.kind === "vehicle" ? selection.id : null;
  const selected = selectedId ? (fleet.byId.get(selectedId) ?? null) : null;

  // ── 1. route web ──────────────────────────────────────────────────────────
  // Every live vehicle's whole route, faint. This is the dispatch geometry the
  // arcs were pretending to be: real roads, not chords across the valley.
  const bucket = Math.floor(t / ROUTE_BUCKET) * ROUTE_BUCKET;
  out.push(
    new PathLayer<VehiclePathDatum>({
      id: `${prefix}vehicle-routes`,
      data: routeWeb(plan, live, bucket),
      // The puck is the pick target. A 40-route web that swallows hovers would
      // make the roads underneath it unreadable.
      pickable: false,
      widthUnits: "pixels",
      widthMinPixels: 0.8,
      widthMaxPixels: 3,
      capRounded: true,
      jointRounded: true,
      getPath: getVehiclePath,
      getColor: getWebColor,
      getWidth: 1.1,
      updateTriggers: { getColor: [bucket] },
    }),
  );

  // ── 2. selected route, split at the playhead ──────────────────────────────
  if (selected) {
    const fix = vehiclePositionAt(selected, t);
    const done = selected.points.slice(0, fix.index + 1);
    done.push(fix.position);
    const rest = [fix.position, ...selected.points.slice(fix.index + 1)];
    const accent = vehicleRgb(vehiclePhaseAt(selected, t), selected.atRisk);

    out.push(
      new PathLayer<VehiclePathDatum>({
        id: `${prefix}vehicle-route-done`,
        data:
          done.length > 1 ? [{ _vk: "vehicle-path", route: selected, path: done }] : EMPTY_PATHS,
        pickable: false,
        widthUnits: "pixels",
        widthMinPixels: 1.2,
        widthMaxPixels: 5,
        capRounded: true,
        jointRounded: true,
        getPath: getVehiclePath,
        getColor: rgba(NEUTRAL_RGB, 150),
        getWidth: 2,
      }),
      new PathLayer<VehiclePathDatum>({
        id: `${prefix}vehicle-route-remaining`,
        data:
          rest.length > 1 ? [{ _vk: "vehicle-path", route: selected, path: rest }] : EMPTY_PATHS,
        pickable: false,
        widthUnits: "pixels",
        widthMinPixels: 1.6,
        widthMaxPixels: 7,
        capRounded: true,
        jointRounded: true,
        getPath: getVehiclePath,
        getColor: rgba(accent, 240),
        getWidth: 2.8,
        updateTriggers: { getColor: [accent[0], accent[1], accent[2]] },
      }),
    );

    /* The call chain: origin, every pickup, drop. Rings rather than dots, so a
       node never reads as one more facility, and a dark halo underneath so the
       chain separates from the facility layer it sits on top of.

       Made vs pending is carried by three things at once — hue (cleared green
       once spent, the route's own phase accent while outstanding), ring weight
       and radius — because at seven pixels any one of those alone is not a
       difference an operator can see across a room. */
    const chain = callChain(selected, t);
    const chainPulse = args.reduceMotion
      ? 1
      : 0.62 + 0.38 * (0.5 + 0.5 * Math.sin((t / PULSE_PERIOD) * Math.PI * 2));
    const pendingNode = chain.find((n) => n.next);

    out.push(
      new ScatterplotLayer<VehicleStopDatum>({
        id: `${prefix}vehicle-chain-halo`,
        data: chain,
        pickable: false,
        stroked: false,
        filled: true,
        radiusUnits: "pixels",
        radiusScale: scale,
        radiusMinPixels: 4,
        radiusMaxPixels: 26,
        getPosition: getStopPosition,
        getRadius: getChainHaloRadius,
        getFillColor: CHAIN_HALO,
      }),
    );

    /* Only the NEXT node breathes. Pulsing every outstanding stop would make a
       six-stop run look like an alarm going off six times. */
    if (pendingNode) {
      out.push(
        new ScatterplotLayer<VehicleStopDatum>({
          id: `${prefix}vehicle-chain-next`,
          data: [pendingNode],
          pickable: false,
          stroked: true,
          filled: false,
          radiusUnits: "pixels",
          radiusScale: scale,
          radiusMinPixels: 5,
          radiusMaxPixels: 32,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1.2,
          getLineWidth: 1.6,
          getPosition: getStopPosition,
          getRadius: 11 * chainPulse,
          getLineColor: rgba(accent, Math.round(120 + 110 * chainPulse)),
          updateTriggers: { getRadius: [chainPulse], getLineColor: [chainPulse] },
        }),
      );
    }

    out.push(
      new ScatterplotLayer<VehicleStopDatum>({
        id: `${prefix}vehicle-stops`,
        data: chain,
        pickable: pick,
        stroked: true,
        filled: true,
        radiusUnits: "pixels",
        radiusScale: scale,
        radiusMinPixels: 2.5,
        radiusMaxPixels: 18,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1.2,
        getLineWidth: getChainLineWidth,
        getRadius: getChainRadius,
        getPosition: getStopPosition,
        getFillColor: (d) => chainFill(d, accent),
        getLineColor: (d) => chainLine(d, accent),
      }),
      new TextLayer<VehicleStopDatum>({
        id: `${prefix}vehicle-chain-seq`,
        data: chain,
        pickable: false,
        billboard: true,
        background: false,
        characterSet: "0123456789",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 700,
        sizeUnits: "pixels",
        getPosition: getStopPosition,
        getText: getChainSeq,
        getSize: 10,
        // Rides clear of the ring, so it has to move with the ring's scale.
        getPixelOffset: [0, -Math.round(8 + 9 * scale)],
        getColor: (d) => chainLine(d, accent),
        outlineWidth: 3,
        outlineColor: [8, 10, 14, 225],
        fontSettings: { sdf: true },
        updateTriggers: { getPixelOffset: [scale] },
      }),
    );
  }

  // ── 3. the fleet ──────────────────────────────────────────────────────────
  // Rebuilt every frame on purpose: this array IS the motion. 79 rows of four
  // floats is nothing, and caching it would freeze the map.
  const pucks: VehicleDatum[] = live.map((route) => {
    const fix = vehiclePositionAt(route, t);
    return {
      _vk: "vehicle",
      route,
      position: fix.position,
      distance: fix.distance,
      phase: vehiclePhaseAt(route, t),
      selected: route.manifest.id === selectedId,
      glyph: glyphFor(route.manifest.kind),
      bearing: routeBearingAt(route, fix.index),
    };
  });

  // ── 4. at-risk ring ───────────────────────────────────────────────────────
  // "We cannot reach these people in time" gets a mark nothing else on the map
  // uses: a wide ember ring that breathes. Two of camp-fire-2018's manifests
  // are in here, and they are the whole argument.
  const risky = pucks.filter((d) => d.route.atRisk);
  if (risky.length > 0) {
    const pulse = args.reduceMotion
      ? 1
      : 0.62 + 0.38 * (0.5 + 0.5 * Math.sin((t / PULSE_PERIOD) * Math.PI * 2));
    out.push(
      new ScatterplotLayer<VehicleDatum>({
        id: `${prefix}vehicle-risk`,
        data: risky,
        pickable: false,
        stroked: true,
        filled: false,
        radiusUnits: "pixels",
        // Scaled with the silhouette it rings, or a shrunk bus wears a halo
        // three times its own length at region zoom.
        radiusScale: scale,
        radiusMinPixels: 5,
        radiusMaxPixels: 34,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1.4,
        getLineWidth: 2,
        getPosition: getVehiclePosition,
        getRadius: 13 * pulse,
        getLineColor: rgba(HAZARD_RGB, Math.round(150 + 90 * pulse)),
        updateTriggers: { getRadius: [pulse], getLineColor: [pulse] },
      }),
    );
  }

  // ── 5. the vehicles themselves ────────────────────────────────────────────
  // Two icon layers, not one: the casing is a dilated copy of the same
  // silhouette drawn in near-black underneath, which is the only thing that
  // keeps a bus legible over dark canopy on satellite imagery.
  //
  // `data` is a fresh array every frame, so deck re-evaluates every accessor
  // without an updateTriggers entry — the same contract the scatterplot pucks
  // relied on, and the reason none of these accessors carries one.
  if (atlas) {
    out.push(
      new IconLayer<VehicleDatum>({
        id: `${prefix}vehicle-casing`,
        data: pucks,
        pickable: false,
        iconAtlas: atlas.url,
        iconMapping: atlas.mapping,
        // Lie in the map plane. A billboarded icon cannot point down a road.
        billboard: false,
        sizeUnits: "pixels",
        sizeScale: scale,
        // Wide clamps on purpose: the shaping is `glyphScale`'s job, and a
        // tight clamp here would silently flatten the curve at both ends.
        sizeMinPixels: 7,
        sizeMaxPixels: 72,
        getIcon: getCasingIcon,
        getPosition: getVehiclePosition,
        getSize: getGlyphSize,
        getAngle: getVehicleAngle,
        getColor: getCasingColor,
      }),
      new IconLayer<VehicleDatum>({
        id: `${prefix}vehicle-pucks`,
        data: pucks,
        pickable: pick,
        iconAtlas: atlas.url,
        iconMapping: atlas.mapping,
        billboard: false,
        sizeUnits: "pixels",
        sizeScale: scale,
        sizeMinPixels: 7,
        sizeMaxPixels: 72,
        getIcon: getGlyphIcon,
        getPosition: getVehiclePosition,
        getSize: getGlyphSize,
        getAngle: getVehicleAngle,
        getColor: getGlyphColor,
      }),
    );
  } else {
    // No DOM, no 2D context, no atlas. Draw the original pucks rather than
    // nothing: a fleet that silently vanishes is the worst of the three.
    out.push(
      new ScatterplotLayer<VehicleDatum>({
        id: `${prefix}vehicle-pucks`,
        data: pucks,
        pickable: pick,
        stroked: true,
        filled: true,
        radiusUnits: "pixels",
        radiusScale: scale,
        radiusMinPixels: 2,
        radiusMaxPixels: 18,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
        getPosition: getVehiclePosition,
        getRadius: getPuckRadius,
        getFillColor: getPuckFill,
        getLineColor: getPuckLine,
        getLineWidth: getPuckLineWidth,
      }),
    );
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stabled engines
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_ENGINES: EngineDatum[] = [];

/**
 * Fire engines where they actually are: parked.
 *
 * Colour follows the same three-state exposure encoding the facility dots use,
 * so a station and a shelter inside the same fire read the same way:
 *
 *   held grey   the footprint never covers this station
 *   warn amber  it will, at a stated tick, and the playhead has not got there
 *   hazard      the modelled fire is on the station now
 *
 * The exposure itself comes from `facilityExposure` in derive.ts rather than a
 * second point-in-polygon written here, so the map and the facility inspector
 * cannot disagree about which stations burn.
 */
function engineLayers(
  args: VehicleLayerArgs,
  atlas: VehicleAtlas | null,
  prefix: string,
  pick: boolean,
): Layer[] {
  const facilities = args.facilities;
  if (!atlas || !facilities) return [];
  const kinds = args.facilityKinds ?? [];
  if (kinds.length > 0 && !kinds.includes("fire_station")) return [];

  const t = args.t;
  const scale = glyphScale(args.zoom ?? DEFAULT_ZOOM);
  const data = engineData(facilities, args.hazard ?? null).map<EngineDatum>((d) => ({
    ...d,
    burning: d.exposure.atRisk !== null && t >= d.exposure.atRisk,
  }));
  if (data.length === 0) return [];

  const out: Layer[] = [
    new IconLayer<EngineDatum>({
      id: `${prefix}engine-casing`,
      data,
      pickable: false,
      iconAtlas: atlas.url,
      iconMapping: atlas.mapping,
      billboard: false,
      sizeUnits: "pixels",
      sizeScale: scale,
      sizeMinPixels: 7,
      sizeMaxPixels: 52,
      getIcon: ENGINE_CASING_ICON,
      getPosition: getEnginePosition,
      getSize: ENGINE_PX,
      getColor: ENGINE_CASING_COLOR,
    }),
    new IconLayer<EngineDatum>({
      id: `${prefix}engines`,
      data,
      pickable: pick,
      iconAtlas: atlas.url,
      iconMapping: atlas.mapping,
      billboard: false,
      sizeUnits: "pixels",
      sizeScale: scale,
      sizeMinPixels: 7,
      sizeMaxPixels: 52,
      getIcon: ENGINE_GLYPH_ICON,
      getPosition: getEnginePosition,
      getSize: ENGINE_PX,
      getColor: getEngineColor,
      updateTriggers: { getColor: [t] },
    }),
  ];

  if ((args.zoom ?? 0) >= ENGINE_COUNT_ZOOM) {
    out.push(
      new TextLayer<EngineDatum>({
        id: `${prefix}engine-count`,
        data,
        pickable: false,
        billboard: true,
        background: false,
        characterSet: "0123456789",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 700,
        sizeUnits: "pixels",
        getPosition: getEnginePosition,
        getText: getEngineCount,
        // Numerals are read, not glanced at, so they do NOT follow the glyph
        // curve — a 6px digit is not a smaller digit, it is no digit. The zoom
        // gate above is what keeps them from crowding the region view.
        getSize: 10.5,
        // Rides above the glyph, so the gap has to shrink with it or the
        // numeral floats free of the station it belongs to.
        getPixelOffset: [0, -Math.round(6 + 11 * scale)],
        getColor: getEngineColor,
        outlineWidth: 3,
        outlineColor: [8, 10, 14, 220],
        fontSettings: { sdf: true },
        updateTriggers: { getColor: [t], getPixelOffset: [scale] },
      }),
    );
  }

  return out;
}

type EngineSeed = Omit<EngineDatum, "burning">;

const engineCache = new WeakMap<
  FacilityLayer,
  { hazard: HazardTrack | null; data: EngineSeed[] }
>();

/** Stations and their exposure, computed once per payload. `facilityExposure`
 *  memoises against the track, so a scenario switch drops both together. */
function engineData(facilities: FacilityLayer, hazard: HazardTrack | null): EngineSeed[] {
  const hit = engineCache.get(facilities);
  if (hit && hit.hazard === hazard) return hit.data;
  const data: EngineSeed[] = [];
  for (const facility of facilities.facilities) {
    if (facility.assets.engine <= 0) continue;
    data.push({ _vk: "engine", facility, exposure: facilityExposure(facility, hazard) });
  }
  engineCache.set(facilities, { hazard, data });
  return data.length > 0 ? data : EMPTY_ENGINES;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level accessors. Stable identity, so deck never re-evaluates one
// because a closure was reallocated.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_PATHS: VehiclePathDatum[] = [];

const getVehiclePath = (d: VehiclePathDatum) => d.path;
const getWebColor = (d: VehiclePathDatum): Color =>
  d.route.atRisk ? rgba(HAZARD_RGB, 90) : rgba(PLAN_RGB, 52);

const getVehiclePosition = (d: VehicleDatum) => d.position;

const getGlyphIcon = (d: VehicleDatum) => glyphIcon(d.glyph);
const getCasingIcon = (d: VehicleDatum) => casingIcon(d.glyph);

/**
 * deck rotates icons COUNTER-clockwise; a compass bearing runs clockwise, and
 * the sprites are authored nose-up so angle 0 already points at map north.
 * Negating the bearing is therefore the whole of the heading maths.
 */
const getVehicleAngle = (d: VehicleDatum) => -d.bearing;

/** An ambulance is one gurney; a bus is nineteen seats. Length carries the seat
 *  count so a full coach is visibly a bigger commitment than a van. */
const getGlyphSize = (d: VehicleDatum) =>
  clamp(
    GLYPH_MIN_PX + Math.sqrt(Math.max(1, d.route.manifest.seats)) * 2.6,
    GLYPH_MIN_PX,
    GLYPH_MAX_PX,
  ) * (d.selected ? 1.35 : 1);

const getGlyphColor = (d: VehicleDatum): Color =>
  rgba(vehicleRgb(d.phase, d.route.atRisk), d.phase === "staged" ? 170 : 255);

/** Dark keyline over satellite imagery, swapped for a bright one on the
 *  selected vehicle so the inspector and the map agree at a glance. */
const getCasingColor = (d: VehicleDatum): Color =>
  d.selected ? [236, 240, 243, 255] : [8, 10, 14, 225];

const getEnginePosition = (d: EngineDatum) => d.facility.position;
const getEngineCount = (d: EngineDatum) => String(d.facility.assets.engine);
/** deck only accepts an accessor here, never a constant string. */
const ENGINE_GLYPH_ICON = () => glyphIcon("engine");
const ENGINE_CASING_ICON = () => casingIcon("engine");
const ENGINE_CASING_COLOR: Color = [8, 10, 14, 225];
const getEngineColor = (d: EngineDatum): Color =>
  rgba(d.burning ? HAZARD_RGB : d.exposure.atRisk !== null ? WARN_RGB : NEUTRAL_RGB, 250);

const getPuckRadius = (d: VehicleDatum) =>
  clamp(3.4 + Math.sqrt(Math.max(1, d.route.manifest.seats)) * 0.55, 3.4, 9) *
  (d.selected ? 1.45 : 1);
const getPuckFill = (d: VehicleDatum): Color =>
  rgba(vehicleRgb(d.phase, d.route.atRisk), d.phase === "staged" ? 150 : 235);
/** Dark casing over satellite imagery, swapped for a bright ring on the
 *  selected vehicle so the inspector and the map agree at a glance. */
const getPuckLine = (d: VehicleDatum): Color =>
  d.selected ? [236, 240, 243, 255] : [10, 12, 16, 210];
const getPuckLineWidth = (d: VehicleDatum) => (d.selected ? 2.2 : 1);

const getStopPosition = (d: VehicleStopDatum) => d.position;
const getChainSeq = (d: VehicleStopDatum) => String(d.seq);
const CHAIN_HALO: Color = [8, 10, 14, 165];
/** The drop is the terminus and gets the largest node; a spent node shrinks,
 *  which is what makes a run's progress readable without reading the numerals. */
const getChainRadius = (d: VehicleStopDatum) =>
  (d.kind === "drop" ? 7.5 : d.kind === "origin" ? 5.5 : 6.5) * (d.done ? 0.82 : 1);
const getChainHaloRadius = (d: VehicleStopDatum) => getChainRadius(d) + 3.5;
const getChainLineWidth = (d: VehicleStopDatum) => (d.next ? 2.8 : d.done ? 1.2 : 2);

/**
 * Hue on a chain node, in priority order:
 *
 *   hazard   a pickup the fire is modelled to reach before the vehicle does.
 *            Outranks everything: it is the only state that means somebody may
 *            not be collected at all.
 *   cleared  made. Spent, and deliberately the same green the map already uses
 *            for a cleared zone.
 *   accent   outstanding, in the selected run's own phase colour, so the chain
 *            and the remaining leg of its route read as one object.
 */
function chainTone(
  d: VehicleStopDatum,
  accent: readonly [number, number, number],
): readonly [number, number, number] {
  if (d.window && d.window.slack < 0) return HAZARD_RGB;
  return d.done ? OK_RGB : accent;
}

const chainFill = (d: VehicleStopDatum, accent: readonly [number, number, number]): Color =>
  rgba(chainTone(d, accent), d.done ? 120 : d.kind === "drop" ? 110 : 55);
const chainLine = (d: VehicleStopDatum, accent: readonly [number, number, number]): Color =>
  rgba(chainTone(d, accent), d.done ? 190 : 250);

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip and click
// ─────────────────────────────────────────────────────────────────────────────

const TOOLTIP_STYLE: Partial<CSSStyleDeclaration> = {
  background: "var(--glass-deep)",
  backdropFilter: "blur(20px) saturate(160%)",
  WebkitBackdropFilter: "blur(20px) saturate(160%)",
  border: "1px solid var(--hairline-strong)",
  borderRadius: "10px",
  boxShadow: "var(--shadow-pop)",
  color: "var(--foreground)",
  font: "12px/1.45 var(--font-sans)",
  padding: "8px 10px",
  maxWidth: "272px",
  pointerEvents: "none",
  zIndex: "40",
} as Partial<CSSStyleDeclaration>;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/** Local copy of the stack's tooltip markup rather than an import: deck-layers
 *  is another module's file and must not grow exported surface to be composed
 *  with. Same shape, so the two never look like different products. */
function tipHtml(title: string, sub: string | null, rows: [string, string][], accent: string) {
  const head =
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">` +
    `<span style="width:7px;height:7px;border-radius:50%;flex:none;background:${accent}"></span>` +
    `<span style="font-size:12px;font-weight:650;letter-spacing:-0.005em">${esc(title)}</span></div>`;
  const subLine = sub
    ? `<div style="margin:-4px 0 6px;font-size:10.5px;color:var(--faint)">${esc(sub)}</div>`
    : "";
  const body = rows
    .map(
      ([k, v]) =>
        `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-top:2px">` +
        `<span style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.13em;text-transform:uppercase;color:var(--faint)">${esc(k)}</span>` +
        `<span style="font-family:var(--font-mono);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums">${esc(v)}</span></div>`,
    )
    .join("");
  return head + subLine + body;
}

/**
 * Vehicle-layer tooltips. Returns null for anything it does not own, so the
 * caller chains it with the other stacks' tooltips in any order.
 */
export function vehicleTooltip(
  info: PickingInfo,
): { html: string; style: Partial<CSSStyleDeclaration> } | null {
  const d = info.object as AnyVehicleDatum | undefined;
  if (!d || typeof d !== "object" || !("_vk" in d)) return null;

  if (d._vk === "vehicle-stop") {
    const m = d.route.manifest;
    const rows: [string, string][] = [
      ["Call", `${d.seq + 1} of ${d.total}`],
      ["State", d.done ? "MADE" : d.next ? "NEXT" : "pending"],
      [d.kind === "origin" ? "Rolls at" : "Arrives", formatTick(d.at, false)],
    ];

    if (d.kind === "pickup" && d.window) {
      const s = d.window.stop;
      rows.push(["Passengers", formatCount(s.passengers)]);
      if (s.wheelchair > 0) rows.push(["Wheelchair", formatCount(s.wheelchair)]);
      if (d.window.departAt > d.window.arriveAt) {
        rows.push(["Doors open", formatShort(d.window.departAt - d.window.arriveAt)]);
      }
      rows.push([
        "Hazard margin",
        Number.isFinite(d.window.slack)
          ? d.window.slack < 0
            ? `${formatShort(-d.window.slack)} LATE`
            : formatShort(d.window.slack)
          : "unknown",
      ]);
    } else if (d.kind === "origin") {
      rows.push(["Carries", `${formatCount(m.seats)} seats`]);
    } else {
      rows.push(["Slack", m.slack < 0 ? `${formatShort(-m.slack)} LATE` : formatShort(m.slack)]);
    }

    const kindLabel =
      d.kind === "origin" ? "Origin" : d.kind === "drop" ? "Drop" : `Pickup ${d.window?.stop.seq}`;
    return {
      html: tipHtml(
        d.label,
        `${kindLabel} · ${m.id}`,
        rows,
        // Warn amber for an outstanding call. The MAP tints a pending node with
        // the run's live phase colour, which is right there because the vehicle
        // is in that phase now; a hover card has no such moment, and an
        // unfinished tasking is an unmet need.
        cssRgb(chainTone(d, WARN_RGB)),
      ),
      style: TOOLTIP_STYLE,
    };
  }

  if (d._vk === "engine") {
    const a = d.facility.assets;
    const rows: [string, string][] = [["Engines stabled", formatCount(a.engine)]];
    if (a.ambulance > 0) rows.push(["Ambulances", formatCount(a.ambulance)]);
    if (a.bus > 0) rows.push(["Buses", formatCount(a.bus)]);
    // The whole reason this glyph exists. Never let a fire-truck-shaped mark
    // imply the solver tasked it with anything.
    rows.push(["Dispatched", "NONE · suppression asset"]);
    rows.push([
      "Hazard",
      d.exposure.atRisk === null
        ? d.exposure.basis === "unknown"
          ? "unknown"
          : "outside footprint"
        : d.burning
          ? `INSIDE since ${formatTick(d.exposure.atRisk, false)}`
          : `inside at ${formatTick(d.exposure.atRisk, false)}`,
    ]);
    rows.push([
      "Basis",
      d.exposure.basis === "derived"
        ? `derived · ${d.exposure.frameProvenance ?? "interpolated"} perimeter`
        : d.exposure.basis,
    ]);
    return {
      html: tipHtml(
        d.facility.name,
        "Fire station · stabled inventory, not a dispatch",
        rows,
        cssRgb(d.burning ? HAZARD_RGB : d.exposure.atRisk !== null ? WARN_RGB : NEUTRAL_RGB),
      ),
      style: TOOLTIP_STYLE,
    };
  }

  if (d._vk !== "vehicle") return null;

  const { route, phase } = d;
  const m = route.manifest;
  const rows: [string, string][] = [
    ["State", VEHICLE_PHASE_LABEL[phase]],
    ["Seats", formatCount(m.seats)],
    [
      "Progress",
      route.totalM > 0 ? `${Math.round((d.distance / route.totalM) * 100)}% of route` : "—",
    ],
    ["Drop", m.dropLabel],
    ["Slack", m.slack < 0 ? `${formatShort(-m.slack)} LATE` : formatShort(m.slack)],
    // Never let a moving dot imply a transponder.
    ["Position", "MODELLED · not GPS"],
  ];
  return {
    html: tipHtml(
      `${m.id} · ${m.originLabel}`,
      `${m.kind} → ${m.assignedZoneIds.join(", ") || "unassigned"}`,
      rows,
      cssRgb(vehicleRgb(phase, route.atRisk)),
    ),
    style: TOOLTIP_STYLE,
  };
}

/**
 * Selection for the vehicle stack. Returns deck's "consumed" signal, so the
 * caller chains it ahead of `deckClick`, which only knows `_k` datums.
 */
export function vehicleClick(info: PickingInfo): boolean {
  const d = info.object as AnyVehicleDatum | undefined;
  if (!d || typeof d !== "object" || !("_vk" in d)) return false;
  if (d._vk === "vehicle-path") return false;
  // An engine is inventory at a facility, so it opens the facility panel that
  // already knows how to explain a station. No new selection kind, no patch to
  // the store's Selection union.
  if (d._vk === "engine") {
    actions.select("facility", d.facility.id);
    return true;
  }
  actions.select("vehicle", d.route.manifest.id);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleState {
  /** True under prefers-reduced-motion. Holds the at-risk ring still. */
  reduceMotion: boolean;
}

/** Scenarios already announced. Module-level so StrictMode's double mount does
 *  not print the provenance note twice. */
const announced = new Set<string>();

/**
 * Everything `buildVehicleLayers` needs that `DeckOverlay` does not already
 * hold, in one hook so the integration is one line — same shape as
 * `useDetailState`.
 *
 * It also carries the honesty note. Per CLAUDE.md the pipeline shouts when a
 * number was synthesised; a moving vehicle is the same class of claim, so the
 * console says once per scenario, out loud, that these positions are modelled.
 */
export function useVehicleState(scenarioId: string): VehicleState {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (announced.has(scenarioId)) return;
    announced.add(scenarioId);
    console.info(
      `[vehicles] ${scenarioId}: bus and ambulance positions are MODELLED, not observed. ` +
        `Each puck is interpolated along the dispatch plan's free-flow routed geometry using ` +
        `the timestamps scripts/simulate.ts wrote onto the manifest. There is no AVL or GPS feed. ` +
        `Fire engines DO NOT MOVE on this map because nothing dispatches them: the plan's ` +
        `manifests contain buses and ambulances only, and VehicleManifest["kind"] has no engine ` +
        `member. The engine glyphs are stabled inventory read straight off facilities.json, ` +
        `positioned at their station, and their burn-over times are derived in the browser from ` +
        `the hazard perimeter rings — not fetched, and labelled "derived" wherever they appear.`,
    );
  }, [scenarioId]);

  return { reduceMotion };
}

/*
 * ── How this stack is wired, and the two lines that break it ────────────────
 *
 * `DeckOverlay` in deck-layers.tsx already calls `useVehicleState` and
 * `buildVehicleLayers`, and the flat `bus-arcs` chords this stack supersedes are
 * gone. Two things about that wiring are load-bearing and silently fatal:
 *
 *   1. Vehicles go LAST in the merged layer array. They are the only thing on
 *      this map moving under its own power, and a puck occluded by a zone fill
 *      cannot be clicked.
 *   2. `vehicleClick` has to run AHEAD of `deckClick` in the onClick chain.
 *      `deckClick` switches on `_k` and ignores every `_vk` datum, so dropping
 *      it leaves the fleet hoverable but not selectable — which looks like a
 *      dead map rather than a missing line.
 *
 * The engine sub-stack needs `facilities`, `hazard` and `facilityKinds` in the
 * args, and deck-layers filters stations OUT of its own facility dots to match.
 * Passing the first two as null is safe — the stations simply do not draw —
 * but leaving the dots unfiltered puts a circle under every engine.
 */

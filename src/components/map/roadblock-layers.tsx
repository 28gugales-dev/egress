"use client";

import type { Color, Layer, PickingInfo } from "@deck.gl/core";
import { IconLayer, PathLayer } from "@deck.gl/layers";
import {
  BARRIER_CASING_ICON,
  BARRIER_ICON,
  type BarrierAtlas,
  barrierAtlas,
} from "@/components/map/roadblock-icons";
import { glyphScale } from "@/components/map/vehicle-icons";
import { HAZARD_RGB, PLAN_RGB, WARN_RGB } from "@/lib/constants";
import { closedEdgeSet, edgeById, hazardFrameAt, zonesUsingEdge } from "@/lib/derive";
import { formatCount, formatShort, formatTick } from "@/lib/format";
import { actions } from "@/lib/store";
import type {
  EvacPlan,
  HazardFrame,
  HazardTrack,
  LayerVisibility,
  LngLat,
  RoadEdge,
  RoadNetwork,
  Selection,
  Tick,
  VehicleManifest,
  ZoneLayer,
} from "@/types/egress";

/**
 * Roadblocks — the road segments the hazard has taken.
 *
 * ── What a roadblock IS here ────────────────────────────────────────────────
 *
 * Exactly one thing, and it is not invented in this file. `scripts/fetch-hazard`
 * tests every network edge against every perimeter ring and writes the
 * cumulative impassable set onto each frame as `closedEdgeIds`; `derive.ts`
 * exposes that set as `closedEdgeSet(frame)`, and `zoneEgress` counts against
 * the same set to produce the "SEGMENTS OPEN 10 / 27" readout in the inspector.
 * This module walks the track once and asks `closedEdgeSet` which edges are
 * shut at each frame, so the map and that readout cannot disagree. There is no
 * second definition of closed anywhere in the render path.
 *
 * ── The distinction the operator actually needs ─────────────────────────────
 *
 * "This road is gone" and "this road is gone AND it is on the path of the run
 * going to collect nineteen people from Concow" are two different alarms, so
 * they get two different marks. Route membership is read off the dispatch
 * manifests' own routed geometry — every segment of every `manifest.path`
 * matched back to the edge that owns it, the same 5dp segment-key trick
 * vehicle-layers uses to recover road names. Nothing is guessed from proximity.
 *
 * Three tiers, resolved per frame:
 *
 *   clear   closed, no dispatch run ever used this segment
 *   route   closed, and a dispatch run used it — but every such run was already
 *           past by the time the fire arrived. The margin is the story, and the
 *           tooltip states it.
 *   ahead   closed, and a run still has this segment IN FRONT of it at the
 *           playhead. The alarm.
 *
 * On camp-fire-2018 the `ahead` tier is EMPTY, and that is a result rather than
 * an omission: the solver reads the same closure schedule, so it never routes a
 * bus into a road the fire has already taken. The tier is implemented anyway —
 * it costs two comparisons a frame, it is what a live re-plan against a moving
 * front would trip, and deleting it would mean the console could not show the
 * failure if it ever happened.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 *
 * A closure is only ever as observed as the perimeter that produced it. On
 * camp-fire-2018 exactly ONE of 97 hazard frames is an observed perimeter; the
 * other 96 are interpolated between observations, which means essentially every
 * closure time on this map is modelled. Every tooltip says which, and the
 * module shouts the ratio into the console once per track. A modelled closure
 * presented as an observed one would be the worst lie this console could tell:
 * it is a claim about which road is still there.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

const ROADBLOCK_ZOOM = {
  /** Below this only closures on a dispatch route draw. Region overview of a
   *  late frame is 4,000 dead segments, and all of them at once is a texture,
   *  not information. */
  all: 11,
  /** Barrier glyphs for route-blocking closures. */
  routeMarks: 12.5,
  /** Barrier glyphs for every closure. Deliberately past the buildings gate:
   *  by here the operator is looking at a street, not a town. */
  allMarks: 14.5,
} as const;

/** Same breath as the vehicle at-risk ring, for the same reason: an instrument
 *  should not animate a frozen clock, so this is scenario seconds, not real. */
const PULSE_PERIOD: Tick = 120;

/** Coordinate key precision. The pipeline snaps at 5dp; matching that is what
 *  lets a manifest path segment find the edge that owns it. */
const KEY_DP = 5;

type RoadblockTier = "clear" | "route" | "ahead";

const TIER_LABEL: Record<RoadblockTier, string> = {
  clear: "Closed",
  route: "Closed on a dispatch route",
  ahead: "CLOSED AHEAD OF A LIVE RUN",
};

// ─────────────────────────────────────────────────────────────────────────────
// Datum. Tagged `_rk`; `_k`, `_ck` and `_vk` belong to the other three stacks,
// so no tooltip in the chain can claim another's pick.
// ─────────────────────────────────────────────────────────────────────────────

export interface RoadblockDatum {
  _rk: "roadblock";
  edge: RoadEdge;
  /** First frame tick at which the perimeter covers this edge. */
  closedAt: Tick;
  /** Provenance of THAT frame — not of the frame on screen. */
  provenance: HazardFrame["provenance"];
  /** Dispatch runs whose routed path uses this segment. */
  runs: VehicleManifest[];
  /** Latest tick any of those runs traverses it. -1 when none do. */
  lastPass: Tick;
  /** Zone labels whose published primary egress route uses this segment. */
  zoneLabels: string[];
  /** Midpoint of the middle segment, where the barrier glyph sits. */
  mid: LngLat;
  /** Bearing of that segment, so the barrier lies ACROSS the carriageway. */
  bearing: number;
  /** Shared by reference across every closure on this track: "1 of 97 frames
   *  observed", so the tooltip can qualify a closure time without recounting. */
  note: TrackNote;
}

interface TrackNote {
  observed: number;
  total: number;
}

/**
 * The tier, at the playhead.
 *
 * Time-aware by construction: `lastPass > t` means a run has not yet reached
 * this segment, so a closure that is already in force is in front of it.
 */
function roadblockTier(d: RoadblockDatum, t: Tick): RoadblockTier {
  if (d.runs.length === 0) return "clear";
  return d.lastPass > t ? "ahead" : "route";
}

// ─────────────────────────────────────────────────────────────────────────────
// Precompute — once per (track, network, plan, zones), never per frame
// ─────────────────────────────────────────────────────────────────────────────

interface Closures {
  network: RoadNetwork | null;
  plan: EvacPlan | null;
  zones: ZoneLayer | null;
  /** Ascending by `closedAt`, so the playhead slice is a binary search. */
  sorted: RoadblockDatum[];
  /** Subset with at least one dispatch run on them, same ordering. */
  onRoute: RoadblockDatum[];
  /** Latest tick ANY dispatch run is still on a closed segment's road. Past it,
   *  no closure can possibly be ahead of a vehicle, so the alarm short-circuits. */
  lastPassEver: Tick;
}

/**
 * One entry PER PLAN, not one per track.
 *
 * The split view renders two panes off the same hazard track with different
 * plans — the planned run carries 79 manifests, the baseline carries none — and
 * a single-slot cache would miss on every alternation, so both panes would pay
 * a full 97-frame walk and 4,008 datum allocations thirty times a second. Same
 * trap `frameMemo` in derive.ts calls out by name. The list is at most as long
 * as the runs a scenario has.
 *
 * The baseline pane's answer is not a degraded one, incidentally: with no
 * manifests every closure resolves to tier `clear`, which is exactly true —
 * a run that dispatches nothing has no dispatch route for the fire to cut.
 */
const closureCache = new WeakMap<HazardTrack, Closures[]>();

function closuresFor(
  hazard: HazardTrack | null,
  network: RoadNetwork | null,
  plan: EvacPlan | null,
  zones: ZoneLayer | null,
): Closures | null {
  if (!hazard || !network) return null;
  let entries = closureCache.get(hazard);
  if (!entries) {
    entries = [];
    closureCache.set(hazard, entries);
  }
  const hit = entries.find((e) => e.network === network && e.plan === plan && e.zones === zones);
  if (hit) return hit;

  let observed = 0;
  for (const f of hazard.frames) if (f.provenance === "observed") observed++;
  const note: TrackNote = { observed, total: hazard.frames.length };

  const usage = routeUsage(plan, network);
  const sorted: RoadblockDatum[] = [];
  const seen = new Set<string>();

  // Frames are already ascending, and `closedEdgeIds` is cumulative, so the
  // first frame an id appears in is the frame the fire reached that road.
  for (const frame of hazard.frames) {
    for (const id of closedEdgeSet(frame)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const edge = edgeById(network, id);
      // A closure naming an edge the network no longer has is a payload skew
      // between hazard.json and network.json. Dropping it is right — drawing a
      // roadblock on geometry we do not have would mean inventing the geometry.
      if (!edge || edge.geometry.length < 2) continue;
      const runs = usage.get(id);
      const anchor = anchorOf(edge.geometry);
      sorted.push({
        _rk: "roadblock",
        edge,
        closedAt: frame.t,
        provenance: frame.provenance,
        runs: runs ? runs.manifests : EMPTY_RUNS,
        lastPass: runs ? runs.lastPass : -1,
        zoneLabels: zones ? zonesUsingEdge(zones, id).map((z) => z.label) : [],
        mid: anchor.mid,
        bearing: anchor.bearing,
        note,
      });
    }
  }

  const onRoute = sorted.filter((d) => d.runs.length > 0);
  let lastPassEver = -1;
  for (const d of onRoute) if (d.lastPass > lastPassEver) lastPassEver = d.lastPass;
  const out: Closures = { network, plan, zones, sorted, onRoute, lastPassEver };
  entries.push(out);
  announce(hazard, out);
  return out;
}

const EMPTY_RUNS: VehicleManifest[] = [];

/**
 * Say out loud, once, how much of this is modelled.
 *
 * Same discipline the pipeline scripts use for a failed fetch and the same one
 * `useVehicleState` uses for the moving pucks: the number that would otherwise
 * pass for observed gets named in the console before anyone reads it off a map.
 */
function announce(hazard: HazardTrack, c: Closures): void {
  // No guard needed: a Closures object is built exactly once per
  // (track, network, plan, zones), so this fires once per run — which is what
  // the split view wants, because the two panes have different route counts.
  const note = c.sorted[0]?.note;
  const first = c.sorted[0];
  console.info(
    `[roadblocks] ${hazard.scenarioId} ${c.plan?.kind ?? "no-plan"}: ${c.sorted.length} road ` +
      `closures over the run, ` +
      `${c.onRoute.length} of them on a segment a dispatch run uses. First closure at ` +
      `${first ? formatTick(first.closedAt, false) : "n/a"}. Closure is NOT observed: it is ` +
      `derived by scripts/fetch-hazard from the perimeter footprint, and only ` +
      `${note?.observed ?? 0} of ${note?.total ?? 0} frames in this track are observed ` +
      `perimeters — the rest are interpolated between observations, so a closure TIME on this ` +
      `map is modelled to the nearest frame step. Source: ${hazard.source}`,
  );
}

interface EdgeUsage {
  manifests: VehicleManifest[];
  lastPass: Tick;
}

const usageCache = new WeakMap<EvacPlan, { network: RoadNetwork; usage: Map<string, EdgeUsage> }>();

/**
 * Which dispatch runs drive which edges, and when they last do.
 *
 * Read off the manifests' own routed geometry rather than guessed: each path
 * SEGMENT is matched to the edge that owns that segment. Segment matching, not
 * vertex matching — an intersection vertex belongs to every road that meets
 * there, so a vertex index would credit a bus with every side street it passes.
 * On camp-fire-2018 this resolves 19,631 of 19,634 path segments.
 */
function routeUsage(plan: EvacPlan | null, network: RoadNetwork): Map<string, EdgeUsage> {
  if (!plan) return new Map();
  const hit = usageCache.get(plan);
  if (hit && hit.network === network) return hit.usage;

  const idx = segmentIndex(network);
  const usage = new Map<string, EdgeUsage>();
  for (const m of plan.manifests) {
    const p = m.path;
    const ts = m.timestamps;
    if (!Array.isArray(p) || p.length < 2 || ts.length !== p.length) continue;
    let prev = ptKey(p[0]);
    for (let i = 1; i < p.length; i++) {
      const key = ptKey(p[i]);
      const owners = idx.get(`${prev}|${key}`);
      prev = key;
      if (!owners) continue;
      // The tick the vehicle ENTERS the segment. Using the exit tick would
      // report a bus as still upstream of a road it is already halfway down.
      const at = ts[i - 1];
      for (const id of owners) {
        let u = usage.get(id);
        if (!u) {
          u = { manifests: [], lastPass: -1 };
          usage.set(id, u);
        }
        if (!u.manifests.includes(m)) u.manifests.push(m);
        if (at > u.lastPass) u.lastPass = at;
      }
    }
  }
  usageCache.set(plan, { network, usage });
  return usage;
}

const segmentCache = new WeakMap<RoadNetwork, Map<string, string[]>>();

/** Segment key -> the edge ids that own it, both directions. A run may drive an
 *  edge against its digitised order. */
function segmentIndex(network: RoadNetwork): Map<string, string[]> {
  const hit = segmentCache.get(network);
  if (hit) return hit;
  const idx = new Map<string, string[]>();
  for (const edge of network.edges) {
    const g = edge.geometry;
    for (let i = 0; i < g.length - 1; i++) {
      const a = ptKey(g[i]);
      const b = ptKey(g[i + 1]);
      for (const key of [`${a}|${b}`, `${b}|${a}`]) {
        const bucket = idx.get(key);
        if (bucket) {
          if (!bucket.includes(edge.id)) bucket.push(edge.id);
        } else {
          idx.set(key, [edge.id]);
        }
      }
    }
  }
  segmentCache.set(network, idx);
  return idx;
}

function ptKey(p: LngLat): string {
  return `${p[0].toFixed(KEY_DP)},${p[1].toFixed(KEY_DP)}`;
}

/** Where the barrier sits and which way it faces: the middle segment of the
 *  edge, so the mark lands on the carriageway rather than on a junction. */
function anchorOf(g: LngLat[]): { mid: LngLat; bearing: number } {
  const i = Math.max(0, Math.floor((g.length - 1) / 2));
  const a = g[i];
  const b = g[Math.min(g.length - 1, i + 1)];
  const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const lat = ((a[1] + b[1]) * Math.PI) / 360;
  const bearing = (Math.atan2((b[0] - a[0]) * Math.cos(lat), b[1] - a[1]) * 180) / Math.PI;
  return { mid, bearing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame slice. Closures only change on a hazard frame boundary, so this is
// keyed on the frame's own tick and never on the 30fps playhead.
// ─────────────────────────────────────────────────────────────────────────────

interface Slice {
  key: number;
  all: RoadblockDatum[];
  onRoute: RoadblockDatum[];
}

const sliceCache = new WeakMap<Closures, Slice>();

/** Closures in force at this hazard frame. Cached on the FRAME's tick, never on
 *  the playhead: the scrubber steps the same frame thirty times a second. */
function sliceAt(c: Closures, frameT: Tick): Slice {
  const hit = sliceCache.get(c);
  if (hit && hit.key === frameT) return hit;
  // `sorted` is ascending by closedAt, so the set in force is a prefix.
  let lo = 0;
  let hi = c.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.sorted[mid].closedAt <= frameT) lo = mid + 1;
    else hi = mid;
  }
  const all = c.sorted.slice(0, lo);
  const slice: Slice = { key: frameT, all, onRoute: all.filter((d) => d.runs.length > 0) };
  sliceCache.set(c, slice);
  return slice;
}

/**
 * Closures a run has NOT yet reached at the playhead.
 *
 * Deliberately outside the frame cache: this one depends on the continuous
 * playhead, not on the hazard frame, and caching it against the frame would
 * make the alarm a frame stale in either direction. The guard is what keeps it
 * free — no run on camp-fire-2018 is still moving after T+02:18, so past that
 * tick the answer is empty without touching the array at all.
 */
function aheadAt(c: Closures, slice: Slice, t: Tick): RoadblockDatum[] {
  if (t >= c.lastPassEver || slice.onRoute.length === 0) return EMPTY_AHEAD;
  const out = slice.onRoute.filter((d) => d.lastPass > t);
  return out.length > 0 ? out : EMPTY_AHEAD;
}

const EMPTY_AHEAD: RoadblockDatum[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// buildRoadblockLayers — pure, so the split view can drive two stacks
// ─────────────────────────────────────────────────────────────────────────────

export interface RoadblockLayerArgs {
  hazard: HazardTrack | null;
  network: RoadNetwork | null;
  /** Supplies the dispatch routes. Null collapses every closure to `clear`. */
  plan: EvacPlan | null;
  /** Supplies the "this cuts BUT-XXX's published egress" line. Optional. */
  zones?: ZoneLayer | null;
  t: Tick;
  layers: LayerVisibility;
  selection: Selection;
  /** Camera zoom. Gates how much of the closed network draws. */
  zoom?: number;
  reduceMotion?: boolean;
  idPrefix?: string;
  interactive?: boolean;
}

export function buildRoadblockLayers(args: RoadblockLayerArgs): Layer[] {
  const { hazard, network, plan, t, layers, selection } = args;
  const prefix = args.idPrefix ? `${args.idPrefix}-` : "";
  const pick = args.interactive !== false;
  const out: Layer[] = [];

  /* Gated on the hazard toggle, not a new LayerVisibility key: a closure is a
     hazard fact — it is where the perimeter crossed the road — and minting a
     `roadblocks` key would mean editing store.ts, which this module does not. */
  if (!layers.roadblocks) return out;

  const c = closuresFor(hazard, network, plan, args.zones ?? null);
  if (!c || c.sorted.length === 0) return out;

  const frameT = hazardFrameAt(hazard, t).t;
  const slice = sliceAt(c, frameT);
  if (slice.all.length === 0) return out;
  const ahead = aheadAt(c, slice, t);

  const zoom = args.zoom ?? 0;
  const showAll = zoom >= ROADBLOCK_ZOOM.all;
  const lines = showAll ? slice.all : slice.onRoute;
  if (lines.length === 0) return out;

  const selectedEdgeId = selection.kind === "edge" ? selection.id : null;

  // ── 1. plan underlay ──────────────────────────────────────────────────────
  // Cyan is the plan's colour everywhere else on this console, so a cyan casing
  // under an ember line says exactly one thing: the fire is sitting on a road
  // the dispatch plan uses. Two data states, two encodings, no new hue.
  if (slice.onRoute.length > 0) {
    out.push(
      new PathLayer<RoadblockDatum>({
        id: `${prefix}roadblock-route-casing`,
        data: slice.onRoute,
        pickable: false,
        widthUnits: "pixels",
        widthMinPixels: 3,
        widthMaxPixels: 22,
        capRounded: true,
        jointRounded: true,
        getPath: getRoadblockPath,
        getColor: ROUTE_CASING_COLOR,
        getWidth: 7,
      }),
    );
  }

  // ── 2. the closures ───────────────────────────────────────────────────────
  out.push(
    new PathLayer<RoadblockDatum>({
      id: `${prefix}roadblocks`,
      data: lines,
      pickable: pick,
      widthUnits: "pixels",
      widthMinPixels: 1.2,
      widthMaxPixels: 14,
      capRounded: true,
      jointRounded: true,
      getPath: getRoadblockPath,
      getColor: (d) => roadblockColor(d, t, d.edge.id === selectedEdgeId),
      getWidth: (d) => (d.runs.length > 0 ? 3.4 : 1.6),
      updateTriggers: {
        getColor: [frameT, selectedEdgeId, ahead.length],
        getWidth: [frameT],
      },
    }),
  );

  // ── 3. the alarm ──────────────────────────────────────────────────────────
  // A closure a run has NOT yet passed. Empty on camp-fire-2018 by construction
  // — the solver reads the same closure schedule — so this layer normally draws
  // nothing at all, which is the correct picture of a plan that works.
  if (ahead.length > 0) {
    const pulse = args.reduceMotion
      ? 1
      : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((t / PULSE_PERIOD) * Math.PI * 2));
    out.push(
      new PathLayer<RoadblockDatum>({
        id: `${prefix}roadblock-ahead`,
        data: ahead,
        pickable: false,
        widthUnits: "pixels",
        widthMinPixels: 4,
        widthMaxPixels: 30,
        capRounded: true,
        jointRounded: true,
        getPath: getRoadblockPath,
        getColor: [WARN_RGB[0], WARN_RGB[1], WARN_RGB[2], Math.round(120 + 110 * pulse)],
        getWidth: 11 * pulse,
        updateTriggers: { getColor: [pulse], getWidth: [pulse] },
      }),
    );
  }

  // ── 4. barrier glyphs ─────────────────────────────────────────────────────
  // Zoom-gated hard. A gate mark per closed segment at region zoom is hatching
  // where a map should be; at street zoom it is the thing the operator came for.
  const atlas = barrierAtlas();
  const marks =
    zoom >= ROADBLOCK_ZOOM.allMarks
      ? lines
      : zoom >= ROADBLOCK_ZOOM.routeMarks
        ? slice.onRoute
        : ahead;
  /* Same sublinear zoom law the fleet uses, from the same function — a barrier
     and a bus that shrink at different rates would look like two maps. */
  if (atlas && marks.length > 0) {
    out.push(...barrierLayers(atlas, marks, prefix, pick, t, frameT, glyphScale(zoom)));
  }

  return out;
}

function barrierLayers(
  atlas: BarrierAtlas,
  marks: RoadblockDatum[],
  prefix: string,
  pick: boolean,
  t: Tick,
  frameT: Tick,
  scale: number,
): Layer[] {
  return [
    new IconLayer<RoadblockDatum>({
      id: `${prefix}roadblock-mark-casing`,
      data: marks,
      pickable: false,
      iconAtlas: atlas.url,
      iconMapping: atlas.mapping,
      billboard: false,
      sizeUnits: "pixels",
      sizeScale: scale,
      sizeMinPixels: 6,
      sizeMaxPixels: 46,
      getIcon: BARRIER_CASING,
      getPosition: getRoadblockMid,
      getSize: getMarkSize,
      getAngle: getRoadblockAngle,
      getColor: MARK_CASING_COLOR,
      updateTriggers: { getSize: [frameT] },
    }),
    new IconLayer<RoadblockDatum>({
      id: `${prefix}roadblock-marks`,
      data: marks,
      pickable: pick,
      iconAtlas: atlas.url,
      iconMapping: atlas.mapping,
      billboard: false,
      sizeUnits: "pixels",
      sizeScale: scale,
      sizeMinPixels: 6,
      sizeMaxPixels: 46,
      getIcon: BARRIER_GLYPH,
      getPosition: getRoadblockMid,
      getSize: getMarkSize,
      getAngle: getRoadblockAngle,
      getColor: (d) => roadblockColor(d, t, false),
      updateTriggers: { getColor: [frameT], getSize: [frameT] },
    }),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level accessors. Stable identity, so deck never re-evaluates one
// because a closure was reallocated.
// ─────────────────────────────────────────────────────────────────────────────

const getRoadblockPath = (d: RoadblockDatum) => d.edge.geometry;
const getRoadblockMid = (d: RoadblockDatum) => d.mid;
/** deck rotates icons counter-clockwise and the barrier is authored pointing
 *  east; negating the segment bearing lands it square across the road. */
const getRoadblockAngle = (d: RoadblockDatum) => -d.bearing;
const getMarkSize = (d: RoadblockDatum) => (d.runs.length > 0 ? 21 : 15);

const BARRIER_GLYPH = () => BARRIER_ICON;
const BARRIER_CASING = () => BARRIER_CASING_ICON;
const MARK_CASING_COLOR: Color = [8, 10, 14, 225];
const ROUTE_CASING_COLOR: Color = [PLAN_RGB[0], PLAN_RGB[1], PLAN_RGB[2], 170];

/**
 * Ember for every closure — it is the fire that did this, and the fire is
 * ember everywhere on this console. What separates the tiers is WEIGHT and the
 * cyan plan casing underneath, never a second hue: a closure on a bus route is
 * not a different kind of event, it is the same event landing somewhere that
 * costs more.
 */
function roadblockColor(d: RoadblockDatum, t: Tick, selected: boolean): Color {
  const tier = roadblockTier(d, t);
  if (selected) return [255, 236, 228, 255];
  const alpha = tier === "ahead" ? 255 : tier === "route" ? 240 : 120;
  return [HAZARD_RGB[0], HAZARD_RGB[1], HAZARD_RGB[2], alpha];
}

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
  maxWidth: "290px",
  pointerEvents: "none",
  zIndex: "40",
} as Partial<CSSStyleDeclaration>;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );
}

/** Local copy of the stack's tooltip markup rather than an import: the other
 *  layer files belong to other modules and must not grow exported surface to be
 *  composed with. Same shape, so the two never look like different products. */
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
 * Roadblock tooltips. Returns null for anything it does not own, so the caller
 * chains it with the other stacks' tooltips in any order.
 */
export function roadblockTooltip(
  info: PickingInfo,
  t: Tick,
): { html: string; style: Partial<CSSStyleDeclaration> } | null {
  const d = info.object as RoadblockDatum | undefined;
  if (!d || typeof d !== "object" || d._rk !== "roadblock") return null;

  const tier = roadblockTier(d, t);
  const rows: [string, string][] = [
    ["Road class", `${d.edge.roadClass} · ${formatCount(d.edge.lanes)} ln`],
    // "Closed BY", never "closed at": the perimeter is sampled on a frame step,
    // so the true crossing sits somewhere inside the preceding interval.
    ["Closed by", formatTick(d.closedAt, false)],
  ];

  if (d.runs.length > 0) {
    rows.push(["Dispatch runs", formatCount(d.runs.length)]);
    rows.push([
      "Runs",
      d.runs
        .slice(0, 3)
        .map((m) => m.id)
        .join(" ") + (d.runs.length > 3 ? ` +${d.runs.length - 3}` : ""),
    ]);
    if (d.lastPass >= 0) {
      rows.push(["Last run through", formatTick(d.lastPass, false)]);
      const margin = d.closedAt - d.lastPass;
      rows.push([
        "Margin",
        margin >= 0
          ? `cleared ${formatShort(margin)} ahead`
          : `${formatShort(-margin)} INSIDE the closure`,
      ]);
    }
  } else {
    rows.push(["Dispatch runs", "none on this segment"]);
  }

  if (d.zoneLabels.length > 0) {
    rows.push([
      "Zone egress cut",
      d.zoneLabels.slice(0, 2).join(", ") +
        (d.zoneLabels.length > 2 ? ` +${d.zoneLabels.length - 2}` : ""),
    ]);
  }

  rows.push(["Perimeter", `${d.provenance} · ${d.note.observed}/${d.note.total} obs`]);
  // Never let a hatched road imply somebody drove past and reported it shut.
  rows.push(["Basis", "MODELLED · not a field report"]);

  const accent = tier === "ahead" ? WARN_RGB : tier === "route" ? PLAN_RGB : HAZARD_RGB;
  return {
    html: tipHtml(
      d.edge.name ?? "Unnamed road",
      `${TIER_LABEL[tier]} · ${d.edge.id}`,
      rows,
      `rgb(${accent[0]} ${accent[1]} ${accent[2]})`,
    ),
    style: TOOLTIP_STYLE,
  };
}

/**
 * Selection for the roadblock stack. A roadblock IS a road edge, so it opens
 * the corridor panel that already knows how to explain one — no new selection
 * kind, and no patch to the store's `Selection` union.
 */
export function roadblockClick(info: PickingInfo): boolean {
  const d = info.object as RoadblockDatum | undefined;
  if (!d || typeof d !== "object" || d._rk !== "roadblock") return false;
  actions.select("edge", d.edge.id);
  return true;
}

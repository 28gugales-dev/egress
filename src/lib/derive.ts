import { CONGESTION_RAMP, PARAM_AXES } from "@/lib/constants";
import { axisPosition, clamp, lerp, loadBucket, urgencyBand } from "@/lib/format";
import type {
  ContraflowOrder,
  EvacPlan,
  EvacZone,
  Facility,
  HazardFrame,
  HazardTrack,
  LngLat,
  MapFilters,
  ParamGrid,
  ReleaseWave,
  RoadEdge,
  RoadNetwork,
  RunFrame,
  RunParams,
  RunSummary,
  SimulationRun,
  Tick,
  Trip,
  ZoneLayer,
  ZoneStatus,
} from "@/types/egress";

/**
 * Pure selectors over a loaded bundle. No React, no store reads — every input
 * is an argument so these stay callable from a deck.gl layer factory, a worker,
 * or a test.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Frame lookup — on the hot path, called once per layer per animation frame.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_FRAME: RunFrame = Object.freeze({
  t: 0,
  edgeLoad: Object.freeze({}) as Record<string, number>,
  zoneRemaining: Object.freeze({}) as Record<string, number>,
  zoneStatus: Object.freeze({}) as Record<string, ZoneStatus>,
  vehiclesMoving: 0,
  vehiclesCleared: 0,
  vehiclesInHazard: 0,
  peopleCleared: 0,
  peakQueueLength: 0,
});

const EMPTY_HAZARD_FRAME: HazardFrame = Object.freeze({
  t: 0,
  rings: [],
  closedEdgeIds: [],
  provenance: "interpolated",
});

/** Index of the last element with t <= target. Clamps to 0 before the run starts. */
export function lastAtOrBefore(arr: readonly { t: Tick }[], t: Tick): number {
  let lo = 0;
  let hi = arr.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// One memo entry per run object rather than one globally: split view alternates
// baseline and planned lookups at the same t, and a single slot would thrash.
const frameMemo = new WeakMap<SimulationRun, { t: Tick; frame: RunFrame }>();

export function frameAt(run: SimulationRun | null, t: Tick): RunFrame {
  if (!run || run.frames.length === 0) return EMPTY_FRAME;
  const memo = frameMemo.get(run);
  if (memo && memo.t === t) return memo.frame;
  const frame = run.frames[lastAtOrBefore(run.frames, t)];
  frameMemo.set(run, { t, frame });
  return frame;
}

const hazardMemo = new WeakMap<HazardTrack, { t: Tick; frame: HazardFrame }>();

export function hazardFrameAt(hazard: HazardTrack | null, t: Tick): HazardFrame {
  if (!hazard || hazard.frames.length === 0) return EMPTY_HAZARD_FRAME;
  const memo = hazardMemo.get(hazard);
  if (memo && memo.t === t) return memo.frame;
  const frame = hazard.frames[lastAtOrBefore(hazard.frames, t)];
  hazardMemo.set(hazard, { t, frame });
  return frame;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter grid — sliders read an interpolated summary, never re-solve.
// ─────────────────────────────────────────────────────────────────────────────

type AxisName = keyof ParamGrid["axes"];

const AXIS_NAMES: AxisName[] = ["compliance", "shadowEvac", "noticeTime", "vehiclesPerHousehold"];

/** Booleans appear in grid keys in the order the pipeline writes them. */
const BOOL_NAMES = ["staged", "contraflow", "busDispatch"] as const;

interface GridIndex {
  /** Canonical `nums#bools` key -> summary. */
  byKey: Map<string, RunSummary>;
  /** Parsed rows, kept for the nearest-neighbour fallback on a key miss. */
  rows: { nums: number[]; bools: string; summary: RunSummary }[];
  /** Which axis each numeric slot of the key carries. */
  slotAxis: (AxisName | null)[];
  boolCount: number;
  axes: Record<AxisName, readonly number[]>;
}

const gridIndexes = new WeakMap<ParamGrid, GridIndex>();

/**
 * Quadrilinear interpolation across the four swept axes.
 *
 * Returns null for an absent grid rather than a zeroed summary: a fabricated
 * 0:00 clearance time is a number nobody can trace, and this deck refuses to
 * show one. A grid with entries always answers — out-of-range params clamp to
 * the swept range and a key miss falls back to the nearest sampled corner —
 * so the non-null overload holds for every grid loadScenario hands out.
 */
export function summaryFor(grid: ParamGrid, params: RunParams): RunSummary;
export function summaryFor(grid: ParamGrid | null, params: RunParams): RunSummary | null;
export function summaryFor(grid: ParamGrid | null, params: RunParams): RunSummary | null {
  if (!grid) return null;
  const idx = indexGrid(grid);
  if (idx.rows.length === 0) return null;

  const pos = {
    compliance: axisPosition(idx.axes.compliance, params.compliance),
    shadowEvac: axisPosition(idx.axes.shadowEvac, params.shadowEvac),
    noticeTime: axisPosition(idx.axes.noticeTime, params.noticeTime),
    vehiclesPerHousehold: axisPosition(idx.axes.vehiclesPerHousehold, params.vehiclesPerHousehold),
  } as Record<AxisName, { i: number; j: number; f: number }>;

  const bools = boolSignature(idx.boolCount, params);

  let weightTotal = 0;
  const acc: RunSummary = {
    clearanceTime: 0,
    vehiclesInHazardAtBurnover: 0,
    peopleInHazardAtBurnover: 0,
    peakQueueLength: 0,
    totalEvacuated: 0,
    unassigned: 0,
    meanEgressUtilization: 0,
  };

  // 2^4 corners; a zero-weight corner (slider sitting exactly on a node) is skipped.
  for (let corner = 0; corner < 16; corner++) {
    let w = 1;
    const pick: Record<AxisName, number> = {
      compliance: 0,
      shadowEvac: 0,
      noticeTime: 0,
      vehiclesPerHousehold: 0,
    };
    for (let a = 0; a < AXIS_NAMES.length; a++) {
      const name = AXIS_NAMES[a];
      const high = (corner >> a) & 1;
      const p = pos[name];
      w *= high ? p.f : 1 - p.f;
      pick[name] = high ? p.j : p.i;
    }
    if (w <= 0) continue;

    const nums = idx.slotAxis.map((name, slot) =>
      name ? idx.axes[name][pick[name]] : (idx.rows[0]?.nums[slot] ?? 0),
    );
    const summary = idx.byKey.get(canonical(nums, bools)) ?? nearestRow(idx, nums, bools);
    if (!summary) continue;

    weightTotal += w;
    acc.clearanceTime += summary.clearanceTime * w;
    acc.vehiclesInHazardAtBurnover += summary.vehiclesInHazardAtBurnover * w;
    acc.peopleInHazardAtBurnover += summary.peopleInHazardAtBurnover * w;
    acc.peakQueueLength += summary.peakQueueLength * w;
    acc.totalEvacuated += summary.totalEvacuated * w;
    acc.unassigned += summary.unassigned * w;
    acc.meanEgressUtilization += summary.meanEgressUtilization * w;
  }

  if (weightTotal <= 0) return null;

  return {
    clearanceTime: Math.round(acc.clearanceTime / weightTotal),
    vehiclesInHazardAtBurnover: Math.round(acc.vehiclesInHazardAtBurnover / weightTotal),
    peopleInHazardAtBurnover: Math.round(acc.peopleInHazardAtBurnover / weightTotal),
    peakQueueLength: Math.round(acc.peakQueueLength / weightTotal),
    totalEvacuated: Math.round(acc.totalEvacuated / weightTotal),
    unassigned: Math.round(acc.unassigned / weightTotal),
    meanEgressUtilization: acc.meanEgressUtilization / weightTotal,
  };
}

/**
 * The key layout is inferred from the entries themselves rather than assumed:
 * the type doc and the axis list disagree on how many numeric parts a key
 * carries, and guessing wrong would silently interpolate the wrong dimension.
 */
function indexGrid(grid: ParamGrid): GridIndex {
  const cached = gridIndexes.get(grid);
  if (cached) return cached;

  const axes: Record<AxisName, readonly number[]> = {
    compliance: pickAxis(grid.axes?.compliance, PARAM_AXES.compliance),
    shadowEvac: pickAxis(grid.axes?.shadowEvac, PARAM_AXES.shadowEvac),
    noticeTime: pickAxis(grid.axes?.noticeTime, PARAM_AXES.noticeTime),
    vehiclesPerHousehold: pickAxis(
      grid.axes?.vehiclesPerHousehold,
      PARAM_AXES.vehiclesPerHousehold,
    ),
  };

  const rows: GridIndex["rows"] = [];
  const byKey = new Map<string, RunSummary>();
  const slotValues: Set<number>[] = [];
  let boolCount = 0;

  for (const [rawKey, summary] of Object.entries(grid.entries ?? {})) {
    const nums: number[] = [];
    const boolParts: string[] = [];
    for (const part of rawKey.split("|")) {
      const lowered = part.trim().toLowerCase();
      // Only a spelled-out boolean is a lever: a bare 0 or 1 is an axis value
      // (shadowEvac 0, vehiclesPerHousehold 1.0).
      if (lowered === "true" || lowered === "false") {
        boolParts.push(lowered === "true" ? "1" : "0");
        continue;
      }
      const n = Number(lowered);
      if (Number.isFinite(n)) {
        nums.push(n);
        const slot = nums.length - 1;
        if (!slotValues[slot]) slotValues[slot] = new Set<number>();
        slotValues[slot].add(n);
      }
    }
    boolCount = Math.max(boolCount, boolParts.length);
    const bools = boolParts.join("");
    rows.push({ nums, bools, summary });
    byKey.set(canonical(nums, bools), summary);
  }

  const index: GridIndex = {
    byKey,
    rows,
    slotAxis: assignSlots(slotValues, axes),
    boolCount,
    axes,
  };
  gridIndexes.set(grid, index);
  return index;
}

function pickAxis(v: number[] | undefined, fallback: readonly number[]): readonly number[] {
  return v && v.length > 0 ? v : fallback;
}

/** Match each numeric slot to the axis whose value set it overlaps most. */
function assignSlots(
  slotValues: Set<number>[],
  axes: Record<AxisName, readonly number[]>,
): (AxisName | null)[] {
  const taken = new Set<AxisName>();
  return slotValues.map((values, slot) => {
    let best: AxisName | null = null;
    let bestScore = 0;
    for (const name of AXIS_NAMES) {
      if (taken.has(name)) continue;
      const axis = axes[name];
      let hit = 0;
      for (const v of values) if (axis.some((a) => Math.abs(a - v) < 1e-9)) hit++;
      const score = hit / Math.max(1, values.size + axis.length - hit);
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    // Ambiguous slot: fall back to the declared axis order for that position.
    if (!best) best = AXIS_NAMES[slot] && !taken.has(AXIS_NAMES[slot]) ? AXIS_NAMES[slot] : null;
    if (best) taken.add(best);
    return best;
  });
}

function boolSignature(boolCount: number, params: RunParams): string {
  let out = "";
  for (let i = 0; i < boolCount && i < BOOL_NAMES.length; i++) {
    out += params[BOOL_NAMES[i]] ? "1" : "0";
  }
  return out;
}

function canonical(nums: number[], bools: string): string {
  return `${nums.map((n) => String(n)).join("|")}#${bools}`;
}

/** Closest sampled corner, preferring rows with the same lever settings. */
function nearestRow(idx: GridIndex, nums: number[], bools: string): RunSummary | null {
  let best: RunSummary | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const row of idx.rows) {
    let d = row.bools === bools ? 0 : 1e6;
    for (let s = 0; s < nums.length; s++) {
      const name = idx.slotAxis[s];
      const span = name ? spanOf(idx.axes[name]) : 1;
      d += Math.abs((row.nums[s] ?? 0) - nums[s]) / span;
    }
    if (d < bestD) {
      bestD = d;
      best = row.summary;
    }
  }
  return best;
}

function spanOf(axis: readonly number[]): number {
  const s = axis[axis.length - 1] - axis[0];
  return s === 0 ? 1 : Math.abs(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zones
// ─────────────────────────────────────────────────────────────────────────────

export function zoneStatusAt(run: SimulationRun | null, t: Tick, zoneId: string): ZoneStatus {
  return frameAt(run, t).zoneStatus[zoneId] ?? "held";
}

/**
 * Every field of MapFilters, applied together.
 *
 * `facilityKinds` is deliberately not applied here — a zone carries no facility
 * linkage, so that filter belongs to the facility layer.
 */
export function visibleZones(
  zones: ZoneLayer | EvacZone[],
  filters: MapFilters,
  run: SimulationRun | null,
  t: Tick,
): EvacZone[] {
  const list = Array.isArray(zones) ? zones : zones.zones;
  const frame = frameAt(run, t);
  const q = filters.query.trim().toLowerCase();
  const statusSet = filters.statuses.length > 0 ? new Set(filters.statuses) : null;

  return list.filter((z) => {
    if (filters.maxHazardEta !== null && z.hazardEta > filters.maxHazardEta) return false;
    if (z.noVehicleHouseholds < filters.minNoVehicle) return false;
    if (filters.minUrgency > 0 && urgencyBand(z.hazardEta - t) < filters.minUrgency) return false;
    if (statusSet && run) {
      // Without a run there is no status to test, so the filter stays inert
      // rather than emptying the map before the simulation lands.
      if (!statusSet.has(frame.zoneStatus[z.id] ?? "held")) return false;
    }
    if (q) {
      const hay = `${z.label} ${z.primaryRouteLabel} ${z.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trips and plan
// ─────────────────────────────────────────────────────────────────────────────

const tripMemo = new WeakMap<SimulationRun, { t: Tick; trips: Trip[] }>();

/** Trips whose [first, last] timestamp span contains t. */
export function activeTrips(run: SimulationRun | null, t: Tick): Trip[] {
  if (!run || run.trips.length === 0) return [];
  const memo = tripMemo.get(run);
  if (memo && memo.t === t) return memo.trips;
  const trips = run.trips.filter((trip) => {
    const n = trip.timestamps.length;
    return n > 0 && trip.timestamps[0] <= t && trip.timestamps[n - 1] >= t;
  });
  tripMemo.set(run, { t, trips });
  return trips;
}

export function waveForZone(plan: EvacPlan | null, zoneId: string): ReleaseWave | null {
  if (!plan) return null;
  return plan.waves.find((w) => w.zoneIds.includes(zoneId)) ?? null;
}

/** The wave that pins clearance. Falls back to the most saturated wave when the
 *  solver did not flag one. */
export function bindingWave(plan: EvacPlan | null): ReleaseWave | null {
  if (!plan || plan.waves.length === 0) return null;
  const flagged = plan.waves.find((w) => w.binding);
  if (flagged) return flagged;
  return plan.waves.reduce((best, w) =>
    w.egressLoad > best.egressLoad ||
    (w.egressLoad === best.egressLoad && w.departAt > best.departAt)
      ? w
      : best,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding
// ─────────────────────────────────────────────────────────────────────────────

/** Load fraction to a ramp colour, interpolated between stops so a congestion
 *  build-up reads as a gradient rather than five discrete jumps. */
export function congestionColorFor(load: number): [number, number, number] {
  const last = CONGESTION_RAMP.length - 1;
  if (!Number.isFinite(load) || load <= 0) return CONGESTION_RAMP[0];
  const i = loadBucket(load, CONGESTION_RAMP.length);
  if (i >= last) return CONGESTION_RAMP[last];
  const exact = clamp(load, 0, 1) * last;
  const f = clamp(exact - i, 0, 1);
  const a = CONGESTION_RAMP[i];
  const b = CONGESTION_RAMP[i + 1];
  return [
    Math.round(lerp(a[0], b[0], f)),
    Math.round(lerp(a[1], b[1], f)),
    Math.round(lerp(a[2], b[2], f)),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Network, hazard closure and exposure
//
// Everything below answers a question the inspector asks about ONE picked
// entity, so the cost is paid on selection rather than per frame. Where a scan
// is O(frames) it is memoised against the run or track object, never against
// `t` — the scrubber steps the same frame object 30 times a second.
// ─────────────────────────────────────────────────────────────────────────────

const closedMemo = new WeakMap<HazardFrame, Set<string>>();

/** Edge ids the hazard has rendered impassable at this frame. A Set, not a
 *  linear scan: a late Camp Fire frame closes about 4,000 edges. */
export function closedEdgeSet(frame: HazardFrame): Set<string> {
  let s = closedMemo.get(frame);
  if (!s) {
    s = new Set(frame.closedEdgeIds);
    closedMemo.set(frame, s);
  }
  return s;
}

const networkEdgeMemo = new WeakMap<RoadNetwork, Map<string, RoadEdge>>();

export function edgeById(network: RoadNetwork | null, id: string | null): RoadEdge | null {
  if (!network || !id) return null;
  let idx = networkEdgeMemo.get(network);
  if (!idx) {
    idx = new Map(network.edges.map((e) => [e.id, e]));
    networkEdgeMemo.set(network, idx);
  }
  return idx.get(id) ?? null;
}

const zonesByEdgeMemo = new WeakMap<object, Map<string, EvacZone[]>>();

/** Zones whose published primary egress route runs over this edge. */
export function zonesUsingEdge(zones: ZoneLayer | EvacZone[], edgeId: string): EvacZone[] {
  const list = Array.isArray(zones) ? zones : zones.zones;
  let idx = zonesByEdgeMemo.get(list as object);
  if (!idx) {
    idx = new Map<string, EvacZone[]>();
    for (const z of list) {
      for (const eid of z.primaryRouteEdgeIds) {
        const bucket = idx.get(eid);
        if (bucket) bucket.push(z);
        else idx.set(eid, [z]);
      }
    }
    zonesByEdgeMemo.set(list as object, idx);
  }
  return idx.get(edgeId) ?? [];
}

/** The contraflow order that reverses this edge, if the plan issues one. */
export function contraflowFor(plan: EvacPlan | null, edgeId: string): ContraflowOrder | null {
  if (!plan) return null;
  return plan.contraflow.find((o) => o.edgeIds.includes(edgeId)) ?? null;
}

export function waveByNumber(plan: EvacPlan | null, wave: number): ReleaseWave | null {
  if (!plan) return null;
  return plan.waves.find((w) => w.wave === wave) ?? null;
}

export interface ZoneEgress {
  /** Segments on the zone's published primary route. */
  segments: number;
  /** Of those, how many the hazard has closed at this instant. */
  closed: number;
  open: number;
  /** Worst load fraction across the segments still open. -1 when unknown. */
  worstLoad: number;
  /** Every segment of the primary route is closed. The loud case. */
  cutoff: boolean;
  /** The zone was published with no primary route at all. Louder still. */
  routeless: boolean;
}

/**
 * Whether this zone still has a way out at the playhead.
 *
 * `routeless` and `cutoff` are kept apart on purpose: one is a gap in the
 * published plan, the other is the fire taking the road. An operator does a
 * different thing about each.
 */
export function zoneEgress(
  zone: EvacZone,
  hazardFrame: HazardFrame | null,
  runFrame: RunFrame | null,
): ZoneEgress {
  const ids = zone.primaryRouteEdgeIds;
  if (ids.length === 0) {
    return { segments: 0, closed: 0, open: 0, worstLoad: -1, cutoff: false, routeless: true };
  }
  const closed = hazardFrame ? closedEdgeSet(hazardFrame) : null;
  let closedCount = 0;
  let worstLoad = -1;
  for (const id of ids) {
    if (closed?.has(id)) {
      closedCount++;
      continue;
    }
    if (runFrame) {
      const load = runFrame.edgeLoad[id] ?? 0;
      if (load > worstLoad) worstLoad = load;
    }
  }
  const open = ids.length - closedCount;
  return {
    segments: ids.length,
    closed: closedCount,
    open,
    worstLoad,
    cutoff: open === 0,
    routeless: false,
  };
}

export interface ZoneClearance {
  /** Households the run reports in the zone at the first frame that carries it. */
  initial: number;
  /** Households still inside at the playhead. */
  remaining: number;
  /** First tick at which the zone reports nobody left. Null when it never does. */
  clearedAt: Tick | null;
  /** The run window ends with households still inside this zone. */
  unfinished: boolean;
}

type ClearanceScan = Omit<ZoneClearance, "remaining">;

const clearanceMemo = new WeakMap<SimulationRun, Map<string, ClearanceScan>>();

/**
 * Modelled clearance for one zone.
 *
 * Returns null when the run never mentions the zone rather than reporting a
 * clearance of zero: a zone the solver never touched has an unknown clearance,
 * not an instant one.
 */
export function zoneClearance(
  run: SimulationRun | null,
  zoneId: string,
  t: Tick,
): ZoneClearance | null {
  if (!run || run.frames.length === 0) return null;
  let byZone = clearanceMemo.get(run);
  if (!byZone) {
    byZone = new Map<string, ClearanceScan>();
    clearanceMemo.set(run, byZone);
  }
  let scan = byZone.get(zoneId);
  if (!scan) {
    scan = scanClearance(run, zoneId);
    byZone.set(zoneId, scan);
  }
  if (scan.initial < 0) return null;
  const remaining = frameAt(run, t).zoneRemaining[zoneId] ?? 0;
  return { ...scan, remaining };
}

function scanClearance(run: SimulationRun, zoneId: string): ClearanceScan {
  let initial = -1;
  let clearedAt: Tick | null = null;
  let seenPositive = false;
  let endsPositive = false;
  for (const f of run.frames) {
    const v = f.zoneRemaining[zoneId];
    if (v === undefined) continue;
    if (initial < 0) initial = v;
    if (v > 0) {
      seenPositive = true;
      endsPositive = true;
      // A zone that refills after briefly emptying has not cleared yet.
      clearedAt = null;
    } else {
      endsPositive = false;
      if (seenPositive && clearedAt === null) clearedAt = f.t;
    }
  }
  return { initial, clearedAt, unfinished: endsPositive };
}

export interface FacilityExposure {
  /** Tick at which the hazard footprint first covers this facility. */
  atRisk: Tick | null;
  /**
   * "payload"  — the pipeline stamped `atRiskFrom` and we are quoting it.
   * "derived"  — we tested the point against the perimeter rings in the browser.
   * "clear"    — tested, never inside any frame.
   * "unknown"  — no hazard track to test against.
   */
  basis: "payload" | "derived" | "clear" | "unknown";
  /** Provenance of the hazard frame that produced a derived time. */
  frameProvenance: HazardFrame["provenance"] | null;
}

const exposureMemo = new WeakMap<HazardTrack, Map<string, FacilityExposure>>();

/**
 * When the fire reaches a facility.
 *
 * Prefers the pipeline's own `atRiskFrom`. When that is absent the answer is
 * computed here, from the same NIFC perimeter rings the map draws, and labelled
 * `derived` so nothing on screen can pass a browser-side test off as fetched.
 */
export function facilityExposure(facility: Facility, hazard: HazardTrack | null): FacilityExposure {
  if (facility.atRiskFrom != null) {
    return { atRisk: facility.atRiskFrom, basis: "payload", frameProvenance: null };
  }
  if (!hazard || hazard.frames.length === 0) {
    return { atRisk: null, basis: "unknown", frameProvenance: null };
  }
  let byFacility = exposureMemo.get(hazard);
  if (!byFacility) {
    byFacility = new Map<string, FacilityExposure>();
    exposureMemo.set(hazard, byFacility);
  }
  const hit = byFacility.get(facility.id);
  if (hit) return hit;

  let out: FacilityExposure = { atRisk: null, basis: "clear", frameProvenance: null };
  for (const frame of hazard.frames) {
    if (pointInRings(facility.position, frame.rings)) {
      out = { atRisk: frame.t, basis: "derived", frameProvenance: frame.provenance };
      break;
    }
  }
  byFacility.set(facility.id, out);
  return out;
}

/** Ray casting. Rings are disjoint fire fronts, so the test is "inside any
 *  ring" — not an even-odd winding taken across all of them at once. */
export function pointInRings(point: LngLat, rings: LngLat[][]): boolean {
  for (const ring of rings) if (pointInRing(point, ring)) return true;
  return false;
}

function pointInRing(point: LngLat, ring: LngLat[]): boolean {
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

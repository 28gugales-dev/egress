import { edgeById, frameAt, zonesUsingEdge } from "@/lib/derive";
import { formatCount, formatDuration, formatShort, formatTick } from "@/lib/format";
import type {
  EvacZone,
  HazardTrack,
  IncidentEvent,
  IncidentEventKind,
  IncidentTone,
  LngLat,
  RoadNetwork,
  ScenarioMeta,
  SimulationRun,
  Tick,
  ZoneLayer,
  ZoneStatus,
} from "@/types/egress";

/**
 * The incident feed: what the run DID, as a log, ordered by the playhead.
 *
 * Pure derivation over payloads already on disk. No React, no store reads, no
 * fetch — every input is an argument, exactly like derive.ts, so the whole feed
 * is reproducible from the run file alone.
 *
 * ─── Where every event comes from ───────────────────────────────────────────
 *
 * Both runs, both scenarios (this is what keeps the feed from ever going
 * silent, including the structurally quietest combination — palisades on the
 * baseline run, which carries no contraflow, no manifests and one wave):
 *
 *   ignition          scenario meta + zone layer
 *   wave              run.plan.waves            (baseline carries exactly one)
 *   ordered/flowing/  run.frames[].zoneStatus transitions, aggregated per frame
 *   cleared/cutoff/
 *   restored
 *   corridor-closed   hazard.frames[].closedEdgeIds ∩ zone primaryRouteEdgeIds
 *   exposure          run.frames[].vehiclesInHazard first crossing and peak
 *   burnover          meta.burnoverAt + run.summary.vehiclesInHazardAtBurnover
 *   clearance         run.summary.clearanceTime
 *
 * Planned runs only, BY CONSTRUCTION — the baseline plans carry neither, and
 * the feed says nothing rather than inventing something:
 *
 *   contraflow-on/off run.plan.contraflow
 *   pickup / drop     run.plan.manifests
 *
 * Baseline runs only, BY CONSTRUCTION — the planned runs carry no validation
 * block, because a counterfactual has no observed outcome to be checked
 * against:
 *
 *   validation        run.validation
 *
 * Deliberately NOT sourced from: public/data/<id>/context/*, hazard-field.json,
 * official-zones.geojson or detail/*. Those payloads exist for one scenario and
 * not the other, and an event that fires on camp-fire-2018 and silently never
 * fires on palisades-fire-2025 is worse than no event at all.
 *
 * Copy discipline: counts, ticks and road names are composed here; anything
 * that reads as a judgement (a wave's rationale, a contraflow order's label,
 * the validation note) is quoted verbatim from the payload. Exposure is stated
 * as vehicles and households inside a footprint. Never as lives.
 */

export interface IncidentSources {
  run: SimulationRun | null;
  zones: ZoneLayer | null;
  network: RoadNetwork | null;
  hazard: HazardTrack | null;
  /** Null only before a bundle lands, in which case `run` is null too. */
  meta: ScenarioMeta | null;
}

interface ResolvedSources extends IncidentSources {
  meta: ScenarioMeta;
}

const EMPTY: IncidentEvent[] = [];

/**
 * Sorting weight WITHIN one tick. Higher is louder, and the feed renders newest
 * first, so the loudest thing that happened on a frame lands at the top of that
 * frame's block rather than under three pickups.
 */
const RANK: Record<IncidentEventKind, number> = {
  ignition: 0,
  validation: 1,
  clearance: 2,
  "contraflow-off": 3,
  cleared: 4,
  restored: 5,
  drop: 6,
  pickup: 7,
  flowing: 8,
  ordered: 9,
  "contraflow-on": 10,
  wave: 11,
  exposure: 12,
  "corridor-closed": 13,
  cutoff: 14,
  burnover: 15,
};

/**
 * One entry per run object rather than one global slot: split view builds both
 * feeds, and a single slot would rebuild 250k hazard-edge tests on every swap.
 * Keying on the run alone is safe because a run only ever reaches this module
 * paired with its own bundle's zones, network and hazard.
 */
const memo = new WeakMap<SimulationRun, IncidentEvent[]>();

export function incidentEvents(src: IncidentSources): IncidentEvent[] {
  const run = src.run;
  if (!run || run.frames.length === 0 || !src.meta) return EMPTY;
  const hit = memo.get(run);
  if (hit) return hit;
  const built = build({ ...src, meta: src.meta }, run);
  memo.set(run, built);
  return built;
}

/** How many events have fired at or before `t`. Binary search — this is read on
 *  the playhead's path, 30 times a second. */
export function incidentCountAt(events: readonly IncidentEvent[], t: Tick): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─────────────────────────────────────────────────────────────────────────────

function build(src: ResolvedSources, run: SimulationRun): IncidentEvent[] {
  const zones = src.zones?.zones ?? [];
  const zoneById = new Map<string, EvacZone>(zones.map((z) => [z.id, z]));
  const out: IncidentEvent[] = [];

  pushIgnition(out, src, zones);
  pushWaves(out, run, zoneById);
  pushZoneTransitions(out, run, zoneById);
  pushCorridorClosures(out, src, run, zones);
  pushContraflow(out, run, src.network);
  pushDispatch(out, run, src.meta);
  pushExposure(out, run);
  pushBurnover(out, run, src.meta);
  pushClearance(out, run);
  pushValidation(out, run);

  out.sort((a, b) => a.t - b.t || RANK[a.kind] - RANK[b.kind] || (a.id < b.id ? -1 : 1));
  return out;
}

// ── scenario ────────────────────────────────────────────────────────────────

function pushIgnition(out: IncidentEvent[], src: ResolvedSources, zones: EvacZone[]) {
  const households = zones.reduce((n, z) => n + z.households, 0);
  const noVehicle = zones.reduce((n, z) => n + z.noVehicleHouseholds, 0);
  out.push({
    id: "ignition",
    t: 0,
    kind: "ignition",
    tone: "neutral",
    channel: "T+0",
    headline: `${src.meta.place} — ${formatCount(zones.length)} zones, ${formatCount(households)} households`,
    detail:
      noVehicle > 0
        ? `${formatCount(noVehicle)} households report no vehicle. Precomputed replay of ${src.meta.eventDate}.`
        : `Precomputed replay of ${src.meta.eventDate}.`,
    count: zones.length,
  });
}

// ── release ─────────────────────────────────────────────────────────────────

function pushWaves(out: IncidentEvent[], run: SimulationRun, zoneById: Map<string, EvacZone>) {
  for (const w of run.plan.waves) {
    const first = zoneById.get(w.zoneIds[0]);
    out.push({
      id: `wave-${w.wave}`,
      t: w.departAt,
      kind: "wave",
      tone: w.binding ? "warning" : "plan",
      channel: `Wave ${w.wave}`,
      headline: `${formatCount(w.households)} households released via ${w.routeLabel}`,
      // The solver's own words. Nothing here paraphrases them.
      detail: w.rationale,
      count: w.zoneIds.length,
      subject: { kind: "wave", id: String(w.wave) },
      focus: first?.centroid,
    });
  }
}

// ── zone status ─────────────────────────────────────────────────────────────

interface StatusGroup {
  t: Tick;
  to: ZoneStatus;
  restored: boolean;
  zoneIds: string[];
  remaining: number;
}

function pushZoneTransitions(
  out: IncidentEvent[],
  run: SimulationRun,
  zoneById: Map<string, EvacZone>,
) {
  const prev = new Map<string, ZoneStatus>();
  const firstRemaining = new Map<string, number>();
  const groups = new Map<string, StatusGroup>();

  for (const f of run.frames) {
    for (const zoneId of Object.keys(f.zoneStatus)) {
      const status = f.zoneStatus[zoneId];
      if (!firstRemaining.has(zoneId)) firstRemaining.set(zoneId, f.zoneRemaining[zoneId] ?? 0);
      const before = prev.get(zoneId) ?? "held";
      prev.set(zoneId, status);
      if (status === before || status === "held") continue;
      // A zone the run never put anybody in did not "clear", it was empty. Two
      // of camp-fire's baseline zones do exactly this on the first frame, and
      // reporting them as cleared would be an event the payload never earned.
      if (status === "cleared" && (firstRemaining.get(zoneId) ?? 0) <= 0) continue;

      const restored = before === "cutoff" && status === "flowing";
      const key = `${f.t}|${restored ? "restored" : status}`;
      let g = groups.get(key);
      if (!g) {
        g = { t: f.t, to: status, restored, zoneIds: [], remaining: 0 };
        groups.set(key, g);
      }
      g.zoneIds.push(zoneId);
      g.remaining += f.zoneRemaining[zoneId] ?? 0;
    }
  }

  for (const g of groups.values()) {
    const kind: IncidentEventKind = g.restored ? "restored" : (g.to as IncidentEventKind);
    const one = g.zoneIds.length === 1 ? zoneById.get(g.zoneIds[0]) : undefined;
    const label = one?.label ?? g.zoneIds[0];
    const n = g.zoneIds.length;

    out.push({
      id: `zone-${kind}-${g.t}`,
      t: g.t,
      kind,
      tone: statusTone(kind),
      channel: statusChannel(kind),
      headline: one
        ? `${label} ${statusVerbOne(kind)}`
        : `${formatCount(n)} zones ${statusVerbMany(kind)}`,
      detail: statusDetail(kind, g, one, zoneById),
      count: n,
      subject: one ? { kind: "zone", id: one.id } : undefined,
      focus: one?.centroid,
    });
  }
}

function statusTone(kind: IncidentEventKind): IncidentTone {
  switch (kind) {
    case "cutoff":
      return "critical";
    case "ordered":
      return "warning";
    case "cleared":
    case "restored":
      return "ok";
    default:
      return "plan";
  }
}

function statusChannel(kind: IncidentEventKind): string {
  switch (kind) {
    case "cutoff":
      return "Cut off";
    case "restored":
      return "Egress restored";
    case "ordered":
      return "Order";
    case "cleared":
      return "Clear";
    default:
      return "Moving";
  }
}

function statusVerbOne(kind: IncidentEventKind): string {
  switch (kind) {
    case "cutoff":
      return "loses its primary route";
    case "restored":
      return "regains a way out";
    case "ordered":
      return "goes under evacuation order";
    case "cleared":
      return "is clear";
    default:
      return "starts moving";
  }
}

function statusVerbMany(kind: IncidentEventKind): string {
  switch (kind) {
    case "cutoff":
      return "lose their primary routes";
    case "restored":
      return "regain a way out";
    case "ordered":
      return "go under evacuation order";
    case "cleared":
      return "are clear";
    default:
      return "start moving at once";
  }
}

function statusDetail(
  kind: IncidentEventKind,
  g: StatusGroup,
  one: EvacZone | undefined,
  zoneById: Map<string, EvacZone>,
): string | undefined {
  const inside =
    g.remaining > 0 ? `${formatCount(g.remaining)} households still inside` : undefined;
  if (kind === "cutoff" || kind === "restored") {
    const route = one ? one.primaryRouteLabel : joinLabels(g.zoneIds, zoneById);
    return inside ? `${inside} · ${route}` : route;
  }
  if (one) return `via ${one.primaryRouteLabel}`;
  return joinLabels(g.zoneIds, zoneById);
}

function joinLabels(zoneIds: string[], zoneById: Map<string, EvacZone>): string {
  const labels = zoneIds.map((id) => zoneById.get(id)?.label ?? id);
  return listOf(labels);
}

// ── hazard closing egress ───────────────────────────────────────────────────

interface ClosureGroup {
  t: Tick;
  names: string[];
  edgeId: string;
  modelled: boolean;
  zoneIds: Set<string>;
}

function pushCorridorClosures(
  out: IncidentEvent[],
  src: ResolvedSources,
  run: SimulationRun,
  zones: EvacZone[],
) {
  const hazard: HazardTrack | null = src.hazard;
  if (!hazard || hazard.frames.length === 0 || zones.length === 0) return;

  const primary = new Set<string>();
  for (const z of zones) for (const id of z.primaryRouteEdgeIds) primary.add(id);
  if (primary.size === 0) return;

  // closedEdgeIds is cumulative, so `seen` is what turns 250k restatements into
  // one event per road the first time the fire takes it.
  const seenEdges = new Set<string>();
  const seenNames = new Set<string>();
  const groups = new Map<Tick, ClosureGroup>();

  for (const frame of hazard.frames) {
    for (const edgeId of frame.closedEdgeIds) {
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      if (!primary.has(edgeId)) continue;
      const name = edgeById(src.network, edgeId)?.name;
      // An unnamed service spur is not a road an operator can be told about.
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);

      let g = groups.get(frame.t);
      if (!g) {
        g = {
          t: frame.t,
          names: [],
          edgeId,
          modelled: frame.provenance === "interpolated",
          zoneIds: new Set<string>(),
        };
        groups.set(frame.t, g);
      }
      g.names.push(name);
      for (const z of zonesUsingEdge(zones, edgeId)) g.zoneIds.add(z.id);
    }
  }

  for (const g of groups.values()) {
    const runFrame = frameAt(run, g.t);
    let inside = 0;
    for (const zoneId of g.zoneIds) inside += runFrame.zoneRemaining[zoneId] ?? 0;
    const n = g.names.length;
    out.push({
      id: `closure-${g.t}`,
      t: g.t,
      kind: "corridor-closed",
      tone: inside > 0 ? "critical" : "warning",
      channel: "Fire on the road",
      headline:
        n === 1 ? `${g.names[0]} closed by fire` : `${formatCount(n)} egress roads closed by fire`,
      detail:
        inside > 0
          ? `${listOf(g.names)} · ${formatCount(inside)} households still inside the ${formatCount(g.zoneIds.size)} zones that route over ${n === 1 ? "it" : "them"}`
          : listOf(g.names),
      count: n,
      subject: { kind: "edge", id: g.edgeId },
      focus: midpoint(src.network, g.edgeId),
      modelled: g.modelled,
    });
  }
}

function midpoint(network: RoadNetwork | null, edgeId: string): LngLat | undefined {
  const geom = edgeById(network, edgeId)?.geometry;
  if (!geom || geom.length === 0) return undefined;
  return geom[Math.floor(geom.length / 2)];
}

// ── contraflow (planned runs only — baseline plans carry none) ──────────────

function pushContraflow(out: IncidentEvent[], run: SimulationRun, network: RoadNetwork | null) {
  const orders = run.plan.contraflow;
  if (orders.length === 0) return;

  const on = new Map<Tick, typeof orders>();
  const off = new Map<Tick, typeof orders>();
  for (const o of orders) {
    bucketPush(on, o.activateAt, o);
    bucketPush(off, o.releaseAt, o);
  }

  for (const [t, group] of on) {
    const gained = group.reduce((n, o) => n + (o.capacityAfter - o.capacityBefore), 0);
    const segments = group.reduce((n, o) => n + o.edgeIds.length, 0);
    out.push({
      id: `contraflow-on-${t}`,
      t,
      kind: "contraflow-on",
      tone: "plan",
      channel: "Contraflow",
      headline:
        group.length === 1
          ? group[0].label
          : `${formatCount(group.length)} corridors reversed inbound`,
      detail: `${formatCount(segments)} segments · +${formatCount(gained)} veh/h outbound${group.length === 1 ? "" : ` · ${listOf(group.map((o) => roadOf(o.label)))}`}`,
      count: group.length,
      subject: { kind: "edge", id: group[0].edgeIds[0] },
      focus: midpoint(network, group[0].edgeIds[0]),
    });
  }

  for (const [t, group] of off) {
    out.push({
      id: `contraflow-off-${t}`,
      t,
      kind: "contraflow-off",
      tone: "neutral",
      channel: "Contraflow released",
      headline:
        group.length === 1
          ? `${roadOf(group[0].label)} returns to normal flow`
          : `${formatCount(group.length)} corridors return to normal flow`,
      detail: group.length === 1 ? undefined : listOf(group.map((o) => roadOf(o.label))),
      count: group.length,
      subject: { kind: "edge", id: group[0].edgeIds[0] },
      focus: midpoint(network, group[0].edgeIds[0]),
    });
  }
}

/** "Skyway — reverse the inbound lanes" -> "Skyway". */
function roadOf(label: string): string {
  const cut = label.indexOf("—");
  return cut > 0 ? label.slice(0, cut).trim() : label;
}

// ── dispatched pickup (planned runs only — baseline plans carry none) ───────

function pushDispatch(out: IncidentEvent[], run: SimulationRun, meta: ScenarioMeta) {
  const manifests = run.plan.manifests;
  if (manifests.length === 0) return;
  const step = meta.frameStep > 0 ? meta.frameStep : 300;
  const bucket = (t: Tick) => Math.floor(t / step) * step;

  interface Pickup {
    passengers: number;
    wheelchair: number;
    stops: number;
    medical: Set<string>;
    vehicleId: string;
    label: string;
    position: LngLat;
  }
  const pickups = new Map<Tick, Pickup>();
  interface Drop {
    vehicles: string[];
    passengers: number;
    late: number;
    facilities: Set<string>;
  }
  const drops = new Map<Tick, Drop>();

  for (const m of manifests) {
    for (const s of m.stops) {
      const t = bucket(s.arriveAt);
      let p = pickups.get(t);
      if (!p) {
        p = {
          passengers: 0,
          wheelchair: 0,
          stops: 0,
          medical: new Set<string>(),
          vehicleId: m.id,
          label: s.label,
          position: s.position,
        };
        pickups.set(t, p);
      }
      p.passengers += s.passengers;
      p.wheelchair += s.wheelchair;
      p.stops += 1;
      for (const note of s.medicalNotes) p.medical.add(note);
    }

    const dt = bucket(m.dropAt);
    let d = drops.get(dt);
    if (!d) {
      d = { vehicles: [], passengers: 0, late: 0, facilities: new Set<string>() };
      drops.set(dt, d);
    }
    d.vehicles.push(m.id);
    d.passengers += m.stops.reduce((n, s) => n + s.passengers, 0);
    // Negative slack is the solver saying this vehicle reaches its drop after
    // the hazard reaches its last stop. It is in the payload; say it.
    if (m.slack < 0) d.late += 1;
    d.facilities.add(m.dropLabel);
  }

  for (const [t, p] of pickups) {
    const medical = p.medical.size > 0 ? listOf([...p.medical]) : null;
    out.push({
      id: `pickup-${t}`,
      t,
      kind: "pickup",
      tone: "plan",
      channel: "Pickup",
      headline:
        p.stops === 1
          ? `${formatCount(p.passengers)} boarding at ${p.label}`
          : `${formatCount(p.stops)} muster points, ${formatCount(p.passengers)} boarding`,
      detail: [
        p.wheelchair > 0 ? `${formatCount(p.wheelchair)} wheelchair` : null,
        medical,
        p.stops === 1 ? p.vehicleId : null,
      ]
        .filter(Boolean)
        .join(" · "),
      count: p.stops,
      subject: p.stops === 1 ? { kind: "vehicle", id: p.vehicleId } : undefined,
      focus: p.position,
    });
  }

  for (const [t, d] of drops) {
    out.push({
      id: `drop-${t}`,
      t,
      kind: "drop",
      tone: d.late > 0 ? "warning" : "plan",
      channel: "Drop",
      headline:
        d.vehicles.length === 1
          ? `${d.vehicles[0]} unloads ${formatCount(d.passengers)} at ${listOf([...d.facilities])}`
          : `${formatCount(d.vehicles.length)} vehicles unload ${formatCount(d.passengers)}`,
      detail:
        d.late > 0
          ? `${formatCount(d.late)} of these reach the drop AFTER the hazard reaches their last stop`
          : d.vehicles.length === 1
            ? undefined
            : listOf([...d.facilities]),
      count: d.vehicles.length,
      subject: d.vehicles.length === 1 ? { kind: "vehicle", id: d.vehicles[0] } : undefined,
    });
  }
}

// ── exposure, burnover, clearance ───────────────────────────────────────────

function pushExposure(out: IncidentEvent[], run: SimulationRun) {
  let firstFrame: (typeof run.frames)[number] | null = null;
  let peakFrame: (typeof run.frames)[number] | null = null;
  for (const f of run.frames) {
    if (f.vehiclesInHazard <= 0) continue;
    if (!firstFrame) firstFrame = f;
    if (!peakFrame || f.vehiclesInHazard > peakFrame.vehiclesInHazard) peakFrame = f;
  }
  if (!firstFrame) return;

  out.push({
    id: `exposure-first-${firstFrame.t}`,
    t: firstFrame.t,
    kind: "exposure",
    tone: "critical",
    channel: "Exposure",
    headline: `${formatCount(firstFrame.vehiclesInHazard)} vehicles inside the hazard footprint`,
    detail: "First frame of the run in which any vehicle is still moving inside the perimeter.",
    count: firstFrame.vehiclesInHazard,
  });

  if (peakFrame && peakFrame.t !== firstFrame.t) {
    out.push({
      id: `exposure-peak-${peakFrame.t}`,
      t: peakFrame.t,
      kind: "exposure",
      tone: "critical",
      channel: "Exposure peak",
      headline: `${formatCount(peakFrame.vehiclesInHazard)} vehicles inside the footprint`,
      detail: `Worst frame of this run. Longest standing queue ${formatCount(Math.round(peakFrame.peakQueueLength))} m.`,
      count: peakFrame.vehiclesInHazard,
    });
  }
}

function pushBurnover(out: IncidentEvent[], run: SimulationRun, meta: ScenarioMeta) {
  const t = meta.burnoverAt;
  if (!Number.isFinite(t) || t < 0) return;
  const s = run.summary;
  out.push({
    id: "burnover",
    t,
    kind: "burnover",
    tone: "critical",
    channel: "Burnover",
    headline: "Hazard overruns the last occupied egress route",
    detail: `${formatCount(s.vehiclesInHazardAtBurnover)} vehicles and ${formatCount(s.peopleInHazardAtBurnover)} people still inside the footprint at this instant.`,
    count: 1,
  });
}

function pushClearance(out: IncidentEvent[], run: SimulationRun) {
  const s = run.summary;
  if (!Number.isFinite(s.clearanceTime) || s.clearanceTime <= 0) return;
  out.push({
    id: "clearance",
    t: s.clearanceTime,
    kind: "clearance",
    tone: "ok",
    channel: "Clearance",
    headline: `Last vehicle out — ${formatDuration(s.clearanceTime)} total`,
    detail: `${formatCount(s.totalEvacuated)} evacuated${s.unassigned > 0 ? ` · ${formatCount(s.unassigned)} unassigned` : ""} · peak queue ${formatCount(Math.round(s.peakQueueLength))} m`,
    count: 1,
  });
}

function pushValidation(out: IncidentEvent[], run: SimulationRun) {
  const v = run.validation;
  if (!v) return;
  const delta = v.observedClearanceApprox - v.modeledClearance;
  out.push({
    id: "validation",
    t: v.modeledClearance,
    kind: "validation",
    tone: "neutral",
    channel: "Validation",
    headline: `Modelled ${formatDuration(v.modeledClearance)} against an observed figure of roughly ${formatDuration(v.observedClearanceApprox)}`,
    // The payload's own hedge, verbatim. No finer figure is claimed anywhere.
    detail: `${delta >= 0 ? "Model runs" : "Model overruns"} ${formatShort(Math.abs(delta))} ${delta >= 0 ? "short of" : "past"} the approximate observed span. ${v.note}`,
    count: 1,
  });
}

// ── shared ──────────────────────────────────────────────────────────────────

function bucketPush<T>(map: Map<Tick, T[]>, t: Tick, value: T) {
  const bucket = map.get(t);
  if (bucket) bucket.push(value);
  else map.set(t, [value]);
}

/** Up to three names, then a count. A row that wraps four times is not a row. */
function listOf(names: string[]): string {
  if (names.length <= 3) return names.join(" · ");
  return `${names.slice(0, 3).join(" · ")} +${names.length - 3} more`;
}

/** T+HH:MM for a feed row. Seconds are noise at a 5-minute frame grid. */
export function incidentTime(t: Tick): string {
  return formatTick(t, false);
}

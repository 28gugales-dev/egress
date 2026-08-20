/**
 * Standalone check for src/components/map/vehicle-layers.tsx.
 *
 *     npx tsx scripts/vehicle-check.ts [scenarioId]
 *
 * The vehicle stack is not wired into deck-layers.tsx yet, so nothing in the
 * running console exercises it. This drives the real module against the real
 * payloads on disk and asserts the things a screenshot cannot: that the layers
 * come back with data, that a puck actually MOVES, that it moves forward, and
 * that it does not fall off the end of a horizon that grew from 8h to 12h.
 *
 * Nothing here is a substitute for looking at the map. It is a substitute for
 * claiming the map works without having run anything.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PickingInfo } from "@deck.gl/core";

import {
  buildVehicleLayers,
  vehicleClick,
  fleetFor,
  vehicleIsLive,
  vehiclePhaseAt,
  vehiclePositionAt,
  vehicleTooltip,
} from "../src/components/map/vehicle-layers";
import { getScenario } from "../src/lib/constants";
import type {
  FacilityLayer,
  LayerVisibility,
  RoadNetwork,
  Selection,
  SimulationRun,
  Tick,
  ZoneLayer,
} from "../src/types/egress";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioId = process.argv[2] ?? "camp-fire-2018";
const dataDir = join(ROOT, "public", "data", scenarioId);

function read<T>(file: string): T {
  return JSON.parse(readFileSync(join(dataDir, file), "utf8")) as T;
}

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

function fmt(p: readonly [number, number]): string {
  return `[${p[0].toFixed(6)}, ${p[1].toFixed(6)}]`;
}

// ── payloads ────────────────────────────────────────────────────────────────

const meta = getScenario(scenarioId);
const network = read<RoadNetwork>("network.json");
const zones = read<ZoneLayer>("zones.json");
const facilities = read<FacilityLayer>("facilities.json");
const planned = read<SimulationRun>("run_planned.json");
const baseline = read<SimulationRun>("run_baseline.json");

// Horizon and frame count are DERIVED, never assumed: camp-fire-2018 went from
// 8h/97 frames to 12h/145 mid-flight and a hardcoded either would pass here
// while freezing every bus on the map.
const horizon: Tick = meta.duration;
const frameCount = planned.frames.length;

console.log(`\nvehicle-check · ${scenarioId}`);
console.log(
  `  horizon ${horizon}s · ${frameCount} frames @ ${meta.frameStep}s · ` +
    `${planned.plan.manifests.length} planned manifests · ` +
    `${baseline.plan.manifests.length} baseline manifests · ` +
    `${network.edges.length} edges\n`,
);

// ── fleet precompute ────────────────────────────────────────────────────────

const fleet = fleetFor(planned.plan, zones, network);
check(
  fleet.routes.length === planned.plan.manifests.length,
  "every manifest produced a route",
  `${fleet.routes.length}/${planned.plan.manifests.length}, dropped: ${
    fleet.dropped.join(",") || "none"
  }`,
);
check(fleet.dropped.length === 0, "no manifest dropped for bad geometry");
check(
  fleetFor(planned.plan, zones, network) === fleet,
  "second fleetFor call is served from cache (same object identity)",
);
check(
  fleetFor(baseline.plan, zones, network).routes.length === 0,
  "baseline run carries no vehicles (busDispatch is off in BASELINE_PARAMS)",
);

const coverage = fleet.routes.reduce((s, r) => s + r.roadCoverage, 0) / fleet.routes.length;
const unnamed = fleet.routes.filter((r) => r.roads.length === 0);
// How MANY roads resolve is a property of the OSM extract, not of this module,
// so the invariant is the implication: coverage above zero must yield names.
check(
  fleet.routes.every((r) => r.roadCoverage === 0 || r.roads.length > 0),
  "any route with named metres resolves at least one road",
  `mean ${(coverage * 100).toFixed(1)}% of route metres carry a name; ` +
    `${unnamed.length} route(s) resolve none${
      unnamed.length > 0 ? ` (${unnamed.map((r) => r.manifest.id).join(", ")})` : ""
    }`,
);
// Not an assertion about quality — an assertion that the defect is MEASURED
// and surfaced rather than smoothed away. See warnAboutGeometry.
check(
  fleet.offNetworkShare === 0 || fleet.routes.some((r) => r.offNetworkM > 0),
  "off-network route metres are measured, not hidden",
  `${(fleet.offNetworkShare * 100).toFixed(1)}% of fleet route metres lie on no network edge` +
    ` (${(fleet.routes.reduce((s, r) => s + r.offNetworkM, 0) / 1000).toFixed(0)} km)`,
);
// Whether a scenario HAS at-risk runs is a fact about the scenario — camp-fire
// has two, palisades has none. What must hold everywhere is that the flag says
// exactly what the slack numbers say, in both directions.
check(
  fleet.routes.every(
    (r) =>
      r.atRisk ===
      (r.manifest.slack < 0 || (Number.isFinite(r.pickupSlack) && r.pickupSlack < 0)),
  ),
  "the at-risk flag agrees with drop slack and pickup slack, both ways",
  `${fleet.atRisk.length} of ${fleet.routes.length} flagged: ${
    fleet.atRisk
      .map((r) => `${r.manifest.id} (drop ${r.manifest.slack}s, pickup ${r.pickupSlack}s)`)
      .join(", ") || "none in this scenario"
  }`,
);

// Sanity on the arrays themselves.
let monotoneTimes = true;
let finitePoints = true;
for (const r of fleet.routes) {
  for (let i = 1; i < r.times.length; i++) {
    if (r.times[i] < r.times[i - 1]) monotoneTimes = false;
    if (r.cum[i] < r.cum[i - 1]) monotoneTimes = false;
  }
  for (const p of r.points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) finitePoints = false;
  }
}
check(monotoneTimes, "every route's timestamps and cumulative distances are non-decreasing");
check(finitePoints, "no NaN in any route vertex");

// ── motion: three ticks on the longest-running vehicle ──────────────────────

const longest = [...fleet.routes].sort((a, b) => b.endAt - a.endAt)[0];
const probes: Tick[] = [
  Math.round(longest.departAt + (longest.endAt - longest.departAt) * 0.2),
  Math.round(longest.departAt + (longest.endAt - longest.departAt) * 0.5),
  Math.round(longest.departAt + (longest.endAt - longest.departAt) * 0.8),
];

console.log(
  `\n  ${longest.manifest.id} · ${longest.manifest.originLabel} → ${longest.manifest.dropLabel}`,
);
console.log(
  `  departs T+${longest.departAt}s, drops T+${longest.endAt}s, ` +
    `${(longest.totalM / 1000).toFixed(2)} km over ${longest.points.length} vertices`,
);

const fixes = probes.map((t) => ({ t, ...vehiclePositionAt(longest, t) }));
for (const f of fixes) {
  console.log(
    `    T+${String(f.t).padStart(5)}  ${fmt(f.position)}  ` +
      `${(f.distance / 1000).toFixed(3)} km  ${vehiclePhaseAt(longest, f.t)}`,
  );
}
check(
  fixes[0].position[0] !== fixes[1].position[0] || fixes[0].position[1] !== fixes[1].position[1],
  "position at probe 1 differs from probe 2",
);
check(
  fixes[1].position[0] !== fixes[2].position[0] || fixes[1].position[1] !== fixes[2].position[1],
  "position at probe 2 differs from probe 3",
);
check(
  fixes[0].distance < fixes[1].distance && fixes[1].distance < fixes[2].distance,
  "distance along route advances monotonically",
  `${fixes.map((f) => f.distance.toFixed(1)).join(" < ")} m`,
);

// A vehicle that also loads somewhere: prove the dwell keyframe holds it still.
const dweller = fleet.routes.find((r) => r.stops.some((w) => w.departAt > w.arriveAt));
if (dweller) {
  const w = dweller.stops.find((s) => s.departAt > s.arriveAt);
  if (w) {
    const a = vehiclePositionAt(dweller, w.arriveAt + 1);
    const b = vehiclePositionAt(dweller, w.departAt - 1);
    check(
      a.distance === b.distance,
      "a loading vehicle holds position through its dwell window",
      `${dweller.manifest.id} T+${w.arriveAt}→T+${w.departAt}, both at ${a.distance.toFixed(1)} m`,
    );
    check(
      vehiclePhaseAt(dweller, Math.round((w.arriveAt + w.departAt) / 2)) === "loading",
      "the dwell window reports phase 'loading'",
    );
  }
}

// ── the far end of the horizon ──────────────────────────────────────────────
// The window grew to 12h after this module was specced. Nothing may freeze
// mid-route, and nothing may read as still driving four hours after it parked.

const late: Tick = Math.round(horizon * 0.75);
const lastDrop = Math.max(...fleet.routes.map((r) => r.endAt));
// The coordinator's ask was specifically a probe past T+28800, which only
// exists on a 12h scenario. Derive the probe from this scenario's own horizon
// and state whether it clears that mark rather than hardcoding either number.
check(
  late > lastDrop + 3600,
  "late probe is hours past the last drop",
  `T+${late} vs last drop T+${lastDrop}${
    late > 28800 ? " — clears T+28800" : ` — horizon is only T+${horizon}, so it cannot`
  }`,
);
const lateStates = fleet.routes.map((r) => ({
  id: r.manifest.id,
  phase: vehiclePhaseAt(r, late),
  live: vehicleIsLive(r, late),
  at: vehiclePositionAt(r, late),
  end: r.points[r.points.length - 1],
}));
check(
  lateStates.every((s) => s.phase === "arrived"),
  `every vehicle reads 'arrived' at T+${late}`,
  `latest drop is T+${Math.max(...fleet.routes.map((r) => r.endAt))}s`,
);
check(
  lateStates.every(
    (s) => s.at.position[0] === s.end[0] && s.at.position[1] === s.end[1],
  ),
  "every vehicle is clamped to its final vertex, not frozen mid-route",
  `e.g. ${lateStates[0].id} at ${fmt(lateStates[0].at.position)}`,
);
check(
  lateStates.every((s) => !s.live),
  `no vehicle is still drawn at T+${late} (dispatch completed hours earlier)`,
);
check(
  !Number.isNaN(vehiclePositionAt(longest, horizon).distance),
  `position at the horizon T+${horizon} is finite`,
);

// ── buildVehicleLayers against the real payloads ────────────────────────────

const LAYERS_ON = { busArcs: true } as unknown as LayerVisibility;
const LAYERS_OFF = { busArcs: false } as unknown as LayerVisibility;
const NO_SELECTION: Selection = { kind: null, id: null };

function layerAt(t: Tick, selection: Selection = NO_SELECTION, layers = LAYERS_ON) {
  return buildVehicleLayers({
    plan: planned.plan,
    zones,
    network,
    t,
    layers,
    selection,
    idPrefix: "check",
    interactive: true,
  });
}

/** Peak dispatch: the tick with the most vehicles live. */
let peakT = 0;
let peakN = 0;
for (let t = 0; t <= horizon; t += meta.frameStep) {
  const n = fleet.routes.reduce((s, r) => s + (vehicleIsLive(r, t) ? 1 : 0), 0);
  if (n > peakN) {
    peakN = n;
    peakT = t;
  }
}

const built = layerAt(peakT);
const ids = built.map((l) => l.id);
console.log(`\n  peak dispatch T+${peakT} · ${peakN} vehicles live`);
console.log(`  layers: ${ids.join(", ")}`);

const pucks = built.find((l) => l.id === "check-vehicle-pucks");
const routes = built.find((l) => l.id === "check-vehicle-routes");
const puckData = (pucks?.props as { data?: unknown[] } | undefined)?.data ?? [];
const routeData = (routes?.props as { data?: unknown[] } | undefined)?.data ?? [];

check(built.length >= 2, "buildVehicleLayers returns a stack", `${built.length} layers`);
check(puckData.length === peakN, "the puck layer carries one datum per live vehicle", `${puckData.length}`);
check(routeData.length === peakN, "the route web carries one path per live vehicle", `${routeData.length}`);
check(
  ids.every((id) => id.startsWith("check-")),
  "every layer id honours idPrefix so the split view cannot collide",
);
check(layerAt(peakT, NO_SELECTION, LAYERS_OFF).length === 0, "layers.busArcs = false draws nothing");

// Selection adds the split route and the stop rings, and marks the puck.
const chosen = fleet.atRisk[0] ?? fleet.routes[0];
const selT = Math.round((chosen.departAt + chosen.endAt) / 2);
const selBuilt = layerAt(selT, { kind: "vehicle", id: chosen.manifest.id });
const selIds = selBuilt.map((l) => l.id);
check(
  selIds.includes("check-vehicle-route-remaining") && selIds.includes("check-vehicle-route-done"),
  "selecting a vehicle splits its route at the playhead",
  selIds.join(", "),
);
check(
  selIds.includes("check-vehicle-stops"),
  "selecting a vehicle draws its pickup stops",
);
check(
  fleet.atRisk.length === 0 || selIds.includes("check-vehicle-risk"),
  "an at-risk vehicle gets its own ring layer",
);

// The datum array must be a fresh array each tick — that IS the motion.
const a = layerAt(peakT);
const b = layerAt(peakT + 30);
const pa = ((a.find((l) => l.id === "check-vehicle-pucks")?.props as { data: { position: [number, number] }[] }).data)[0];
const pb = ((b.find((l) => l.id === "check-vehicle-pucks")?.props as { data: { position: [number, number] }[] }).data)[0];
check(
  pa.position[0] !== pb.position[0] || pa.position[1] !== pb.position[1],
  "the first puck moves between two ticks 30s apart",
  `${fmt(pa.position)} → ${fmt(pb.position)}`,
);

// ── tooltip / click cannot cross-claim another stack's pick ─────────────────
// deck-layers tags its datums `_k` and context-layers tags its own `_ck`. All
// three tooltips are chained into one getTooltip, so a stack that claims a
// datum it does not own silently shows the wrong card.

const foreign = [
  { _k: "zone", zone: { id: "BUT-X", label: "Foreign" } },
  { _k: "bus", manifest: { id: "bus-001" } },
  { _ck: "smoke", plume: {} },
  {},
];
check(
  foreign.every((o) => vehicleTooltip({ object: o } as unknown as PickingInfo) === null),
  "vehicleTooltip returns null for _k and _ck datums it does not own",
);
check(
  foreign.every((o) => vehicleClick({ object: o } as unknown as PickingInfo) === false),
  "vehicleClick refuses _k and _ck datums it does not own",
);
check(
  vehicleTooltip({ object: undefined } as unknown as PickingInfo) === null &&
    vehicleClick({ object: undefined } as unknown as PickingInfo) === false,
  "an empty pick is not claimed",
);
const ownPick = (built.find((l) => l.id === "check-vehicle-pucks")?.props as { data: unknown[] })
  .data[0];
check(
  vehicleTooltip({ object: ownPick } as unknown as PickingInfo) !== null,
  "vehicleTooltip DOES claim its own _vk datum",
);

// ── the argument ────────────────────────────────────────────────────────────

console.log("\n  at-risk manifests — the ones the plan cannot reach in time:");
for (const r of fleet.atRisk) {
  const last = r.stops[r.stops.length - 1];
  console.log(
    `    ${r.manifest.id}  ${r.manifest.assignedZoneIds.join(",")}  ` +
      `hazard T+${r.hazardEta}  last pickup T+${last?.arriveAt ?? "?"}  ` +
      `drop T+${r.endAt}  pickup slack ${r.pickupSlack}s  drop slack ${r.manifest.slack}s  ` +
      `${r.manifest.seats} seats`,
  );
}

void facilities;

console.log(failures === 0 ? "\nvehicle-check: OK\n" : `\nvehicle-check: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

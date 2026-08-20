/**
 * dispatch-response-assets.ts — PROPOSAL. Not wired into the pipeline.
 *
 *     npx tsx scripts/dispatch-response-assets.ts [scenarioId] [--write]
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE READING THE CODE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Egress today dispatches exactly one thing: evacuation transport. 76 buses and
 * 3 ambulances on camp-fire-2018, and `VehicleManifest.kind` has no other
 * member. Fire engines appear on the map as PARKED station inventory — 64 of
 * them across 32 stations — because that is what the data supports. Police and
 * aviation do not appear at all, because no payload in this project has ever
 * carried them.
 *
 * That gap is deliberate, and it is the honest position: a fire engine driving
 * across the map would be a number nobody could trace back to a source, which
 * is the one thing CLAUDE.md forbids outright.
 *
 * This file is the answer to "so how WOULD you do it". It is a specification
 * with a runnable shape — the fleet table, the mission model, the routing mode
 * per asset class, and the provenance rules that would have to hold before any
 * of it were allowed on the map. It writes nothing the app loads. Running it
 * with --write produces `<scenario>/response-assets.proposal.json`, which no
 * loader in src/lib/data.ts references and which exists to be read by a human.
 *
 * Everything in RESPONSE_FLEET is a stated assumption. Nothing is observed.
 * The one exception is the engine count, which is read live from facilities.json
 * and printed with its real provenance — see `engineInventory()`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ASSUMPTION TABLE — every number below is a modelling assumption
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ENGINE (structure defence)
 *   count            READ FROM facilities.json — 64 across 32 stations on
 *                    camp-fire-2018. Not assumed. The only real number here.
 *   capacity         4 firefighters, 1 structure at a time. An engine's
 *                    "capacity" is not passengers; it is how many structures a
 *                    crew can hold per operational period.
 *   speedKmh         55 free-flow, 35 inside the perimeter. Apparatus is heavy
 *                    and it drives INTO the closure, against evacuation flow.
 *   routing          Dijkstra on the same RoadNetwork, with the contraflow
 *                    orders applied in REVERSE: an engine inbound on a reversed
 *                    corridor is the reason contraflow needs a shoulder lane.
 *                    This is the interesting coupling and the reason engine
 *                    dispatch is not just "buses with a different icon".
 *   mission          Hold a defensible structure cluster until the front
 *                    passes. Assignment is by threatened-structure density, not
 *                    by proximity.
 *
 * POLICE (traffic control)
 *   count            ASSUMED. No police stations are fetched today — see the
 *                    Overpass sketch in `sourcesToAdd()`. Butte County + CHP
 *                    Chico would be the real roster.
 *   capacity         2 officers, 1 control point.
 *   speedKmh         70 free-flow.
 *   routing          Dijkstra to a CLOSURE POINT, not to a facility. This is
 *                    the tie-in that makes police worth modelling at all: the
 *                    roadblock layer already renders closure points from
 *                    `HazardFrame.closedEdgeIds`, and every one of those
 *                    closures is a fiction until somebody is standing there.
 *                    Staffed vs unstaffed closures is a real operational
 *                    distinction and the plan currently cannot express it.
 *   mission          Staff a closure. Unstaffed closures should render
 *                    differently from staffed ones, because drivers route
 *                    around a cone and do not route around an officer.
 *
 * HELICOPTER (medevac and recon)
 *   count            ASSUMED. CAL FIRE Copter 106 (Vina) and a county air
 *                    ambulance are the plausible roster for this bbox.
 *   capacity         2 litter patients, or 1 recon orbit.
 *   speedKmh         220 cruise.
 *   routing          NOT Dijkstra. Aviation is off-network: straight legs
 *                    between helipad, incident and receiving hospital, with a
 *                    wind penalty from the WindSample track that already exists
 *                    in hazard.json. Modelling a helicopter on the road graph
 *                    would be worse than not modelling it.
 *   mission          Move a non-ambulatory patient the road plan cannot reach
 *                    in time — precisely the households the dispatch solver
 *                    currently marks as unreachable.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WOULD HAVE TO BE TRUE BEFORE ANY OF THIS SHIPS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   1. Real staging positions. Police stations and helipads from Overpass, the
 *      same keyless path fetch-facilities.ts already uses.
 *   2. A provenance field on every generated mission naming this file, so a
 *      judge clicking an engine sees "proposed by dispatch-response-assets.ts"
 *      and not a source it never came from.
 *   3. A separate visual register on the map. Response assets move INTO the
 *      hazard; evacuation transport moves OUT of it. Drawing them in the same
 *      idiom would misread at a glance.
 *   4. The baseline-before-counterfactual rule still applies. A response plan
 *      that cannot reproduce the observed deployment is not a plan.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Facility, FacilityLayer, LngLat, Tick } from "../src/types/egress";

const scenarioId = process.argv[2] ?? "camp-fire-2018";
const shouldWrite = process.argv.includes("--write");

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "public", "data", scenarioId);

// ─────────────────────────────────────────────────────────────────────────────
// The plug-and-play part
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local types. Deliberately NOT an extension of `VehicleManifest` — widening
 * that union would ripple into every exhaustive switch in the vehicle layer and
 * make a proposal look like a shipped feature. A response asset is a different
 * animal anyway: it has no seats, no drop shelter, and it drives toward the
 * fire rather than away from it.
 */
type ResponseClass = "engine" | "police" | "helicopter";

/** How an asset finds its way. The whole reason these are not one code path. */
type RoutingMode =
  /** Shortest path on RoadNetwork, contraflow orders applied in reverse. */
  | "network_inbound"
  /** Shortest path on RoadNetwork to a closure point rather than a facility. */
  | "network_to_closure"
  /** Straight legs, wind-penalised. Aviation does not use the road graph. */
  | "direct_air";

interface ResponseClassSpec {
  label: string;
  /** Null means "not in any payload yet" — the count is the open question. */
  count: number | null;
  countSource: string;
  /** What one unit can hold. Units differ per class on purpose. */
  capacity: number;
  capacityUnit: string;
  crew: number;
  speedKmh: number;
  /** Speed once inside the modelled perimeter. */
  speedKmhInHazard: number;
  /** Facility kinds this class stages from. */
  stagingKinds: string[];
  routing: RoutingMode;
  mission: string;
  /** One line a judge can hold on to. */
  whyItMatters: string;
}

/**
 * THE CONFIG. Everything an operator would tune lives here and nowhere else.
 * Change a count, change a capacity, rerun — that is the whole interface.
 */
const RESPONSE_FLEET: Record<ResponseClass, ResponseClassSpec> = {
  engine: {
    label: "Fire engine",
    count: null, // filled from facilities.json at runtime — see engineInventory()
    countSource: "facilities.json Facility.assets.engine (HIFLD fire stations)",
    capacity: 1,
    capacityUnit: "structure held per operational period",
    crew: 4,
    speedKmh: 55,
    speedKmhInHazard: 35,
    stagingKinds: ["fire_station"],
    routing: "network_inbound",
    mission: "Hold a defensible structure cluster until the front passes",
    whyItMatters:
      "Engines drive INTO the closure while the public drives out. That head-on " +
      "conflict on a two-lane mountain road is a capacity cost the evacuation " +
      "model currently does not charge itself for.",
  },
  police: {
    label: "Patrol unit",
    count: null,
    countSource: "NOT FETCHED — no police_station facility kind exists yet",
    capacity: 1,
    capacityUnit: "closure point staffed",
    crew: 2,
    speedKmh: 70,
    speedKmhInHazard: 40,
    stagingKinds: ["police_station"],
    routing: "network_to_closure",
    mission: "Staff a closure point so the closure is real",
    whyItMatters:
      "Every closed edge in hazard.json is an assertion that nobody drives it. " +
      "Unstaffed, that assertion is a cone. Staffing is the difference between " +
      "a modelled closure and an enforced one, and the plan cannot say which " +
      "it means today.",
  },
  helicopter: {
    label: "Rotary-wing",
    count: null,
    countSource: "NOT FETCHED — no helipad/aeroway records exist yet",
    capacity: 2,
    capacityUnit: "litter patients per sortie",
    crew: 3,
    speedKmh: 220,
    speedKmhInHazard: 160, // smoke column, reduced visibility
    stagingKinds: ["helipad", "hospital"],
    routing: "direct_air",
    mission: "Lift a patient the road plan cannot reach in time",
    whyItMatters:
      "The dispatch solver already marks households it cannot reach before the " +
      "hazard. Those are the sorties. Aviation is the only asset class whose " +
      "reachability is not bounded by the road graph, which is exactly why it " +
      "belongs in a road-capacity model.",
  },
};

/** Operational period. Everything above is per-period, not per-incident. */
const OPERATIONAL_PERIOD: Tick = 12 * 3600;

// ─────────────────────────────────────────────────────────────────────────────
// The one real number
// ─────────────────────────────────────────────────────────────────────────────

interface EngineInventory {
  total: number;
  stations: number;
  positions: LngLat[];
}

/**
 * Engines are the only class with a real count, so it is read rather than
 * assumed. Everything else in RESPONSE_FLEET is a stated guess and says so.
 */
function engineInventory(facilities: FacilityLayer): EngineInventory {
  const stations = facilities.facilities.filter(
    (f: Facility) => (f.assets?.engine ?? 0) > 0,
  );
  return {
    total: stations.reduce((n, f) => n + (f.assets?.engine ?? 0), 0),
    stations: stations.length,
    positions: stations.map((f) => f.position),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a real implementation would fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The missing sources, as Overpass QL. Same keyless endpoint family
 * fetch-facilities.ts and fetch-network.ts already use, so this is a fetch call
 * and a mapper away — not a research problem.
 *
 * Not executed here. The point of this file is the shape, and the user asked
 * for something to show, not something to run.
 */
function sourcesToAdd(bbox: string): Record<string, string> {
  return {
    police_station: `[out:json][timeout:60];(node["amenity"="police"](${bbox});way["amenity"="police"](${bbox}););out center tags;`,
    helipad: `[out:json][timeout:60];(node["aeroway"="helipad"](${bbox});way["aeroway"="helipad"](${bbox});node["emergency"="landing_site"](${bbox}););out center tags;`,
    // HIFLD publishes a Local Law Enforcement Locations layer on the same
    // ArcGIS host facilities.json already reads for fire stations, and it is
    // the better source of the two. OSM is the fallback, matching the pattern
    // fetch-facilities.ts uses for every other kind.
    police_station_hifld:
      "services.arcgis.com/.../Local_Law_Enforcement_Locations/FeatureServer/0/query",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The mission model
// ─────────────────────────────────────────────────────────────────────────────

interface ProposedMission {
  assetClass: ResponseClass;
  /** Where it starts. Real for engines, unresolved for the other two. */
  originKind: string;
  /** What it is sent to. Deliberately a different noun per class. */
  targetKind: "structure_cluster" | "closure_point" | "patient_pickup";
  routing: RoutingMode;
  /** Which existing payload supplies the target list. Empty = does not exist. */
  targetSource: string;
  /** Present on every generated record so nothing can be mistaken for data. */
  provenance: string;
}

function proposedMissions(): ProposedMission[] {
  const provenance = "PROPOSED by scripts/dispatch-response-assets.ts — not observed, not solved";
  return [
    {
      assetClass: "engine",
      originKind: "fire_station",
      targetKind: "structure_cluster",
      routing: "network_inbound",
      targetSource: "detail/buildings.json, ranked by modelled severity",
      provenance,
    },
    {
      assetClass: "police",
      originKind: "police_station",
      targetKind: "closure_point",
      routing: "network_to_closure",
      targetSource: "hazard.json HazardFrame.closedEdgeIds — already rendered as roadblocks",
      provenance,
    },
    {
      assetClass: "helicopter",
      originKind: "helipad",
      targetKind: "patient_pickup",
      routing: "direct_air",
      targetSource: "run_planned.json unreachable households (dispatch shortfall)",
      provenance,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("\n" + "═".repeat(78));
  console.log("  RESPONSE-ASSET DISPATCH — PROPOSAL, NOT A PIPELINE STEP");
  console.log(`  scenario: ${scenarioId}`);
  console.log("═".repeat(78));
  console.log(
    "\n  Nothing this file prints is loaded by the running console. Egress\n" +
      "  dispatches evacuation transport only; response assets are drawn as\n" +
      "  parked inventory because that is what the payloads support. This is\n" +
      "  the shape the missing half would take.\n",
  );

  let facilities: FacilityLayer | null = null;
  try {
    facilities = JSON.parse(
      readFileSync(join(dataDir, "facilities.json"), "utf8"),
    ) as FacilityLayer;
  } catch {
    console.warn(
      "  !!! facilities.json not readable for this scenario. Engine counts fall\n" +
        "      back to the assumption table instead of the real inventory.\n",
    );
  }

  if (facilities) {
    const inv = engineInventory(facilities);
    RESPONSE_FLEET.engine.count = inv.total;
    console.log(
      `  REAL: ${inv.total} engines across ${inv.stations} stations, read from facilities.json.\n` +
        "  This is the only count below that is not an assumption.\n",
    );
  }

  console.log("  ── FLEET ".padEnd(78, "─"));
  for (const [id, spec] of Object.entries(RESPONSE_FLEET) as [
    ResponseClass,
    ResponseClassSpec,
  ][]) {
    const count = spec.count === null ? "— (no source yet)" : String(spec.count);
    console.log(`\n  ${spec.label}  [${id}]`);
    console.log(`    count       ${count}`);
    console.log(`    source      ${spec.countSource}`);
    console.log(`    capacity    ${spec.capacity} ${spec.capacityUnit}`);
    console.log(`    crew        ${spec.crew}`);
    console.log(`    speed       ${spec.speedKmh} km/h free-flow, ${spec.speedKmhInHazard} in hazard`);
    console.log(`    stages from ${spec.stagingKinds.join(", ")}`);
    console.log(`    routing     ${spec.routing}`);
    console.log(`    mission     ${spec.mission}`);
    console.log(`    why         ${wrap(spec.whyItMatters, 16)}`);
  }

  console.log("\n  ── MISSIONS ".padEnd(78, "─"));
  for (const m of proposedMissions()) {
    const exists = m.targetSource.includes("does not exist") ? "MISSING" : "available";
    console.log(
      `\n  ${m.assetClass.padEnd(11)} ${m.originKind} → ${m.targetKind}  (${m.routing})`,
    );
    console.log(`    targets from ${m.targetSource}  [${exists}]`);
  }

  console.log("\n  ── SOURCES THAT WOULD HAVE TO BE ADDED ".padEnd(78, "─"));
  for (const [kind, query] of Object.entries(sourcesToAdd("BBOX"))) {
    console.log(`\n  ${kind}`);
    console.log(`    ${query.slice(0, 110)}${query.length > 110 ? "…" : ""}`);
  }

  console.log(
    `\n  Operational period: ${OPERATIONAL_PERIOD / 3600} h. Every capacity above is\n` +
      "  per-period, not per-incident.\n",
  );

  if (!shouldWrite) {
    console.log("  (dry run — pass --write to emit response-assets.proposal.json)\n");
    return;
  }

  const out = {
    scenarioId,
    kind: "proposal",
    provenance:
      "GENERATED BY scripts/dispatch-response-assets.ts. Every field is a stated " +
      "modelling assumption except engine counts, which are read from facilities.json. " +
      "No loader in src/lib/data.ts reads this file, by design.",
    operationalPeriod: OPERATIONAL_PERIOD,
    fleet: RESPONSE_FLEET,
    missions: proposedMissions(),
    sourcesToAdd: sourcesToAdd("BBOX"),
  };
  const path = join(dataDir, "response-assets.proposal.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`  Wrote ${path}`);
  console.log(
    "  !!! LOUD: this file is a PROPOSAL. Nothing loads it. If a future change\n" +
      "      wires it into the map, every record must carry its provenance field\n" +
      "      through to the UI, or the map starts asserting things no source said.\n",
  );
}

/** Indented wrap, so the why-it-matters lines stay readable in a terminal. */
function wrap(text: string, indent: number): string {
  const width = 78 - indent;
  const pad = " ".repeat(indent);
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${pad}`);
}

main();

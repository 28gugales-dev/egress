import type { FacilityKind, RoadClass, RunParams, ScenarioMeta, ZoneStatus } from "@/types/egress";

/**
 * Directional capacity in vehicles per hour per lane, by OSM highway class.
 *
 * Freeway figure follows the Highway Capacity Manual's ~2,000-2,400 pc/h/ln
 * ideal, discounted for evacuation conditions: unfamiliar drivers, loaded
 * vehicles, smoke, and no ramp metering. Surface streets are signal-limited,
 * so the binding constraint is green time, not saturation flow — the numbers
 * below already fold in a typical g/C ratio.
 *
 * These are DEFENSIBLE, not precise. The demo states them out loud.
 */
export const LANE_CAPACITY: Record<RoadClass, number> = {
  motorway: 1900,
  trunk: 1700,
  primary: 1000,
  secondary: 900,
  tertiary: 800,
  residential: 600,
  unclassified: 600,
  service: 300,
};

/** Free-flow speed in km/h when OSM has no maxspeed tag. */
export const DEFAULT_SPEED: Record<RoadClass, number> = {
  motorway: 105,
  trunk: 90,
  primary: 65,
  secondary: 55,
  tertiary: 45,
  residential: 30,
  unclassified: 40,
  service: 20,
};

/** Only these classes can carry reversed lanes. Reversing a residential
 *  street gains nothing and strands driveways. */
export const CONTRAFLOW_CLASSES: RoadClass[] = ["motorway", "trunk", "primary", "secondary"];

export const DEFAULT_PARAMS: RunParams = {
  compliance: 0.72,
  shadowEvac: 0.18,
  noticeTime: 2400,
  vehiclesPerHousehold: 1.4,
  staged: true,
  contraflow: true,
  busDispatch: true,
  shelterInPlaceOption: false,
};

/** The naive run: everyone ordered at once, no contraflow, no dispatch.
 *  This is what Paradise actually got. */
export const BASELINE_PARAMS: RunParams = {
  compliance: 0.72,
  shadowEvac: 0.18,
  noticeTime: 2400,
  vehiclesPerHousehold: 1.4,
  staged: false,
  contraflow: false,
  busDispatch: false,
  shelterInPlaceOption: false,
};

/** Axis values the parameter sweep is precomputed on. Slider positions snap
 *  to the nearest node and the summary is interpolated between neighbours. */
export const PARAM_AXES = {
  compliance: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  shadowEvac: [0, 0.1, 0.2, 0.3, 0.4],
  noticeTime: [600, 1200, 2400, 3600, 5400],
  vehiclesPerHousehold: [1.0, 1.2, 1.4, 1.6, 1.8, 2.0],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: "camp-fire-2018",
    name: "Camp Fire",
    place: "Paradise, California",
    eventDate: "2018-11-08",
    hazardKind: "wildfire",
    blurb:
      "Wind-driven wildfire. Roughly 26,000 residents, about four viable egress routes. Recorded perimeter progression replayed hour by hour.",
    provingPoint: "Contraflow and staged release against a hard egress bottleneck.",
    center: [-121.6219, 39.7596],
    zoom: 12.2,
    bbox: [-121.72, 39.68, -121.51, 39.84],
    startHourLocal: 6,
    // 12h, not 8h. The baseline does not finish inside 8 hours, and a clearance
    // time reported at exactly the horizon is a censored measurement reading as
    // a real one. The window has to outlast the worst run it has to score.
    duration: 43200,
    frameStep: 300,
    burnoverAt: 21600,
    available: true,
    attribution: [
      "Fire perimeters: NIFC / WFIGS",
      "Hotspots: NASA FIRMS",
      "Roads: OpenStreetMap contributors",
      "Population: US Census ACS",
      "Facilities: HIFLD Open",
    ],
  },
  {
    id: "conyers-plume-2024",
    name: "BioLab plume",
    place: "Conyers, Georgia",
    eventDate: "2024-09-29",
    hazardKind: "plume",
    blurb:
      "Chemical release from an industrial fire. Wind-driven footprint, shelter-in-place versus evacuate as a live decision.",
    provingPoint: "Same engine, different hazard class, metro road network.",
    center: [-83.9907, 33.6676],
    zoom: 11.6,
    bbox: [-84.13, 33.58, -83.85, 33.76],
    startHourLocal: 5,
    // 10h, not 6h. Both runs previously reported clearance at exactly the
    // horizon, which is a censored measurement reading as a real one: neither
    // finished inside the window, so the plan showed no gain by construction.
    // Uncensored, the baseline clears at ~29,700s.
    duration: 36000,
    frameStep: 300,
    burnoverAt: 14400,
    available: false,
    attribution: [
      "Wind: Open-Meteo archive",
      "Roads: OpenStreetMap contributors",
      "Population: US Census ACS",
    ],
  },
  {
    id: "marshall-fire-2021",
    name: "Marshall Fire",
    place: "Boulder County, Colorado",
    eventDate: "2021-12-30",
    hazardKind: "wildfire",
    blurb:
      "Suburban wind-driven fire, gusts past 100 mph. Roughly 35,000 evacuated in hours across a dense street grid.",
    provingPoint: "Density edge case — not a forest town.",
    center: [-105.1319, 39.9542],
    zoom: 12,
    bbox: [-105.22, 39.9, -105.03, 40.02],
    startHourLocal: 10,
    // 10h, not 5h. Both runs previously reported clearance at exactly the
    // horizon, which is a censored measurement reading as a real one: neither
    // finished inside the window, so the plan showed no gain by construction.
    // Uncensored, the baseline clears at ~24,600s.
    duration: 36000,
    frameStep: 300,
    burnoverAt: 12600,
    available: false,
    attribution: ["Fire perimeters: NIFC / WFIGS", "Roads: OpenStreetMap contributors"],
  },
  {
    id: "palisades-fire-2025",
    name: "Palisades Fire",
    place: "Pacific Palisades, Los Angeles",
    eventDate: "2025-01-07",
    hazardKind: "wildfire",
    startHourLocal: 10,
    blurb:
      "Santa Ana wildfire in a coastal canyon suburb. Los Angeles held the whole community in a single evacuation zone of 30,447 people, and the arterials out are Palisades Drive, Sunset, Temescal Canyon and PCH.",
    provingPoint:
      "Egress capacity as the binding constraint, on a zone system with no granularity to stage.",
    center: [-118.542, 34.06],
    zoom: 12.7,
    // West edge clears the PCH/Topanga Canyon Blvd junction; east edge stops at
    // Santa Monica Canyon so the Santa Monica street grid — 50k residents who
    // were never ordered — does not become evacuating load. 85% of the ACS
    // population inside this box sits in a zone that was ordered or warned.
    bbox: [-118.61, 34.012, -118.505, 34.125],
    // 10:00–18:00 PST. Ignition 10:30 (T+1800); LAFD's blanket evacuation order
    // for the whole Palisades 12:07 (T+7647); Topanga Canyon orders 16:42
    // (T+24123). The order timestamps are read off the archived IPAWS records,
    // snapshotted at research/snapshots/ipaws-palisades-2025-01-07.json.
    duration: 28800,
    frameStep: 300,
    // AUTHORED, not fetched: sits between the Big Rock order on PCH west
    // (T+9701) and the Topanga Canyon orders (T+24123), and marks where the
    // model stops crediting westbound egress.
    burnoverAt: 14400,
    available: true,
    attribution: [
      "Fire perimeter: NIFC WFIGS Interagency Perimeters",
      "Incident record: CAL FIRE incidents API",
      "Evacuation zones: LA County / Genasys Protect, 13 Jan 2025 snapshot",
      "Alerts: FEMA OpenFEMA IPAWS archive",
      "Roads: OpenStreetMap contributors",
      "Population: US Census ACS 2019–2023",
      "Wind: Open-Meteo ERA5 archive",
    ],
  },
];

export const DEFAULT_SCENARIO_ID = "camp-fire-2018";

export function getScenario(id: string): ScenarioMeta {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding — status colours must match between map layers and list rows, so
// they live here once as RGB tuples (deck.gl) with a CSS var name alongside.
// ─────────────────────────────────────────────────────────────────────────────

export const ZONE_STATUS_RGB: Record<ZoneStatus, [number, number, number]> = {
  held: [115, 122, 134],
  ordered: [224, 169, 68],
  flowing: [79, 201, 221],
  cleared: [67, 192, 127],
  cutoff: [239, 106, 63],
};

export const ZONE_STATUS_LABEL: Record<ZoneStatus, string> = {
  held: "Held",
  ordered: "Ordered",
  flowing: "Flowing",
  cleared: "Cleared",
  cutoff: "Cut off",
};

export const ZONE_STATUS_VAR: Record<ZoneStatus, string> = {
  held: "var(--st-held)",
  ordered: "var(--st-ordered)",
  flowing: "var(--st-flowing)",
  cleared: "var(--st-cleared)",
  cutoff: "var(--st-cutoff)",
};

export const FACILITY_LABEL: Record<FacilityKind, string> = {
  fire_station: "Fire station",
  hospital: "Hospital",
  ems: "EMS",
  eoc: "Emergency ops",
  school: "School",
  shelter: "Shelter",
  nursing_home: "Nursing home",
  transit_depot: "Transit depot",
  mobile_home_park: "Mobile home park",
};

/** Facilities that can originate an evacuation asset. */
export const DISPATCH_ORIGINS: FacilityKind[] = ["fire_station", "ems", "transit_depot", "school"];

export const HAZARD_RGB: [number, number, number] = [239, 106, 63];
export const PLAN_RGB: [number, number, number] = [79, 201, 221];
export const WARN_RGB: [number, number, number] = [224, 169, 68];

/** Congestion ramp: free-flow -> saturated. Indexed by load fraction bucket. */
export const CONGESTION_RAMP: [number, number, number][] = [
  [79, 201, 221],
  [110, 200, 190],
  [170, 195, 140],
  [224, 169, 68],
  [235, 130, 60],
  [239, 80, 55],
];

// ─────────────────────────────────────────────────────────────────────────────
// Basemaps — every one keyless. No token can expire on stage.
// ─────────────────────────────────────────────────────────────────────────────

export const ESRI_IMAGERY_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export const CARTO_DARK_TILES = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

export const CARTO_LIGHT_TILES = "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

/** Terrarium-encoded DEM, free and keyless via AWS Open Data. */
export const TERRAIN_DEM_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export const ATTRIBUTION_ESRI =
  'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';
export const ATTRIBUTION_CARTO =
  '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

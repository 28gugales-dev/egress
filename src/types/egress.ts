/**
 * Egress domain types.
 *
 * This file is the contract every module codes against. Simulation payloads on
 * disk (public/data/<scenario>/*.json) deserialize directly into these shapes —
 * the pipeline scripts in scripts/ are responsible for producing them exactly.
 *
 * Coordinate convention throughout: [lng, lat], GeoJSON order, WGS84.
 */

export type LngLat = [number, number];
export type LngLatAlt = [number, number, number];

/** Seconds since scenario T+0. Every time field in this file uses it. */
export type Tick = number;

// ─────────────────────────────────────────────────────────────────────────────
// Scenario
// ─────────────────────────────────────────────────────────────────────────────

export type HazardKind = "wildfire" | "plume" | "flood";

export interface ScenarioMeta {
  id: string;
  name: string;
  place: string;
  /** ISO date of the real event this replays. */
  eventDate: string;
  hazardKind: HazardKind;
  blurb: string;
  /** What this scenario is in the deck to prove. */
  provingPoint: string;
  center: LngLat;
  zoom: number;
  bbox: [number, number, number, number];
  /**
   * Local wall-clock hour that T+0 represents. The pipeline's clock arithmetic
   * and the UI's wall-clock readout both read this, so a scenario whose event
   * starts mid-morning cannot end up with the hazard model and the scrubber
   * four hours apart. Absent means 06:00 local, the original convention.
   */
  startHourLocal?: number;
  /** Total simulated span in seconds. */
  duration: Tick;
  /** Seconds per frame in the precomputed runs. */
  frameStep: Tick;
  /** When the hazard overruns the last occupied egress route. */
  burnoverAt: Tick;
  /** True once the scenario has committed data on disk. */
  available: boolean;
  attribution: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Road network
// ─────────────────────────────────────────────────────────────────────────────

/** OSM highway classes we keep. Anything else is dropped at pipeline time. */
export type RoadClass =
  | "motorway"
  | "trunk"
  | "primary"
  | "secondary"
  | "tertiary"
  | "residential"
  | "unclassified"
  | "service";

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  roadClass: RoadClass;
  /** Directional lane count actually used for capacity. */
  lanes: number;
  oneway: boolean;
  /** Metres. */
  length: number;
  /** km/h, free-flow. */
  speed: number;
  /** Vehicles per hour, directional. lanes * perLaneCapacity(roadClass). */
  capacity: number;
  /** True when the planner may reverse the opposing lanes on this edge. */
  contraflowEligible: boolean;
  geometry: LngLat[];
  name?: string;
}

export interface RoadNode {
  id: string;
  position: LngLat;
  /** Node is a valid evacuation destination (network exit / safe zone). */
  isSink?: boolean;
}

export interface RoadNetwork {
  scenarioId: string;
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** Nodes flagged isSink, denormalized for the solver. */
  sinks: string[];
  generatedAt: string;
  source: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hazard
// ─────────────────────────────────────────────────────────────────────────────

export interface HazardFrame {
  t: Tick;
  /** Outer polygon rings. Multi-ring for disjoint fire fronts. */
  rings: LngLat[][];
  /** Edges rendered impassable at or after this frame. */
  closedEdgeIds: string[];
  /** Observed vs interpolated between observations. */
  provenance: "observed" | "interpolated";
  /** Hotspot detections at this timestep, if any. */
  hotspots?: LngLat[];
}

export interface WindSample {
  t: Tick;
  /** Metres per second. */
  speed: number;
  /** Degrees, meteorological convention (direction wind comes FROM). */
  direction: number;
  gust?: number;
}

export interface HazardTrack {
  scenarioId: string;
  kind: HazardKind;
  frames: HazardFrame[];
  wind: WindSample[];
  source: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Population
// ─────────────────────────────────────────────────────────────────────────────

export interface PopulationCell {
  /** Census block group GEOID. */
  id: string;
  centroid: LngLat;
  geometry: LngLat[][];
  population: number;
  households: number;
  /** Households reporting zero vehicles available — the transit-dependent. */
  noVehicleHouseholds: number;
  vehiclesAvailable: number;
  age65Plus: number;
  withDisability: number;
  /** Households where no adult speaks English "very well". */
  limitedEnglishHouseholds: number;
  /** ISO 639-1 codes present in this cell, most common first. */
  languages: string[];
  /** Structures in this cell that are manufactured/mobile housing. */
  mobileHomes: number;
}

export interface PopulationLayer {
  scenarioId: string;
  cells: PopulationCell[];
  totals: {
    population: number;
    households: number;
    noVehicleHouseholds: number;
    vehicles: number;
  };
  source: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evacuation zones
// ─────────────────────────────────────────────────────────────────────────────

export type ZoneStatus = "held" | "ordered" | "flowing" | "cleared" | "cutoff";

export interface EvacZone {
  /** Mirrors real county naming so the output pastes into an existing tool. */
  id: string;
  label: string;
  geometry: LngLat[][];
  centroid: LngLat;
  blockGroupIds: string[];
  households: number;
  population: number;
  noVehicleHouseholds: number;
  vehicles: number;
  mobileHomes: number;
  /** Primary egress path out of this zone, as edge ids. */
  primaryRouteEdgeIds: string[];
  primaryRouteLabel: string;
  /** Seconds from T+0 until the hazard reaches this zone. */
  hazardEta: Tick;
  /**
   * The county's own structure count for this zone, when the zone came from a
   * published official layer. Kept beside our ACS-derived `households` on
   * purpose: the two disagree, and showing both is the honest cross-check.
   * Absent on derived zones.
   */
  officialStructures?: number;
}

export interface ZoneLayer {
  scenarioId: string;
  zones: EvacZone[];
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Facilities and fleet
// ─────────────────────────────────────────────────────────────────────────────

export type FacilityKind =
  | "fire_station"
  | "hospital"
  | "ems"
  | "eoc"
  | "school"
  | "shelter"
  | "nursing_home"
  | "transit_depot"
  | "mobile_home_park";

export interface Facility {
  id: string;
  kind: FacilityKind;
  name: string;
  position: LngLat;
  /** Shelter capacity, or 0 for non-shelter facilities. */
  capacity: number;
  assets: { bus: number; ambulance: number; engine: number };
  /** Present when the facility is itself inside the hazard footprint. */
  atRiskFrom?: Tick;
  source: string;
}

export interface FacilityLayer {
  scenarioId: string;
  facilities: Facility[];
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan: the actuating output
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseWave {
  wave: number;
  departAt: Tick;
  zoneIds: string[];
  households: number;
  noVehicleHouseholds: number;
  routeLabel: string;
  /** Fraction of the binding edge's capacity this wave consumes, 0..1 */
  egressLoad: number;
  /** Earliest hazard ETA across the zones in this wave. */
  hazardEta: Tick;
  /** Set when this wave is what pins total clearance. */
  binding?: boolean;
  /** Plain-language reason the solver placed the wave here. */
  rationale?: string;
}

export interface ContraflowOrder {
  edgeIds: string[];
  label: string;
  activateAt: Tick;
  releaseAt: Tick;
  /** Directional capacity before and after reversal, veh/hr. */
  capacityBefore: number;
  capacityAfter: number;
}

export interface PickupStop {
  seq: number;
  label: string;
  position: LngLat;
  passengers: number;
  wheelchair: number;
  /** Oxygen, gurney, dialysis — anything that constrains the vehicle. */
  medicalNotes: string[];
  arriveAt: Tick;
}

export interface VehicleManifest {
  id: string;
  kind: "bus" | "ambulance" | "paratransit";
  originFacilityId: string;
  originLabel: string;
  seats: number;
  wheelchairSlots: number;
  assignedZoneIds: string[];
  stops: PickupStop[];
  dropFacilityId: string;
  dropLabel: string;
  dropAt: Tick;
  /** Seconds between the drop and hazard arrival at the last stop. */
  slack: Tick;
  path: LngLat[];
  timestamps: Tick[];
}

export interface EvacPlan {
  scenarioId: string;
  /** "baseline" replays what happened; "planned" is the counterfactual. */
  kind: RunKind;
  waves: ReleaseWave[];
  contraflow: ContraflowOrder[];
  manifests: VehicleManifest[];
  revision: number;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation runs
// ─────────────────────────────────────────────────────────────────────────────

export type RunKind = "baseline" | "planned";

/** Tunables the operator moves. Drives lookup into the precomputed grid. */
export interface RunParams {
  /** Fraction of ordered households that actually leave. 0..1 */
  compliance: number;
  /** Fraction of NON-ordered households that leave anyway and add load. 0..1 */
  shadowEvac: number;
  /** Seconds of warning before the first wave departs. */
  noticeTime: Tick;
  /** Mean vehicles taken per evacuating household. */
  vehiclesPerHousehold: number;
  staged: boolean;
  contraflow: boolean;
  busDispatch: boolean;
  shelterInPlaceOption: boolean;
}

/** Per-timestep state. One of these per frameStep across the run. */
export interface RunFrame {
  t: Tick;
  /** edgeId -> load fraction of capacity, 0..1+. Sparse: absent means empty. */
  edgeLoad: Record<string, number>;
  /** zoneId -> households remaining. */
  zoneRemaining: Record<string, number>;
  /** zoneId -> status at this instant. */
  zoneStatus: Record<string, ZoneStatus>;
  vehiclesMoving: number;
  vehiclesCleared: number;
  /** Vehicles still inside the hazard footprint. The number that means lives. */
  vehiclesInHazard: number;
  peopleCleared: number;
  /** Longest standing queue on any edge, metres. */
  peakQueueLength: number;
}

/** deck.gl TripsLayer-compatible. path[i] is at timestamps[i]. */
export interface Trip {
  path: LngLat[];
  timestamps: Tick[];
  /** Which zone these vehicles came out of, for filtering and coloring. */
  zoneId: string;
  /** Vehicles represented by this trip, for width weighting. */
  weight: number;
  kind: "household" | "bus" | "ambulance";
}

export interface RunSummary {
  /** Seconds until the last evacuee reaches a sink. The headline number. */
  clearanceTime: Tick;
  vehiclesInHazardAtBurnover: number;
  peopleInHazardAtBurnover: number;
  peakQueueLength: number;
  totalEvacuated: number;
  unassigned: number;
  /** Mean fraction of egress capacity used across the run, 0..1 */
  meanEgressUtilization: number;
}

export interface SimulationRun {
  scenarioId: string;
  kind: RunKind;
  params: RunParams;
  plan: EvacPlan;
  frames: RunFrame[];
  trips: Trip[];
  summary: RunSummary;
  /** Present on baseline runs: how the model compares to the real outcome. */
  validation?: {
    observedNarrative: string;
    modeledClearance: Tick;
    observedClearanceApprox: Tick;
    note: string;
  };
  generatedAt: string;
}

/**
 * Precomputed parameter sweep. Sliders interpolate this instead of re-solving.
 * Key format: `${compliance}|${shadowEvac}|${staged}|${contraflow}|${busDispatch}`
 * with numeric parts quantized to the grid step.
 */
export interface ParamGrid {
  scenarioId: string;
  axes: {
    compliance: number[];
    shadowEvac: number[];
    noticeTime: number[];
    vehiclesPerHousehold: number[];
  };
  entries: Record<string, RunSummary>;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerting
// ─────────────────────────────────────────────────────────────────────────────

export type CapUrgency = "Immediate" | "Expected" | "Future" | "Past" | "Unknown";
export type CapSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
export type CapCertainty = "Observed" | "Likely" | "Possible" | "Unlikely" | "Unknown";

export interface AlertMessage {
  lang: string;
  headline: string;
  body: string;
  /** Reading-grade estimate; we target <= 6. */
  readingGrade: number;
}

export interface CapAlert {
  identifier: string;
  sent: string;
  status: "Actual" | "Exercise" | "System" | "Test" | "Draft";
  msgType: "Alert" | "Update" | "Cancel" | "Ack" | "Error";
  scope: "Public" | "Restricted" | "Private";
  category: "Fire" | "Safety" | "Health" | "Env" | "Met";
  event: string;
  urgency: CapUrgency;
  severity: CapSeverity;
  certainty: CapCertainty;
  zoneId: string;
  areaDesc: string;
  polygon: LngLat[];
  effective: string;
  expires: string;
  messages: AlertMessage[];
  /** Households with no push channel — someone has to knock. */
  doorKnockHouseholds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI state
// ─────────────────────────────────────────────────────────────────────────────

export type BasemapId = "satellite" | "dark" | "terrain";
export type ViewMode = "planned" | "baseline" | "split";
export type MapColorBy = "status" | "urgency" | "load" | "vulnerability";

export interface LayerVisibility {
  hazard: boolean;
  flow: boolean;
  congestion: boolean;
  zones: boolean;
  noVehicle: boolean;
  facilities: boolean;
  busArcs: boolean;
  /** Road closures from the modelled perimeter, and the barrier marks on them.
   *  Separate from `hazard` because a commander reads the perimeter and the
   *  closures it implies as two different questions: where is the fire, and
   *  which roads has it already taken. */
  roadblocks: boolean;
  population: boolean;
  terrain: boolean;

  // Environmental and exposure context. Keys mirror ContextLayerId in
  // src/types/context-layers.ts; payloads are optional, so each of these can be
  // true with nothing on disk and the map simply draws nothing for it. All
  // default off — the core stack is what the console is about.
  airQuality: boolean;
  /** Satellite column aerosol (MODIS MAIAC AOD). Separate from `airQuality`
   *  because the two answer different questions and disagree on this scenario:
   *  the monitors measure PM2.5 at the surface where people breathe, the
   *  satellite measures optical depth through the whole column. Riding one
   *  switch would have implied they are the same measurement. */
  aerosol: boolean;
  fireIntensity: boolean;
  smoke: boolean;
  transmission: boolean;
  socialVulnerability: boolean;
  fireWeather: boolean;
  slope: boolean;
  burnScars: boolean;

  // Street-, block- and structure-level detail. Keys match the payloads in
  // src/types/detail-layers.ts. All default ON: each one is gated on view zoom
  // (see DETAIL_ZOOM in components/map/detail-layers.tsx), so at the overview
  // zoom the console starts at they draw nothing at all, and the operator gets
  // detail by zooming in rather than by hunting for a toggle.
  buildings: boolean;
  blocks: boolean;
  streetLabels: boolean;
}

export interface MapFilters {
  /** Only show zones at or above this urgency band. */
  minUrgency: 0 | 1 | 2 | 3;
  /** Restrict to zones whose status is in this set. Empty = all. */
  statuses: ZoneStatus[];
  /** Restrict to facilities of these kinds. Empty = all. */
  facilityKinds: FacilityKind[];
  /** Only zones with at least this many no-vehicle households. */
  minNoVehicle: number;
  /** Free-text match against zone label or road name. */
  query: string;
  /** Only show zones whose hazard ETA is under this many seconds. */
  maxHazardEta: Tick | null;
}

export type InspectorTab = "route" | "people" | "teams" | "queue" | "detail";

/**
 * What the operator has picked.
 *
 * The first four kinds are the ones the deck stack has always dispatched. The
 * rest exist because everything drawn on the map has to be interrogable — a
 * census block, an environmental observation, a release wave and a hazard frame
 * are all things a commander points at, and a click that opens nothing reads as
 * a broken instrument.
 *
 * `id` is opaque to the store and resolved by whichever panel owns the kind.
 * Kinds whose features carry no natural key (`context`) encode a resolvable
 * composite: `<layerId>:<featureKey>`. See components/inspector/pick-select.ts.
 */
export interface Selection {
  kind:
    | "zone"
    | "edge"
    | "facility"
    | "vehicle"
    | "cell"
    | "context"
    | "wave"
    | "hazard"
    | "block"
    | "building"
    | null;
  id: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incident feed
//
// What the run DID, as a log an incident commander can read while it replays.
//
// These are derived in the browser from a loaded SimulationRun and its sibling
// payloads — no pipeline script writes them and nothing on disk deserializes
// into them. src/lib/incident-feed.ts is the only producer, and it may only
// read what the solver already committed.
//
// Every event carries the tick it was derived at, so the feed is a pure
// function of the playhead: the rows visible at time t are exactly the events
// with `t <= playhead`. Scrubbing backwards removes rows rather than leaving a
// fired queue behind, which is the only behaviour a scrubbable replay can have
// and still be deterministic.
// ─────────────────────────────────────────────────────────────────────────────

export type IncidentEventKind =
  | "ignition"
  | "wave"
  | "ordered"
  | "flowing"
  | "cleared"
  | "cutoff"
  | "restored"
  | "corridor-closed"
  | "contraflow-on"
  | "contraflow-off"
  | "pickup"
  | "drop"
  | "exposure"
  | "burnover"
  | "clearance"
  | "validation";

/**
 * How loudly the feed carries an event.
 *
 * Deliberately NOT a severity ramp of its own: each tone resolves to a hue the
 * console already uses for that data state — hazard, warn, plan, ok — so a red
 * row in the feed means the same thing a red zone means on the map.
 */
export type IncidentTone = "critical" | "warning" | "plan" | "ok" | "neutral";

export interface IncidentEvent {
  /** Deterministic: kind, tick and subject. Same run in, same ids out. */
  id: string;
  t: Tick;
  kind: IncidentEventKind;
  tone: IncidentTone;
  /** Group label for the row, set in `.label-mono`. */
  channel: string;
  /** One line. Mechanical facts only — counts, ticks, road names. */
  headline: string;
  /** Second line. Quoted from the payload wherever the payload speaks. */
  detail?: string;
  /** Entities folded into this row when several fired on the same frame. */
  count: number;
  /** What clicking the row selects. Absent on aggregates and on run-wide events. */
  subject?: { kind: Selection["kind"]; id: string };
  /** Where clicking the row points the camera. */
  focus?: LngLat;
  /**
   * The tick came off an interpolated hazard frame rather than an observed
   * perimeter, so the minute is modelled rather than reported. Marked on the
   * row — the timeline's provenance band is the precedent.
   */
  modelled?: boolean;
}

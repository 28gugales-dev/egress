/**
 * Environmental and exposure context layers.
 *
 * A second, optional contract alongside src/types/egress.ts. Everything here is
 * atmosphere, terrain, infrastructure and demography around the evacuation —
 * never an input to the solver. The solver stays deterministic on the core
 * bundle; these layers explain the picture, they do not move the numbers.
 *
 * Two rules the shapes enforce rather than merely document:
 *
 *  1. EVERY payload carries `provenance`. "observed" means a measurement came
 *     off a satellite, a monitor, or a published record. "modelled" means we
 *     computed it. There is no third state, and no payload may omit the field —
 *     that is what makes the UI able to label a layer honestly without the
 *     component having to know where the numbers came from.
 *
 *  2. Layers are INDEPENDENT. The manifest lists a per-layer `available` flag
 *     and, when false, the `reason`. One dead upstream disables one toggle; it
 *     can never take the map with it.
 *
 * Coordinate convention, as everywhere: [lng, lat], GeoJSON order, WGS84.
 * Time convention, as everywhere: seconds since scenario T+0 (`Tick`).
 */

import type { LngLat, Tick } from "@/types/egress";

/**
 * Observed = measured by an instrument or published by the agency of record.
 * Modelled = derived by us. Anything we computed says so, in the manifest and
 * on the toggle. See "Never silently synthesize" in CLAUDE.md.
 */
export type Provenance = "observed" | "modelled";

export type ContextLayerId =
  | "airQuality"
  | "aerosol"
  | "fireIntensity"
  | "smoke"
  | "transmission"
  | "socialVulnerability"
  | "fireWeather"
  | "slope"
  | "burnScars";

/** Ordered worst-to-best so a render pass can draw context under exposure. */
export const CONTEXT_LAYER_IDS: ContextLayerId[] = [
  "aerosol",
  "smoke",
  "slope",
  "burnScars",
  "transmission",
  "socialVulnerability",
  "fireWeather",
  "airQuality",
  "fireIntensity",
];

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextLayerEntry {
  id: ContextLayerId;
  /** Human label. The UI appends a MODELLED chip itself from `provenance`. */
  label: string;
  /** Filename under public/data/<scenario>/context/, or null when it failed. */
  file: string | null;
  available: boolean;
  provenance: Provenance;
  /** Agency / product name, for attribution. */
  source: string;
  /** The exact URL that was fetched, so a claim can be re-checked. */
  sourceUrl: string;
  /** Features, stations, cells — whatever the layer counts. 0 when absent. */
  recordCount: number;
  /** True when the layer changes with the scrubber. */
  timeVarying: boolean;
  bytes: number;
  /** What the layer means, and what it does NOT mean. Always populated. */
  note: string;
  /** Populated only when `available` is false. Names the upstream failure. */
  reason?: string;
}

export interface ContextManifest {
  scenarioId: string;
  generatedAt: string;
  /** Epoch seconds of scenario T+0. Copied from weather.json so the context
   *  clock cannot drift from the wind track. */
  scenarioStartEpoch: number;
  layers: ContextLayerEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Air quality — regulatory monitors, hourly
// ─────────────────────────────────────────────────────────────────────────────

export interface AirQualityStation {
  /** AQS site id, e.g. 060070008. */
  id: string;
  name: string;
  agency: string;
  position: LngLat;
  /**
   * False when the monitor published nothing across the whole window. Kept as
   * a first-class field rather than an empty series: a silent monitor inside
   * the burn footprint is a finding, not a gap to be smoothed over.
   */
  reporting: boolean;
  /** Highest value observed in the window, or null when silent. */
  peak: number | null;
  /** Metres from the scenario centre. Lets the UI rank by relevance. */
  distanceM: number;
}

/**
 * One hourly observation row, index-aligned to `AirQualityPayload.stations`.
 * `null` means that monitor did not report that hour — never zero, because
 * zero is a real reading and absence is not.
 */
export interface AirQualityFrame {
  t: Tick;
  values: (number | null)[];
}

export interface AirQualityPayload {
  scenarioId: string;
  provenance: Provenance;
  /** Micrograms per cubic metre, PM2.5. */
  units: "ug/m3";
  stations: AirQualityStation[];
  /**
   * Hourly. NOT resampled to the frame step: each value is an hourly mean, and
   * interpolating between two hourly means invents readings that no instrument
   * produced. Render-side holds the last value, same as `hazardFrameAt`.
   */
  frames: AirQualityFrame[];
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Aerosol optical depth — the satellite's view of the smoke column
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AOD IS NOT PM2.5. Read this before touching anything that renders it.
 *
 * Aerosol optical depth is the extinction of sunlight integrated through the
 * WHOLE atmospheric column, top to ground. It is unitless. It says how much
 * aerosol lies between the satellite and the surface; it does NOT say how much
 * of that aerosol is in the air a person is breathing. A high plume aloft and a
 * low plume at head height can return the same AOD.
 *
 * There are published AOD-to-surface-PM2.5 regressions and they are regional,
 * seasonal, and require boundary-layer height. We do not apply one. The layer
 * carries optical depth, is labelled optical depth, and is coloured on its own
 * ramp so it can never be read as a concentration.
 *
 * Cadence is per satellite overpass, not hourly. `timeVarying` is false on this
 * layer's manifest entry for exactly that reason: a single day's retrieval held
 * across a 12-hour replay would imply a continuity the instrument never had.
 */
export interface AerosolPayload {
  scenarioId: string;
  provenance: Provenance;
  /** Unitless by definition. Present so no consumer has to guess. */
  units: "optical depth (unitless)";
  /** [west, south, east, north], the grid's exact footprint. */
  bbox: [number, number, number, number];
  width: number;
  height: number;
  /** Approximate ground size of one cell, metres. */
  cellMetres: number;
  /**
   * base64 of a width*height Uint8Array, ROW 0 IS NORTH (image convention, so
   * it feeds a texture with no flip). Byte 255 is reserved: NO RETRIEVAL — the
   * algorithm did not return a value for that cell. It is not zero, and it must
   * never be rendered as clear air.
   */
  grid: string;
  /** AOD represented by byte 254. Byte b decodes to b / 254 * scaleMax. */
  scaleMax: number;
  /** Cells carrying a retrieval, and the total. Coverage is a finding. */
  retrieved: number;
  cells: number;
  /** Min / max AOD actually present in the grid. */
  aodRange: [number, number];
  /** Date of the retrieval, ISO. One day, not a range. */
  observedDate: string;
  /** Satellite overpasses the daily composite is built from, local solar time. */
  overpassNote: string;
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Fire intensity — radiative power per satellite detection
// ─────────────────────────────────────────────────────────────────────────────

export interface FireDetection {
  position: LngLat;
  t: Tick;
  /** Fire Radiative Power, megawatts. The physical intensity measure. */
  frp: number;
  /** Brightness temperature, kelvin. */
  brightness: number;
  confidence: string;
  /** VIIRS_SNPP_NRT, MODIS_SP, and so on. */
  sensor: string;
  /** Satellite overpass, ISO. FRP is instantaneous at this moment only. */
  acquiredUtc: string;
}

export interface FireIntensityPayload {
  scenarioId: string;
  provenance: Provenance;
  detections: FireDetection[];
  /** Drives the colour and radius ramps without a render-time scan. */
  frpRange: [number, number];
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Smoke plumes — satellite analyst-drawn polygons
// ─────────────────────────────────────────────────────────────────────────────

export type SmokeDensity = "light" | "medium" | "heavy";

export interface SmokePlume {
  density: SmokeDensity;
  /** Satellite analysis window, as scenario ticks. May start before T+0. */
  startT: Tick;
  endT: Tick;
  satellite: string;
  rings: LngLat[][];
}

export interface SmokePayload {
  scenarioId: string;
  provenance: Provenance;
  plumes: SmokePlume[];
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Electric transmission
// ─────────────────────────────────────────────────────────────────────────────

export interface TransmissionLine {
  id: string;
  owner: string;
  /** Nominal kV. -999999 in the upstream means "not published"; null here. */
  voltageKv: number | null;
  voltClass: string;
  status: string;
  /** Substation endpoints, as published. Often the only usable line name. */
  from: string;
  to: string;
  path: LngLat[];
}

export interface TransmissionPayload {
  scenarioId: string;
  provenance: Provenance;
  lines: TransmissionLine[];
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Social vulnerability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CDC/ATSDR SVI percentile ranks, 0..1, higher = more vulnerable. The source
 * encodes suppressed values as -999; those become null rather than 0, because
 * a suppressed tract is unknown, not invulnerable.
 */
export interface SviTract {
  geoid: string;
  name: string;
  /** Overall summary rank, RPL_THEMES. */
  overall: number | null;
  /** Theme 1 — poverty, unemployment, income, education. */
  socioeconomic: number | null;
  /** Theme 2 — age 65+, age 17-, disability, single-parent. */
  householdComposition: number | null;
  /** Theme 3 — minority status and limited English. */
  minorityLanguage: number | null;
  /** Theme 4 — multi-unit, mobile homes, crowding, NO VEHICLE, group quarters. */
  housingTransport: number | null;
  population: number;
  /** Households with no vehicle available, count. Pairs with the ACS layer. */
  noVehicle: number | null;
  centroid: LngLat;
  geometry: LngLat[][];
}

export interface SviPayload {
  scenarioId: string;
  provenance: Provenance;
  tracts: SviTract[];
  /** Tracts whose CSV row matched a geometry, over tracts attempted. A silent
   *  partial join is the failure mode this field exists to expose. */
  joinRate: number;
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Fire weather advisories
// ─────────────────────────────────────────────────────────────────────────────

export interface FireWeatherAdvisory {
  id: string;
  /** "Red Flag Warning", "Wind Advisory", … */
  event: string;
  /** NWS VTEC phenomena code — FW, WI, HW. */
  phenomena: string;
  /** VTEC significance — W warning, A watch, Y advisory. */
  significance: string;
  /** Issuing office, e.g. STO (Sacramento). */
  office: string;
  /** UGC zone codes the product covered. */
  zones: string[];
  issuedUtc: string;
  expiresUtc: string;
  /** Scenario ticks. Negative when issued before T+0, which is the normal case
   *  for a fire-weather product — the warning precedes the fire. */
  startT: Tick;
  endT: Tick;
  /** NWS product identifier, so the original text can be pulled. */
  productId: string;
  /**
   * Absent on archive records. The UGC zones a 2018 product referenced have
   * since been retired and api.weather.gov 404s on them, so those advisories
   * are real and timestamped but have no drawable footprint. Verified, not
   * assumed — see research/endpoint-verification.md.
   */
  rings?: LngLat[][];
  /** True for an alert pulled live today; false for an archive record. */
  live: boolean;
}

export interface FireWeatherPayload {
  scenarioId: string;
  provenance: Provenance;
  /** Products in force over the real event, from the VTEC archive. */
  archive: FireWeatherAdvisory[];
  /** Whatever is in force right now — exercises the live path on stage. */
  live: FireWeatherAdvisory[];
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Terrain slope
// ─────────────────────────────────────────────────────────────────────────────

export interface SlopeCell {
  /** Cell centre. */
  position: LngLat;
  /** Metres above sea level. */
  elevation: number;
  /** Degrees from horizontal, 0..90. */
  slope: number;
  /** Downslope azimuth, degrees clockwise from north. */
  aspect: number;
  /**
   * Rothermel slope factor: how much faster a head fire runs upslope here than
   * on the flat, all else equal. Derived, and labelled as such.
   */
  spreadFactor: number;
}

export interface SlopePayload {
  scenarioId: string;
  provenance: Provenance;
  cols: number;
  rows: number;
  /** Cell size in degrees, [lng, lat]. */
  cellDeg: [number, number];
  cells: SlopeCell[];
  /** Steepest cell in the grid, degrees. */
  maxSlope: number;
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Historical burn scars
// ─────────────────────────────────────────────────────────────────────────────

export interface BurnScar {
  id: string;
  name: string;
  year: number;
  acres: number;
  rings: LngLat[][];
}

export interface BurnScarPayload {
  scenarioId: string;
  provenance: Provenance;
  scars: BurnScar[];
  /** Inclusive year span actually returned. */
  yearRange: [number, number];
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every member is independently nullable on purpose. There is no "core" here:
 * the whole bundle is optional, and any subset of it renders.
 */
export interface ContextBundle {
  manifest: ContextManifest;
  airQuality: AirQualityPayload | null;
  aerosol: AerosolPayload | null;
  fireIntensity: FireIntensityPayload | null;
  smoke: SmokePayload | null;
  transmission: TransmissionPayload | null;
  socialVulnerability: SviPayload | null;
  fireWeather: FireWeatherPayload | null;
  slope: SlopePayload | null;
  burnScars: BurnScarPayload | null;
}

/** Maps a layer id to its slot on the bundle. */
export type ContextPayloadOf<K extends ContextLayerId> = NonNullable<ContextBundle[K]>;

/**
 * Per-structure fire severity — the model behind the building ramp.
 *
 * ── What severity is ────────────────────────────────────────────────────────
 *
 * A scalar in 0..1 per structure per simulation frame, answering the only
 * question an incident commander actually asks of a block: how long has this
 * block got. It is built from three terms, in the order they are trusted:
 *
 *   1. The structure is inside the modelled footprint at t. Severity is not on
 *      the ramp at all then — it is BURNING for a short hold and SPENT after,
 *      because ash is not urgent and must not compete with the front for
 *      attention.
 *   2. Time until the front reaches the structure (`DetailBuilding.h`). Steep
 *      inside the ninety-minute horizon a household can still be moved in,
 *      then a slow tail. It never reaches zero: a structure the model burns is
 *      never drawn green, however distant its arrival.
 *   3. Where no arrival exists, distance to the nearest ground that burns at
 *      any point in the window, timed against when that ground burns. Capped
 *      well below the ramp's hot end — exposure is not the same claim as
 *      containment and must not read like it.
 *
 * Green therefore means "the model never reaches this structure and nothing
 * within EXPOSURE_RADIUS_M of it ever burns" — not "far away right now".
 *
 * ── What severity is NOT ────────────────────────────────────────────────────
 *
 * It is not a measurement. `DetailBuilding.h` is the first frame of the NIFC
 * perimeter progression whose rings contain the centroid, and that progression
 * is one observed perimeter with the rest interpolated between observations.
 * The footprint itself is machine-learned from imagery that post-dates the
 * fire. Every consumer of this module gets `SEVERITY_PROVENANCE` alongside the
 * number and is expected to show it. A modelled arrival time presented as a
 * fact is exactly the failure this project refuses.
 *
 * ── Why it is precomputed ───────────────────────────────────────────────────
 *
 * 31,233 structures x 145 frames. The scrubber writes `t` at 30fps, so nothing
 * here may run inside a colour accessor: the whole cube is built once per
 * payload into one frame-major Uint8Array (~4.5 MB) and the accessor does a
 * single indexed read plus a lookup into a shared colour table. Building the
 * cube is table lookups too — arrival ticks and frame ticks are both multiples
 * of the frame step, so both time terms collapse into small LUTs.
 *
 * The frame axis is the SCENARIO's, never the hazard field's. camp-fire-2018
 * runs 12 h while its perimeter track carries 8 h of frames; indexing off the
 * track would freeze every structure at its T+8h colour for the last four
 * hours of the scrub.
 */

import type { DecodedField } from "@/components/map/hazard-field";
import { getScenario, HAZARD_RGB, WARN_RGB, ZONE_STATUS_RGB } from "@/lib/constants";
import type { BuildingsPayload, DetailBuilding, DetailBundle } from "@/types/detail-layers";
import type { Tick } from "@/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables. Every one is a claim about fire behaviour or about operations, so
// every one is named and justified rather than inlined.
// ─────────────────────────────────────────────────────────────────────────────

/** Reserved arrival value in the hazard field: never inside any perimeter. */
const NEVER_CELL = 255;

/**
 * Horizon of the steep part of the lead ramp. Ninety minutes is roughly the
 * span in which a household that has not left yet can still be warned, loaded
 * and moved — inside it minutes are the unit, outside it they are not.
 */
const LEAD_HORIZON: Tick = 5400;

/** Severity exactly at the horizon. Lands on the amber stop of the ramp. */
const HORIZON_SEVERITY = 0.34;

/** Decay constant of the tail past the horizon. */
const LEAD_TAIL: Tick = 7200;

/**
 * Floor for any structure the model burns inside the window. A structure with
 * six hours left is not urgent and is not safe either, so it sits at the
 * yellow-green end of the ramp and never at the green one.
 */
const IN_WINDOW_FLOOR = 0.14;

/**
 * How far exposure carries from ground that burns. Camp Fire spotted well over
 * a kilometre ahead of its own front; 900 m is a conservative reading of that
 * and still leaves most of the mapped area genuinely green.
 */
const EXPOSURE_RADIUS_M = 900;

/** Ceiling on the exposure term. Proximity to burning ground is a weaker claim
 *  than containment and must never reach the ramp's red. */
const EXPOSURE_MAX = 0.55;

/** Lead over which neighbouring ground's own arrival ramps exposure up. */
const EXPOSURE_LEAD: Tick = 5400;

/** Decay once the neighbouring ground has burned and the front has moved on. */
const EXPOSURE_COOL: Tick = 5400;

/** Exposure never quite reaches zero once the ground next door has burned. */
const EXPOSURE_RESIDUAL = 0.16;

/** How long a structure reads as actively burning after the front reaches it.
 *  Two frames — ten minutes — is the band an operator reads as "right now". */
const BURN_HOLD: Tick = 600;

/**
 * Cooling span from the burning colour to full ash. Deliberately short: the
 * pale burning colour is the highest-contrast thing the ramp can put on dark
 * imagery, so a wide band of it behind the front would out-shout the front
 * itself. Thirty minutes, on a curve that darkens early.
 */
const BURN_COOL: Tick = 1800;

/** <1 pulls the cooling curve toward ash, so only the first few minutes after
 *  arrival still read as fire. */
const BURN_COOL_POW = 0.6;

/** Fallback frame step when neither a hazard field nor scenario meta has one. */
const DEFAULT_STEP: Tick = 300;

/** The honesty string. Anything that renders a severity renders this too. */
export const SEVERITY_PROVENANCE =
  "Severity is inferred, not measured: modelled arrival from the NIFC perimeter " +
  "progression (one observed perimeter, the rest interpolated) against a " +
  "machine-learned footprint. Planning estimate, not an observation.";

// ─────────────────────────────────────────────────────────────────────────────
// Colour. Red -> orange -> amber -> yellow-green -> green, every stop derived
// from a token this project already owns. The ramp is allowed to be saturated
// because it is the one thing on the map carrying this information; the chrome
// around it stays neutral.
// ─────────────────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];
export type Rgba = [number, number, number, number];

function mixRgb(a: Rgb, b: Rgb, k: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function shade(c: Rgb, f: number): Rgb {
  return [
    Math.round(Math.min(255, c[0] * f)),
    Math.round(Math.min(255, c[1] * f)),
    Math.round(Math.min(255, c[2] * f)),
  ];
}

/** Red end: the hazard token with its green and blue pulled down. Same ember
 *  family, one step hotter — no new hue enters the palette. */
const CRITICAL_RGB: Rgb = [
  HAZARD_RGB[0],
  Math.round(HAZARD_RGB[1] * 0.55),
  Math.round(HAZARD_RGB[2] * 0.6),
];

/** Green end: the `cleared` zone-status hue, which already means exactly this
 *  one zoom level up. A mint green rather than a foliage green, which is what
 *  keeps it legible over Esri imagery. */
const CLEAR_RGB: Rgb = ZONE_STATUS_RGB.cleared;

/** Ash. Ember shaded down hard, so a burned block recedes and the leading edge
 *  stays the brightest thing on screen. */
const SPENT_RGB: Rgb = shade(HAZARD_RGB, 0.38);

/** Actively burning: the hazard token lifted toward white — the same near-white
 *  the hazard field's own core uses. */
const BURNING_RGB: Rgb = mixRgb(HAZARD_RGB, [255, 250, 242], 0.55);

interface Stop {
  at: number;
  rgb: Rgb;
  alpha: number;
}

/** Alpha climbs with severity: green settles into the imagery, red sits on it. */
const RAMP: Stop[] = [
  { at: 0.0, rgb: CLEAR_RGB, alpha: 150 },
  { at: 0.22, rgb: mixRgb(CLEAR_RGB, WARN_RGB, 0.6), alpha: 168 },
  { at: 0.45, rgb: WARN_RGB, alpha: 192 },
  { at: 0.72, rgb: HAZARD_RGB, alpha: 216 },
  { at: 1.0, rgb: CRITICAL_RGB, alpha: 238 },
];

/** Without a stroke darker than the fill, a 12 m footprint dissolves into the
 *  roofs underneath it. */
const OUTLINE_F = 0.42;

function rampAt(s: number): { rgb: Rgb; alpha: number } {
  const k = s <= 0 ? 0 : s >= 1 ? 1 : s;
  for (let i = 1; i < RAMP.length; i++) {
    const hi = RAMP[i];
    if (k > hi.at && i !== RAMP.length - 1) continue;
    const lo = RAMP[i - 1];
    const f = hi.at === lo.at ? 0 : (k - lo.at) / (hi.at - lo.at);
    return {
      rgb: mixRgb(lo.rgb, hi.rgb, f),
      alpha: Math.round(lo.alpha + (hi.alpha - lo.alpha) * f),
    };
  }
  return { rgb: RAMP[0].rgb, alpha: RAMP[0].alpha };
}

function lut(build: (i: number, n: number) => { rgb: Rgb; alpha: number }, n: number): Rgba[] {
  const out: Rgba[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const { rgb, alpha } = build(i, n);
    out[i] = [rgb[0], rgb[1], rgb[2], alpha];
  }
  return out;
}

function outlineOf(c: Rgba, alpha: number): Rgba {
  return [
    Math.round(c[0] * OUTLINE_F),
    Math.round(c[1] * OUTLINE_F),
    Math.round(c[2] * OUTLINE_F),
    alpha,
  ];
}

/**
 * 256 shared colour tuples per ramp. Shared because deck copies the values it
 * is handed straight into an attribute buffer — returning the same reference
 * for every structure in a band allocates nothing at all per frame.
 */
const RAMP_FILL: Rgba[] = lut((i, n) => rampAt(i / (n - 1)), 256);
const RAMP_LINE: Rgba[] = RAMP_FILL.map((c) => outlineOf(c, 238));

/** Burn-age table, indexed in frame steps since arrival. Burning holds, then
 *  cools into ash and drops in alpha so it stops competing with the front. */
const BURN_STEPS = 32;
const BURN_FILL: Rgba[] = lut((i) => {
  const age = i * DEFAULT_STEP;
  const raw = age <= BURN_HOLD ? 0 : Math.min(1, (age - BURN_HOLD) / BURN_COOL);
  const k = raw ** BURN_COOL_POW;
  return { rgb: mixRgb(BURNING_RGB, SPENT_RGB, k), alpha: Math.round(246 - 128 * k) };
}, BURN_STEPS);
const BURN_LINE: Rgba[] = BURN_FILL.map((c, i) => outlineOf(c, i === 0 ? 250 : 210));

// ─────────────────────────────────────────────────────────────────────────────
// Index
// ─────────────────────────────────────────────────────────────────────────────

export type BuildingSeverityState = "burning" | "spent" | "approaching" | "exposed" | "clear";

export type SeverityBand =
  | "imminent"
  | "critical"
  | "severe"
  | "elevated"
  | "watch"
  | "unthreatened";

export const SEVERITY_BAND_LABEL: Record<SeverityBand, string> = {
  imminent: "Imminent",
  critical: "Critical",
  severe: "Severe",
  elevated: "Elevated",
  watch: "Watch",
  unthreatened: "Not threatened in window",
};

export function severityBand(s: number): SeverityBand {
  if (s >= 0.85) return "imminent";
  if (s >= 0.62) return "critical";
  if (s >= 0.4) return "severe";
  if (s >= 0.2) return "elevated";
  if (s > 0.02) return "watch";
  return "unthreatened";
}

export interface BuildingSeverityIndex {
  /** Structure count — the stride of `severity`. */
  count: number;
  /** Seconds between frames. Arrival ticks are multiples of it. */
  step: Tick;
  /** Frames on the axis, covering the SCENARIO window, not the hazard track. */
  frames: number;
  /** Frame-major, quantized 0..255: `severity[frame * count + i]`. */
  severity: Uint8Array;
  /** Modelled arrival tick per structure; -1 where the model never reaches it. */
  arrival: Int32Array;
  /** Metres to the nearest ground that burns at any point in the window.
   *  -1 when unknown — no hazard field, or the structure is off its grid. */
  exposureM: Int32Array;
  /** Tick at which that nearest ground burns; -1 when unknown. */
  exposureTick: Int32Array;
  /** False when no hazard field was on disk: the exposure term is then absent
   *  for every structure and the ramp carries the arrival term alone. */
  hasField: boolean;
  /** Verbatim provenance of the field the exposure term came from. */
  fieldSource: string | null;
}

/** A loaded detail bundle with its severity cube attached. */
export interface DetailBundleWithSeverity extends DetailBundle {
  severity: BuildingSeverityIndex | null;
}

interface CacheEntry {
  field: DecodedField | null;
  index: BuildingSeverityIndex;
}

/** Keyed by payload so the split view's two map instances share one cube. */
const indexCache = new WeakMap<BuildingsPayload, CacheEntry>();

export function severityIndexFor(
  payload: BuildingsPayload,
  field: DecodedField | null,
): BuildingSeverityIndex {
  const hit = indexCache.get(payload);
  if (hit && hit.field === field) return hit.index;
  const index = buildSeverityIndex(payload, field);
  indexCache.set(payload, { field, index });
  return index;
}

/**
 * Chamfer 3-4 distance transform over the arrival grid, propagating the source
 * cell's arrival frame alongside the distance. Two linear passes over ~69k
 * cells: this is what turns "how close is ground that burns, and when does it"
 * into a static per-structure lookup instead of a per-frame search.
 */
function exposureGrid(field: DecodedField): { dist: Uint16Array; src: Uint8Array } {
  const { width: w, height: h, cells } = field;
  const n = w * h;
  const dist = new Uint16Array(n).fill(0xffff);
  const src = new Uint8Array(n).fill(NEVER_CELL);

  for (let i = 0; i < n; i++) {
    if (cells[i] !== NEVER_CELL) {
      dist[i] = 0;
      src[i] = cells[i];
    }
  }

  const relax = (i: number, j: number, cost: number) => {
    const d = dist[j] + cost;
    if (d < dist[i]) {
      dist[i] = d;
      src[i] = src[j];
    }
  };

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (dist[i] === 0) continue;
      if (y > 0) {
        relax(i, i - w, 3);
        if (x > 0) relax(i, i - w - 1, 4);
        if (x + 1 < w) relax(i, i - w + 1, 4);
      }
      if (x > 0) relax(i, i - 1, 3);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      if (dist[i] === 0) continue;
      if (y + 1 < h) {
        relax(i, i + w, 3);
        if (x + 1 < w) relax(i, i + w + 1, 4);
        if (x > 0) relax(i, i + w - 1, 4);
      }
      if (x + 1 < w) relax(i, i + 1, 3);
    }
  }
  return { dist, src };
}

function buildSeverityIndex(
  payload: BuildingsPayload,
  field: DecodedField | null,
): BuildingSeverityIndex {
  const buildings = payload.buildings;
  const count = buildings.length;
  const scenario = getScenario(payload.scenarioId);

  const step =
    field && field.frameTicks.length > 1
      ? field.frameTicks[1] - field.frameTicks[0]
      : (scenario.frameStep ?? DEFAULT_STEP);
  // Scenario window, never the hazard track's: camp-fire-2018 runs four hours
  // longer than its perimeter progression does.
  const frames = Math.max(1, Math.floor(scenario.duration / step) + 1);

  const arrival = new Int32Array(count).fill(-1);
  const exposureM = new Int32Array(count).fill(-1);
  const exposureTick = new Int32Array(count).fill(-1);
  const prox = new Float32Array(count);

  let grid: { dist: Uint16Array; src: Uint8Array } | null = null;
  let west = 0;
  let north = 0;
  let dLng = 1;
  let dLat = 1;
  if (field) {
    grid = exposureGrid(field);
    west = field.bbox[0];
    north = field.bbox[3];
    dLng = (field.bbox[2] - field.bbox[0]) / field.width;
    dLat = (field.bbox[3] - field.bbox[1]) / field.height;
  }

  for (let i = 0; i < count; i++) {
    const b = buildings[i];
    if (b.h !== null) arrival[i] = b.h;
    if (!grid || !field) continue;

    const col = Math.floor((b.c[0] - west) / dLng);
    const row = Math.floor((north - b.c[1]) / dLat);
    // Off the grid is not "clear" and not "exposed" — it is unknown, and the
    // inspection payload says so rather than the colour implying a claim.
    if (col < 0 || row < 0 || col >= field.width || row >= field.height) continue;

    const cell = row * field.width + col;
    const srcFrame = grid.src[cell];
    if (srcFrame === NEVER_CELL) continue;

    const metres = Math.round((grid.dist[cell] / 3) * field.cellMetres);
    exposureM[i] = metres;
    exposureTick[i] = field.frameTicks[Math.min(srcFrame, field.frameTicks.length - 1)];
    prox[i] = EXPOSURE_MAX * Math.max(0, Math.min(1, 1 - metres / EXPOSURE_RADIUS_M));
  }

  // Both time terms are functions of a difference between two frame ticks, so
  // both collapse into tables indexed in whole frames. What is left in the
  // 4.5M-entry inner loop is two lookups and a multiply.
  const leadLut = new Float32Array(frames + 1);
  for (let k = 0; k <= frames; k++) leadLut[k] = leadSeverity(k * step);

  const timingLut = new Float32Array(2 * frames + 1);
  for (let k = -frames; k <= frames; k++) timingLut[frames + k] = exposureTiming(k * step);

  const severity = new Uint8Array(frames * count);
  for (let f = 0; f < frames; f++) {
    const tick = f * step;
    const base = f * count;
    for (let i = 0; i < count; i++) {
      const a = arrival[i];
      let s: number;
      if (a >= 0) {
        // Past arrival the ramp does not apply: the burn state owns the colour.
        s = tick >= a ? 1 : leadLut[Math.min(frames, ((a - tick) / step) | 0)];
      } else if (prox[i] > 0) {
        const gap = ((exposureTick[i] - tick) / step) | 0;
        s = prox[i] * timingLut[frames + Math.max(-frames, Math.min(frames, gap))];
      } else {
        s = 0;
      }
      severity[base + i] = (s * 255 + 0.5) | 0;
    }
  }

  return {
    count,
    step,
    frames,
    severity,
    arrival,
    exposureM,
    exposureTick,
    hasField: field !== null,
    fieldSource: field?.source ?? null,
  };
}

/** Steep inside the horizon a household can still be moved in, slow tail past
 *  it, and a floor so nothing the model burns is ever drawn green. */
function leadSeverity(lead: Tick): number {
  if (lead <= 0) return 1;
  if (lead <= LEAD_HORIZON) {
    const u = 1 - lead / LEAD_HORIZON;
    return HORIZON_SEVERITY + (1 - HORIZON_SEVERITY) * u ** 0.85;
  }
  const decay = Math.exp(-(lead - LEAD_HORIZON) / LEAD_TAIL);
  return IN_WINDOW_FLOOR + (HORIZON_SEVERITY - IN_WINDOW_FLOOR) * decay;
}

/** Exposure rises as the ground next door approaches its own arrival, peaks as
 *  it burns, and falls once the front has gone past — to a residual, because
 *  standing beside burned ground is not the same as never having been near the
 *  fire at all. */
function exposureTiming(gap: Tick): number {
  if (gap > 0) return Math.max(0, 1 - gap / EXPOSURE_LEAD);
  const cooled = Math.exp(gap / EXPOSURE_COOL);
  return EXPOSURE_RESIDUAL + (1 - EXPOSURE_RESIDUAL) * cooled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read side — everything below is O(1) and safe to call per structure per frame
// ─────────────────────────────────────────────────────────────────────────────

/** Frame the playhead sits in, clamped onto the cube's axis. */
export function severityFrame(ix: BuildingSeverityIndex, t: Tick): number {
  const f = Math.floor(t / ix.step);
  return f < 0 ? 0 : f >= ix.frames ? ix.frames - 1 : f;
}

export function severityAt(ix: BuildingSeverityIndex, frame: number, i: number): number {
  return ix.severity[frame * ix.count + i] / 255;
}

export function severityStateAt(
  ix: BuildingSeverityIndex,
  t: Tick,
  i: number,
): BuildingSeverityState {
  const a = ix.arrival[i];
  if (a >= 0) {
    if (t < a) return "approaching";
    return t - a <= BURN_HOLD ? "burning" : "spent";
  }
  const m = ix.exposureM[i];
  return m >= 0 && m < EXPOSURE_RADIUS_M ? "exposed" : "clear";
}

/** One shared tuple per band. Never mutate the result. */
export function buildingFillColor(
  ix: BuildingSeverityIndex,
  frame: number,
  t: Tick,
  i: number,
): Rgba {
  const a = ix.arrival[i];
  if (a >= 0 && t >= a) return BURN_FILL[burnStep(ix, t - a)];
  return RAMP_FILL[ix.severity[frame * ix.count + i]];
}

export function buildingLineColor(
  ix: BuildingSeverityIndex,
  frame: number,
  t: Tick,
  i: number,
): Rgba {
  const a = ix.arrival[i];
  if (a >= 0 && t >= a) return BURN_LINE[burnStep(ix, t - a)];
  return RAMP_LINE[ix.severity[frame * ix.count + i]];
}

function burnStep(ix: BuildingSeverityIndex, age: Tick): number {
  const k = Math.floor(age / ix.step);
  return k < 0 ? 0 : k >= BURN_STEPS ? BURN_STEPS - 1 : k;
}

/** Words for the legend, the tooltip and any dock that inspects a structure.
 *  The burn states are deliberately not on the severity ramp. */
export function severityStateLabel(state: BuildingSeverityState, s: number): string {
  if (state === "burning") return "Burning now";
  if (state === "spent") return "Burned through";
  const band = severityBand(s);
  // Standing near ground that burns eight hours from now is not exposure yet,
  // and the structure is drawn green — so the words follow the colour rather
  // than contradicting it.
  if (state === "exposed" && band !== "unthreatened") return "Exposed — front passes nearby";
  return SEVERITY_BAND_LABEL[band];
}

/** Swatch for a state, for anything drawing a key. */
export function severitySwatch(state: BuildingSeverityState, s: number): Rgba {
  if (state === "burning") return BURN_FILL[0];
  if (state === "spent") return BURN_FILL[BURN_STEPS - 1];
  return RAMP_FILL[Math.max(0, Math.min(255, Math.round(s * 255)))];
}

/** Ordered stops for a legend strip, hot end first. Exported so a key can be
 *  drawn from the same numbers the map is drawn from. */
export const SEVERITY_KEY: { label: string; rgba: Rgba }[] = [
  { label: "Burning now", rgba: BURN_FILL[0] },
  { label: "Burned through", rgba: BURN_FILL[BURN_STEPS - 1] },
  { label: SEVERITY_BAND_LABEL.imminent, rgba: RAMP_FILL[242] },
  { label: SEVERITY_BAND_LABEL.critical, rgba: RAMP_FILL[186] },
  { label: SEVERITY_BAND_LABEL.severe, rgba: RAMP_FILL[130] },
  { label: SEVERITY_BAND_LABEL.elevated, rgba: RAMP_FILL[74] },
  { label: SEVERITY_BAND_LABEL.watch, rgba: RAMP_FILL[28] },
  { label: SEVERITY_BAND_LABEL.unthreatened, rgba: RAMP_FILL[0] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Inspection payload — the shape a dock would bind to. Everything a panel could
// want about one structure, resolved, with every inferred field carrying how it
// was inferred.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildingInspection {
  kind: "building";
  /** Index into the payload array. A DetailBuilding carries no id of its own. */
  index: number;
  building: DetailBuilding;
  /** Playhead the reading was taken at. */
  t: Tick;
  severity: number;
  band: SeverityBand;
  state: BuildingSeverityState;
  /** Band or burn state in words, ready to render. */
  stateLabel: string;
  /** MODELLED, never observed. Null where the model never reaches it. */
  arrivalTick: Tick | null;
  /** Seconds until the modelled front arrives; negative once it has passed. */
  leadSeconds: number | null;
  /** Metres to the nearest ground that burns in the window; null when unknown. */
  exposureMetres: number | null;
  exposureTick: Tick | null;
  structureType: string | null;
  /** OBSERVED — a CAL FIRE inspector recorded this outcome. */
  damage: DetailBuilding["d"] | null;
  areaSqM: number;
  centroid: DetailBuilding["c"];
  zoneId: string | null;
  zoneLabel: string | null;
  /** Release wave of the containing zone, 0-based; null when not in the plan. */
  wave: number | null;
  waveCount: number;
  provenance: {
    /** How the arrival time was produced. */
    arrival: "modelled-perimeter-progression" | "not-reached-in-window";
    /** Always inferred. There is no measured per-structure severity. */
    severity: "inferred";
    footprint: DetailBuilding["f"];
    presence: DetailBuilding["p"];
    /** Release date of the footprint product. */
    imageryVintage: string;
    /** Whether the exposure term had a hazard field to work from. */
    exposure: "hazard-field" | "unavailable" | "off-grid";
    note: string;
  };
}

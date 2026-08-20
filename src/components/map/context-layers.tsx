"use client";

import type { Color, Layer, PickingInfo } from "@deck.gl/core";
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import {
  CloudFog,
  Flame,
  History,
  Mountain,
  Satellite,
  TriangleAlert,
  Users,
  Wind,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { actions, selLayers, selScenarioId, useEgress } from "@/lib/store";
import type {
  AerosolPayload,
  AirQualityPayload,
  AirQualityStation,
  BurnScar,
  ContextBundle,
  ContextLayerEntry,
  ContextLayerId,
  ContextManifest,
  FireDetection,
  FireWeatherAdvisory,
  SlopeCell,
  SlopePayload,
  SmokePlume,
  SviTract,
  TransmissionLine,
} from "@/types/context-layers";
import { CONTEXT_LAYER_IDS } from "@/types/context-layers";
import type { LayerVisibility, LngLat, Tick } from "@/types/egress";
import { decodeGrid, MISSING, NEAREST, type Rgb, rasteriseGrid } from "./context-raster";

/**
 * Environmental and exposure context layers for the deck.gl stack.
 *
 * ── INTEGRATION POINT ───────────────────────────────────────────────────────
 *
 * This module is self-contained and composes into the existing stack in three
 * places. Nothing here edits deck-layers.tsx, the rail, or the shell.
 *
 *   1. src/components/map/map-shell.tsx (or wherever DeckOverlay is rendered)
 *
 *        const context = useContextBundle(scenarioId);
 *        const layers = [
 *          ...buildContextLayers({ context, t, layers, idPrefix, interactive }),
 *          ...buildLayers({ bundle, run, t, layers, ... }),
 *        ];
 *
 *      Context FIRST in the array: deck draws in array order, so these render
 *      beneath the hazard, the network and the trips. They are background.
 *      Inside that array the two rasters go lowest of all — they are ground,
 *      and everything else is drawn on top of ground.
 *
 *   2. Tooltip chaining, wherever `deckTooltip` is passed to the overlay:
 *
 *        getTooltip: (info) => deckTooltip(info) ?? contextTooltip(info)
 *
 *      Datums here are tagged `_ck`, not `_k`, so deckTooltip's switch falls
 *      through to its default and returns null rather than mismatching.
 *
 *   3. src/components/rail/layers-section.tsx (or the rail body):
 *
 *        <ContextLayerToggles />
 *
 *      It renders nothing at all when context/index.json is absent, so it is
 *      safe to mount unconditionally.
 *
 * ── WHAT EACH LAYER IS DRAWN AS, AND WHY ────────────────────────────────────
 *
 * Every layer is rendered in the form its data actually supports. That is the
 * whole rule, and it is why they do not all look alike:
 *
 *   aerosol      1 km satellite RASTER. It is a gridded field, so it is drawn
 *                as a gridded field, nearest-neighbour, blocky on purpose.
 *   slope        a DEM, so also a raster. Drawing 1,600 markers was the reason
 *                terrain read as noise instead of as ground.
 *   svi          census tracts, so a classed CHOROPLETH on CDC's own percentile
 *                quintiles — not eleven arbitrary shades of one ramp.
 *   smoke        analyst polygons, graduated by the analyst's density call.
 *   fireWeather  warning polygons, graduated by VTEC significance.
 *   burnScars    perimeters, graduated by recency, stroke-dominant.
 *   transmission lines, weighted by nominal voltage.
 *   airQuality   POINTS, and deliberately nothing more. See below.
 *
 * ── THE ONE LAYER THAT IS NOT A SURFACE, AND WHY THAT IS THE POINT ──────────
 *
 * There is no interpolated PM2.5 field in this file and there must never be
 * one. The Camp Fire monitor network reads like this: the monitor 671 m from
 * the scenario centre published 3, 4 and 2 ug/m3 and then went dark at T+2h;
 * the other Paradise monitor published nothing all day; the window's highest
 * value, 63 ug/m3, was measured 48 km away at Gridley. Fitting a smooth surface
 * to that paints confident clean air over a burning town.
 *
 * So the network layer draws what a network can honestly say — value, dropout,
 * and the 4 km EPA neighbourhood scale each working instrument represents — and
 * the actual concentration-shaped field comes from an instrument that images
 * the whole scene at once: MODIS MAIAC aerosol optical depth.
 *
 * AOD IS NOT PM2.5. It is unitless extinction through the entire atmospheric
 * column, sampled about twice a day, and no conversion to surface concentration
 * is applied anywhere in this console. It gets its own hue, its own legend, its
 * own units string, and its own tooltip line saying so. Do not "improve" this
 * by tinting it like the PM2.5 ramp.
 *
 * And the satellite has a hole too: MAIAC returned NO RETRIEVAL directly over
 * Paradise on 2018-11-08. Those cells render as a visible neutral stipple, not
 * as transparency, because a gap that reads as clean air is the most dangerous
 * mark this console could make. Two independent instruments, both blind over
 * the same town, on the same morning — that is a finding, and the map states it
 * rather than smoothing it away.
 *
 * ── TWO PATCHES THIS FILE CANNOT APPLY ITSELF ───────────────────────────────
 *
 * 1. src/types/egress.ts + the store's default LayerVisibility, both owned
 *    elsewhere. The aerosol field currently rides `layers.airQuality` because
 *    LayerVisibility has no key for it. To give it its own switch:
 *
 *      // src/types/egress.ts, in LayerVisibility, beside airQuality:
 *      aerosol: boolean;
 *      // and `aerosol: false` wherever the default LayerVisibility is built.
 *
 *    Then change LAYER_META.aerosol.key to "aerosol", drop the `companion`
 *    flag in ContextLayerToggles, and gate the aerosol block on
 *    `layers.aerosol`. Nothing else moves.
 *
 * 2. src/components/map/key-modal.tsx restates these ramps as its own local
 *    constants — its comment says so. It should import CONTEXT_LEGEND from this
 *    file instead, which now carries every stop, break and unit the map is
 *    actually drawn with. Until it does, its Context group is stale: the SVI
 *    ramp is now classed, slope has fixed degree breaks, smoke and fire-weather
 *    are graduated, and the aerosol and monitor-state entries are missing.
 *
 * ── COLOUR: what the ramps are and why these hues ───────────────────────────
 *
 * The existing palette is categorical and spoken for: hazard ember (~18deg),
 * plan cyan (~188deg), warn amber (~40deg), cleared green (~150deg), held grey.
 * These layers introduce CONTINUOUS scales, so they need hues that cannot be
 * misread as any of those, and that hold against both the Esri satellite
 * basemap (green canopy, brown ridge, grey town) and the Carto dark basemap.
 *
 * Two families, split by what the layer IS:
 *
 *   ACHROMATIC — physical context. Smoke, terrain slope, transmission lines.
 *   These describe the world the evacuation happened in, so they take no
 *   chroma at all and never compete for attention. They are separated from
 *   each other by MARK, not hue: smoke is a large diffuse polygon at very low
 *   alpha, slope is a fine regular grid, transmission is a thin line. Warm
 *   grey for the atmosphere, cool grey for the ground, pale steel for steel.
 *
 *   CHROMATIC SEQUENTIAL — human exposure. One hue per layer, each chosen
 *   from the part of the wheel the categorical set does not occupy:
 *     · PM2.5      deep plum -> magenta -> pale pink (~290-330deg). Magenta is
 *                  the complement of the satellite's dominant green, which is
 *                  the strongest separation available on that basemap, and it
 *                  reads as "not fire" at a glance.
 *     · SVI        navy -> periwinkle (~230deg), a single-hue LIGHTNESS ramp.
 *                  Low chroma on the fill, higher on the stroke, so a large
 *                  filled tract stays quiet under everything drawn on top.
 *     · FRP        blackbody: deep red -> orange -> white. The one deliberate
 *                  overlap with ember, because FRP literally is fire intensity
 *                  and any other hue would be a lie. It stays distinguishable
 *                  because the hazard perimeter is a flat translucent wash and
 *                  this is a small white-hot core — different mark, different
 *                  luminance, no ambiguity.
 *
 * Two layers reuse existing semantics on purpose rather than inventing a hue:
 *   · Burn scars use a DESATURATED ember, stroke-only and faded by age. Old
 *     fire should look like old fire, and stroke-only guarantees it can never
 *     be confused with the filled live perimeter.
 *   · Fire weather advisories use warn amber. An NWS warning is a warning;
 *     that is exactly what amber already means in this console.
 *
 * ── TIME ────────────────────────────────────────────────────────────────────
 *
 * Time-varying layers step, they do not interpolate. An hourly monitor mean, a
 * satellite analysis window and a warning validity period are all intervals,
 * and a value invented between two of them is not a measurement. Air quality
 * uses the same last-at-or-before lookup as `hazardFrameAt`; smoke, advisories
 * and detections use interval membership.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Loading. Deliberately separate from lib/data.ts: the core bundle is required
// and throws when it is missing, this one is entirely optional and never does.
// ─────────────────────────────────────────────────────────────────────────────

const contextCache = new Map<string, ContextBundle | null>();
const contextInflight = new Map<string, Promise<ContextBundle | null>>();

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Returns null when the scenario has no context/ directory at all. Individual
 * payloads that fail stay null on the bundle and disable exactly one toggle.
 */
export async function loadContextBundle(scenarioId: string): Promise<ContextBundle | null> {
  if (contextCache.has(scenarioId)) return contextCache.get(scenarioId) ?? null;
  const pending = contextInflight.get(scenarioId);
  if (pending) return pending;

  const p = (async (): Promise<ContextBundle | null> => {
    const base = `/data/${scenarioId}/context`;
    const manifest = await getJson<ContextManifest>(`${base}/index.json`);
    if (!manifest || !Array.isArray(manifest.layers)) return null;

    const wanted = manifest.layers.filter((l) => l.available && l.file);
    const loaded = await Promise.all(
      wanted.map(async (l) => [l.id, await getJson<unknown>(`${base}/${l.file}`)] as const),
    );
    const byId = new Map(loaded);

    // A payload the manifest promised but that will not parse is downgraded
    // here rather than left as a toggle that silently draws nothing.
    const layers = manifest.layers.map((l) =>
      l.available && !byId.get(l.id)
        ? { ...l, available: false, reason: `${l.file} did not load` }
        : l,
    );

    const pick = <T,>(id: ContextLayerId): T | null => (byId.get(id) as T | undefined) ?? null;
    return {
      manifest: { ...manifest, layers },
      airQuality: pick("airQuality"),
      aerosol: pick("aerosol"),
      fireIntensity: pick("fireIntensity"),
      smoke: pick("smoke"),
      transmission: pick("transmission"),
      socialVulnerability: pick("socialVulnerability"),
      fireWeather: pick("fireWeather"),
      slope: pick("slope"),
      burnScars: pick("burnScars"),
    };
  })()
    .then((b) => {
      contextCache.set(scenarioId, b);
      return b;
    })
    .finally(() => contextInflight.delete(scenarioId));

  contextInflight.set(scenarioId, p);
  return p;
}

/** Synchronous cache read, so a remount does not flash empty. */
export function peekContextBundle(scenarioId: string): ContextBundle | null {
  return contextCache.get(scenarioId) ?? null;
}

export function useContextBundle(scenarioId: string): ContextBundle | null {
  const [bundle, setBundle] = useState<ContextBundle | null>(() => peekContextBundle(scenarioId));

  useEffect(() => {
    let live = true;
    const cached = peekContextBundle(scenarioId);
    if (cached) {
      setBundle(cached);
      return;
    }
    setBundle(null);
    loadContextBundle(scenarioId).then((b) => {
      if (live) setBundle(b);
    });
    return () => {
      live = false;
    };
  }, [scenarioId]);

  return bundle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ramps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PM2.5, micrograms per cubic metre. Stops sit on the US AQI category
 * breakpoints (12 / 35 / 55 / 150 / 250) so the banding means something, but
 * the hues are the plum-to-pink family rather than the EPA green-yellow-red —
 * EPA's scale would collide head-on with hazard ember and warn amber.
 */
const PM25_STOPS: { at: number; rgb: Rgb }[] = [
  { at: 0, rgb: [74, 46, 96] },
  { at: 12, rgb: [124, 54, 148] },
  { at: 35, rgb: [176, 62, 174] },
  { at: 55, rgb: [222, 78, 168] },
  { at: 150, rgb: [246, 132, 190] },
  { at: 250, rgb: [255, 206, 228] },
];

/**
 * Aerosol optical depth — the satellite smoke column.
 *
 * A THIRD hue was needed and the wheel is nearly spent: ember ~18deg, warn
 * amber ~40, cleared green ~150, plan cyan ~188, SVI navy ~230, PM2.5 magenta
 * ~300. Violet at ~268 is the one gap left between SVI and PM2.5, so that is
 * where AOD goes.
 *
 * Hue alone is not enough separation from its two neighbours, so all three are
 * separated by MARK as well, which is the rule the rest of this file already
 * follows: AOD is a large blocky raster, SVI is a stepped choropleth with hard
 * tract edges, PM2.5 is small hard circles. Three different objects, three
 * different luminance behaviours, three legends.
 *
 * It is deliberately NOT the PM2.5 ramp. AOD is column extinction and PM2.5 is
 * a surface concentration; colouring them alike would imply a conversion this
 * console does not perform and cannot justify.
 */
const AOD_STOPS: { at: number; rgb: Rgb }[] = [
  { at: 0, rgb: [38, 30, 66] },
  { at: 0.1, rgb: [72, 48, 128] },
  { at: 0.3, rgb: [116, 78, 190] },
  { at: 0.6, rgb: [162, 124, 226] },
  { at: 1.2, rgb: [204, 178, 244] },
  { at: 2.5, rgb: [238, 226, 252] },
];

/** Class breaks the legend states. Chosen on the AOD scale itself, not on a
 *  PM2.5 category table — there is no equivalence between the two. */
const AOD_BREAKS = [0.1, 0.3, 0.6, 1.2, 2.5];

/** Cells where the retrieval returned nothing. Neutral, stippled, and never
 *  confusable with a low value. See context-raster.ts. */
const NO_RETRIEVAL_RGB: Rgb = [138, 144, 158];

/**
 * Social vulnerability, 0..1. Single hue, lightness only, and CLASSED rather
 * than continuous: eleven tracts on a smooth ramp read as eleven arbitrary
 * shades, where five named percentile bands read as a choropleth an operator
 * can actually match back to a legend.
 */
const SVI_LOW: Rgb = [46, 58, 106];
const SVI_HIGH: Rgb = [148, 168, 244];

/** CDC publishes SVI as a percentile rank, so the classes are percentile
 *  quintiles. Camp Fire tracts span 0.29-0.66 and therefore occupy only the
 *  middle three — which is a fact about Butte County, not a bug to be
 *  stretched away by fitting the ramp to the observed range. */
const SVI_BREAKS = [0.2, 0.4, 0.6, 0.8];
const SVI_CLASS_ALPHA = [58, 78, 100, 124, 148];

/** Fire radiative power. Blackbody, dark red through to white-hot. */
const FRP_RAMP: Rgb[] = [
  [104, 18, 12],
  [186, 52, 16],
  [238, 128, 26],
  [252, 202, 104],
  [255, 250, 232],
];

/** Smoke: warm achromatic, brighter with analyst density. */
const SMOKE_RGB: Record<SmokePlume["density"], Rgb> = {
  light: [188, 184, 176],
  medium: [214, 210, 202],
  heavy: [240, 238, 231],
};
/** Graduated by the analyst's own three-level density call. Raised from the
 *  first pass: at the old ceiling a HEAVY plume and a LIGHT one were within a
 *  few percent of each other on screen, which threw away the only magnitude
 *  this product carries. */
const SMOKE_ALPHA: Record<SmokePlume["density"], number> = { light: 30, medium: 62, heavy: 104 };
/** Density is also encoded in edge weight, so the three levels stay separable
 *  for anyone who cannot resolve the fill difference. */
const SMOKE_WIDTH: Record<SmokePlume["density"], number> = { light: 0.7, medium: 1.3, heavy: 2.1 };

/** Terrain: cool achromatic. Flat ground fades to nothing. */
const SLOPE_LOW: Rgb = [92, 108, 130];
const SLOPE_HIGH: Rgb = [206, 220, 240];
/** Degrees at which the slope ramp saturates. Fire behaviour changes character
 *  well before this; above it the map is uniformly "steep" and says so. */
const SLOPE_REF_DEG = 28;
/** Standard slope classes, degrees. Fixed rather than fitted to the scenario's
 *  own maximum, so the same colour means the same gradient in every town. */
const SLOPE_BREAKS = [5, 10, 15, 20, 25];
/** Full domain the raster encodes. Above this the ramp is flat by design. */
const SLOPE_MAX_DEG = 30;

/** Infrastructure: pale steel, brightened slightly with voltage class. */
const TRANSMISSION_RGB: Rgb = [172, 184, 202];

/** Deliberately reuses the ember family, desaturated. See the header note. */
const BURN_SCAR_RGB: Rgb = [154, 96, 70];

/** Deliberately reuses warn amber. An NWS warning is a warning. */
const ADVISORY_RGB: Rgb = [224, 169, 68];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const mix = (a: Rgb, b: Rgb, f: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * f),
  Math.round(a[1] + (b[1] - a[1]) * f),
  Math.round(a[2] + (b[2] - a[2]) * f),
];

const rgba = (c: Rgb, alpha: number): Color => [c[0], c[1], c[2], alpha];

/** Piecewise-linear lookup across irregularly spaced stops. */
function pm25Color(v: number): Rgb {
  if (!Number.isFinite(v) || v <= 0) return PM25_STOPS[0].rgb;
  for (let i = 0; i < PM25_STOPS.length - 1; i++) {
    const a = PM25_STOPS[i];
    const b = PM25_STOPS[i + 1];
    if (v <= b.at) return mix(a.rgb, b.rgb, (v - a.at) / (b.at - a.at));
  }
  return PM25_STOPS[PM25_STOPS.length - 1].rgb;
}

function frpColor(frp: number, max: number): Rgb {
  // Log scale: FRP spans three orders of magnitude across a single fire, and a
  // linear ramp puts every detection but the largest at the dark end.
  const f = clamp(Math.log10(Math.max(1, frp)) / Math.log10(Math.max(10, max)), 0, 1);
  const last = FRP_RAMP.length - 1;
  const i = Math.min(last - 1, Math.floor(f * last));
  return mix(FRP_RAMP[i], FRP_RAMP[i + 1], clamp(f * last - i, 0, 1));
}

const sviColor = (rank: number): Rgb => mix(SVI_LOW, SVI_HIGH, clamp(rank, 0, 1));

/** Which percentile quintile a rank falls in, 0..4. */
function sviClassOf(rank: number): number {
  for (let i = 0; i < SVI_BREAKS.length; i++) if (rank < SVI_BREAKS[i]) return i;
  return SVI_BREAKS.length;
}

/** Colour of a class, sampled at the class midpoint of the single-hue ramp. */
const sviClassColor = (cls: number): Rgb => mix(SVI_LOW, SVI_HIGH, (cls + 0.5) / 5);

const slopeColor = (deg: number): Rgb =>
  mix(SLOPE_LOW, SLOPE_HIGH, clamp(deg / SLOPE_REF_DEG, 0, 1));

/** Piecewise-linear across the AOD stops. Same shape as pm25Color, different
 *  quantity — see AOD_STOPS for why they must not share a ramp. */
function aodColor(v: number): Rgb {
  if (!Number.isFinite(v) || v <= 0) return AOD_STOPS[0].rgb;
  for (let i = 0; i < AOD_STOPS.length - 1; i++) {
    const a = AOD_STOPS[i];
    const b = AOD_STOPS[i + 1];
    if (v <= b.at) return mix(a.rgb, b.rgb, (v - a.at) / (b.at - a.at));
  }
  return AOD_STOPS[AOD_STOPS.length - 1].rgb;
}

/** CSS form of a ramp, for the rail swatches — the rail doubles as the legend. */
function cssRamp(stops: Rgb[]): string {
  const step = 100 / stops.length;
  return `linear-gradient(90deg, ${stops
    .map((c, i) => `rgb(${c[0]} ${c[1]} ${c[2]}) ${i * step}% ${(i + 1) * step}%`)
    .join(", ")})`;
}

const cssRgb = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

// ─────────────────────────────────────────────────────────────────────────────
// Gridded fields. Both are static for a scenario, so each is rasterised once
// per payload and held on a WeakMap keyed by that payload — the scrubber never
// touches them and deck re-uploads nothing while they are on screen.
// ─────────────────────────────────────────────────────────────────────────────

interface FieldRaster {
  image: HTMLCanvasElement;
  bounds: [number, number, number, number];
}

const fieldCache = new WeakMap<object, FieldRaster | null>();

function memoField(owner: object, make: () => FieldRaster | null): FieldRaster | null {
  if (fieldCache.has(owner)) return fieldCache.get(owner) ?? null;
  const v = make();
  fieldCache.set(owner, v);
  return v;
}

/**
 * Alpha curve for the AOD field, defined on AOD itself rather than on the
 * normalised byte.
 *
 * Background aerosol over Northern California that morning sat around 0.08 and
 * covers most of the grid; the plume reaches 3.9. A curve with any meaningful
 * floor therefore paints a flat violet wash over the entire scene and hides the
 * only thing worth seeing. So the ramp is anchored so that ordinary background
 * air is barely present and the column load carries the visual weight, holding
 * short of opaque because this is still context under the argument.
 */
const AOD_FULL_ALPHA_AT = 1.5;
const aodAlpha = (aod: number) => 0.86 * clamp(aod / AOD_FULL_ALPHA_AT, 0, 1) ** 0.75;

function aerosolRaster(aod: AerosolPayload): FieldRaster | null {
  const cells = decodeGrid(aod.grid);
  const image = rasteriseGrid(cells, aod.width, aod.height, {
    // The byte encodes AOD/scaleMax, so t is already normalised against the
    // payload's own ceiling; the ramp is defined in AOD units.
    ramp: (t) => aodColor(t * aod.scaleMax),
    alpha: (t) => aodAlpha(t * aod.scaleMax),
    missingRgb: NO_RETRIEVAL_RGB,
    missingAlpha: 0.62,
  });
  return image ? { image, bounds: aod.bbox } : null;
}

/**
 * The DEM grid as a raster. The payload is a cell LIST, so the grid indices are
 * rebuilt from the cell centres rather than from array order — an upstream that
 * reorders its response would otherwise transpose the terrain silently.
 */
function slopeRaster(slope: SlopePayload): FieldRaster | null {
  const cells = slope.cells;
  if (cells.length === 0) return null;
  const [dx, dy] = slope.cellDeg;

  // Indices come from the RANK of each distinct coordinate, not from
  // (position - origin) / cellDeg. The payload stores centres rounded to four
  // decimals, so the arithmetic route rounds two neighbouring columns onto the
  // same index and leaves the next one empty — which renders as transparent
  // vertical stripes through the terrain. Ranking is exact for a regular grid
  // however the coordinates were rounded.
  const lngs = [...new Set(cells.map((c) => c.position[0]))].sort((a, b) => a - b);
  const lats = [...new Set(cells.map((c) => c.position[1]))].sort((a, b) => a - b);
  const colOf = new Map(lngs.map((v, i) => [v, i]));
  const rowOf = new Map(lats.map((v, i) => [v, i]));

  const width = lngs.length;
  const height = lats.length;
  const west = lngs[0];
  const east = lngs[width - 1];
  const south = lats[0];
  const north = lats[height - 1];
  const grid = new Uint8Array(width * height).fill(MISSING);

  for (const c of cells) {
    const col = colOf.get(c.position[0]);
    const rank = rowOf.get(c.position[1]);
    if (col === undefined || rank === undefined) continue;
    // Row 0 is NORTH: the grid feeds a texture, and a texture's first row is
    // its top edge, so the latitude rank is flipped.
    const row = height - 1 - rank;
    grid[row * width + col] = Math.max(
      0,
      Math.min(254, Math.round((clamp(c.slope, 0, SLOPE_MAX_DEG) / SLOPE_MAX_DEG) * 254)),
    );
  }

  const image = rasteriseGrid(grid, width, height, {
    ramp: (t) => slopeColor(t * SLOPE_MAX_DEG),
    // Flat ground is a measurement too, but it is also most of the valley
    // floor, so it fades almost out rather than greying the basemap.
    alpha: (t) => 0.04 + 0.66 * t ** 0.85,
    missingRgb: null,
  });
  return image
    ? { image, bounds: [west - dx / 2, south - dy / 2, east + dx / 2, north + dy / 2] }
    : null;
}

/**
 * Grids kept addressable by layer id so the tooltip can answer "what is the
 * value under the cursor" for a raster, which carries no per-feature datum.
 */
interface FieldProbe {
  cells: Uint8Array;
  width: number;
  height: number;
  /** Byte -> physical value. */
  decode: (b: number) => number;
  unit: string;
  title: string;
  sub: string;
  /** What to say when the cell carries no measurement. */
  missingLabel: string;
}

const fieldProbes = new Map<string, FieldProbe>();

// ─────────────────────────────────────────────────────────────────────────────
// Time lookup
// ─────────────────────────────────────────────────────────────────────────────

/** Last index with t <= target, clamped to 0. Mirrors derive.lastAtOrBefore;
 *  duplicated rather than imported because that one is module-private. */
function lastAtOrBefore(arr: readonly { t: Tick }[], t: Tick): number {
  let lo = 0;
  let hi = arr.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * The hourly observation row in force at `t`. Step, never interpolated: each
 * value is an hourly mean, and a number between two means was measured by
 * nothing.
 */
export function airQualityFrameAt(
  aq: AirQualityPayload | null,
  t: Tick,
): { t: Tick; values: (number | null)[] } | null {
  if (!aq || aq.frames.length === 0) return null;
  return aq.frames[lastAtOrBefore(aq.frames, t)];
}

/** Plumes whose satellite analysis window contains `t`. */
export function smokePlumesAt(plumes: SmokePlume[], t: Tick): SmokePlume[] {
  return plumes.filter((p) => p.startT <= t && p.endT >= t);
}

/** Advisories in force at `t`. */
export function advisoriesAt(list: FireWeatherAdvisory[], t: Tick): FireWeatherAdvisory[] {
  return list.filter((a) => a.startT <= t && a.endT >= t);
}

/**
 * Detections within one overpass window of `t`. FRP is instantaneous: a
 * detection is a fact about one moment, so it is shown around that moment and
 * nowhere else rather than persisting across the run.
 */
const OVERPASS_WINDOW = 1800;

/** Cadence at which smoke membership is re-derived. Matches the simulation
 *  frame step, so a plume is never more than one bucket late appearing. */
const SMOKE_BUCKET = 300;

export function detectionsAt(list: FireDetection[], t: Tick): FireDetection[] {
  return list.filter((d) => Math.abs(d.t - t) <= OVERPASS_WINDOW);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-bundle memo. Keyed on the stepped bucket a datum set belongs to, never on
// raw `t` — the scrubber writes up to 30x a second and deck skips the attribute
// upload entirely when it sees the same array reference.
// ─────────────────────────────────────────────────────────────────────────────

const slots = new WeakMap<object, Map<string, { key: string; value: unknown }>>();

function cached<T>(owner: object, slot: string, key: string, make: () => T): T {
  let bag = slots.get(owner);
  if (!bag) {
    bag = new Map();
    slots.set(owner, bag);
  }
  const hit = bag.get(slot);
  if (hit && hit.key === key) return hit.value as T;
  const value = make();
  bag.set(slot, { key, value });
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Datums. Tagged `_ck` so they can share a Deck instance with deck-layers.tsx
// without either tooltip handler claiming the other's objects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three states, not two, and the third is the whole point.
 *
 *   live  — publishing a value this hour.
 *   dark  — this monitor DID publish earlier in the window and has stopped.
 *   never — published nothing at any hour of the event.
 *
 * "dark" and "never" are the same on a `reporting` flag alone and completely
 * different on the ground. Paradise had one of each, 2 m apart: Birch Street
 * never published, and Paradise Theater published 3, 4 and 2 ug/m3 at T-1h,
 * T+0 and T+1h and then went dark for the rest of the evacuation. Collapsing
 * those into one grey ring erases the only instrument that was working when
 * the fire arrived, and the moment it stopped.
 */
type MonitorState = "live" | "dark" | "never";

interface AirDatum {
  _ck: "air";
  station: AirQualityStation;
  /** Reading at the current hour. null when the monitor is silent. */
  value: number | null;
  state: MonitorState;
  /** Last tick this monitor published, or null if it never did. */
  lastT: Tick | null;
}
interface SmokeDatum {
  _ck: "smoke";
  plume: SmokePlume;
  ring: LngLat[];
}
interface SlopeDatum {
  _ck: "slope";
  cell: SlopeCell;
  ring: LngLat[];
}
interface TransmissionDatum {
  _ck: "transmission";
  line: TransmissionLine;
}
interface SviDatum {
  _ck: "svi";
  tract: SviTract;
  ring: LngLat[];
}
interface AdvisoryDatum {
  _ck: "advisory";
  advisory: FireWeatherAdvisory;
  ring: LngLat[];
}
interface BurnDatum {
  _ck: "burn";
  scar: BurnScar;
  ring: LngLat[];
}
interface DetectionDatum {
  _ck: "detection";
  detection: FireDetection;
  max: number;
}

type ContextDatum =
  | AirDatum
  | SmokeDatum
  | SlopeDatum
  | TransmissionDatum
  | SviDatum
  | AdvisoryDatum
  | BurnDatum
  | DetectionDatum;

// ─────────────────────────────────────────────────────────────────────────────
// buildContextLayers
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildContextLayersArgs {
  /** Null before the payloads land, or forever if the scenario has none. */
  context: ContextBundle | null;
  t: Tick;
  layers: LayerVisibility;
  /** Split view renders two stacks; ids must not collide between them. */
  idPrefix?: string;
  /** Split panes switch picking off on the pane that is not focused. */
  interactive?: boolean;
}

export function buildContextLayers(args: BuildContextLayersArgs): Layer[] {
  const { context, t, layers } = args;
  if (!context) return [];
  const prefix = `${args.idPrefix ? `${args.idPrefix}-` : ""}ctx-`;
  const pick = args.interactive !== false;
  const owner = context as object;
  const out: Layer[] = [];

  // ── aerosol optical depth ─────────────────────────────────────────────────
  // The lowest thing on the map: a 1 km satellite raster of the smoke column.
  //
  // It rides the airQuality toggle rather than carrying its own, because a
  // separate switch would need a new key on LayerVisibility and that type is
  // owned by another workflow. That is also the better default — an operator
  // asking for air quality wants the field AND the instruments that measured
  // it, not one without the other. See the header note for the two-line patch
  // that splits them.
  if (layers.aerosol && context.aerosol) {
    const aod = context.aerosol;
    const field = memoField(aod, () => aerosolRaster(aod));
    if (field) {
      const id = `${prefix}aerosol-field`;
      fieldProbes.set(id, {
        cells: decodeGrid(aod.grid),
        width: aod.width,
        height: aod.height,
        decode: (b) => (b / 254) * aod.scaleMax,
        unit: "AOD",
        title: "Smoke column",
        sub: `MODIS MAIAC 1 km · ${aod.observedDate}`,
        // Never "0", never "clean". The retrieval failed here and saying so is
        // the entire reason this layer draws its holes.
        missingLabel: "NO RETRIEVAL",
      });
      out.push(
        new BitmapLayer({
          id,
          image: field.image,
          bounds: field.bounds,
          pickable: pick,
          // Nearest, not bilinear: a 1 km cell has an edge and smoothing it
          // would make a coarse product look precise. See context-raster.ts.
          textureParameters: NEAREST,
        }),
      );
    }
  }

  // ── smoke ─────────────────────────────────────────────────────────────────
  // Drawn first and lowest: it is a veil over everything, not a thing on the
  // map. One polygon per ring so an analyst's multi-part plume keeps its shape.
  if (layers.smoke && context.smoke) {
    const plumes = context.smoke.plumes;
    // Bucketed, not keyed on raw `t`: the scrubber writes t up to 30x a second
    // and analyst smoke windows are hours wide, so re-deriving per tick would
    // hand deck a fresh array — and a fresh attribute upload — for nothing.
    const bucket = Math.floor(t / SMOKE_BUCKET);
    const data = cached<SmokeDatum[]>(owner, "smoke", String(bucket), () =>
      smokePlumesAt(plumes, t).flatMap((plume) =>
        plume.rings.map<SmokeDatum>((ring) => ({ _ck: "smoke", plume, ring })),
      ),
    );
    if (data.length > 0) {
      out.push(
        new PolygonLayer<SmokeDatum>({
          id: `${prefix}smoke`,
          data,
          pickable: pick,
          filled: true,
          stroked: true,
          extruded: false,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 0.6,
          getPolygon: getSmokeRing,
          getFillColor: (d) => rgba(SMOKE_RGB[d.plume.density], SMOKE_ALPHA[d.plume.density]),
          getLineColor: (d) => rgba(SMOKE_RGB[d.plume.density], SMOKE_ALPHA[d.plume.density] + 70),
          getLineWidth: (d) => SMOKE_WIDTH[d.plume.density],
          updateTriggers: {
            getFillColor: [bucket],
            getLineColor: [bucket],
            getLineWidth: [bucket],
          },
        }),
      );
    }
  }

  // ── terrain slope ─────────────────────────────────────────────────────────
  if (layers.slope && context.slope) {
    const slope = context.slope;
    const data = cached<SlopeDatum[]>(owner, "slope", "static", () => {
      const [dx, dy] = slope.cellDeg;
      return (
        slope.cells
          // Below 5 degrees the ground is effectively flat for fire spread, and
          // drawing it only greys out the basemap.
          .filter((cell) => cell.slope >= 5)
          .map<SlopeDatum>((cell) => {
            const [x, y] = cell.position;
            return {
              _ck: "slope",
              cell,
              ring: [
                [x - dx / 2, y - dy / 2],
                [x + dx / 2, y - dy / 2],
                [x + dx / 2, y + dy / 2],
                [x - dx / 2, y + dy / 2],
              ],
            };
          })
      );
    });
    // The visual is a raster, not 1,600 polygons: this is a DEM, and a DEM is
    // a raster. Drawing it as markers was the reason it read as noise.
    const field = memoField(slope, () => slopeRaster(slope));
    if (field) {
      const id = `${prefix}slope-field`;
      fieldProbes.set(id, {
        cells: new Uint8Array(0),
        width: 0,
        height: 0,
        decode: (b) => b,
        unit: "deg",
        title: "Terrain slope",
        sub: slope.source,
        missingLabel: "no cell",
      });
      out.push(
        new BitmapLayer({
          id,
          image: field.image,
          bounds: field.bounds,
          // Picking is carried by the cell polygons below, which hold the real
          // per-cell datum the inspector resolves against.
          pickable: false,
          textureParameters: NEAREST,
        }),
      );
    }
    // Invisible, but still picked: deck's picking pass renders geometry
    // independently of fill colour, so this keeps the per-cell tooltip and the
    // `slope:<key>` inspector selection working over the raster.
    if (data.length > 0) {
      out.push(
        new PolygonLayer<SlopeDatum>({
          id: `${prefix}slope`,
          data,
          pickable: pick,
          filled: true,
          stroked: false,
          extruded: false,
          getPolygon: getSlopeRing,
          getFillColor: SLOPE_PICK_ONLY,
        }),
      );
    }
  }

  // ── burn scars ────────────────────────────────────────────────────────────
  // Stroke only. A filled ember polygon is the live hazard's mark, and the one
  // collision the palette could not survive is old fire reading as new fire.
  if (layers.burnScars && context.burnScars) {
    const scars = context.burnScars.scars;
    const newest = context.burnScars.yearRange[1];
    const oldest = context.burnScars.yearRange[0];
    const data = cached<BurnDatum[]>(owner, "burn", "static", () =>
      scars.flatMap((scar) => scar.rings.map<BurnDatum>((ring) => ({ _ck: "burn", scar, ring }))),
    );
    const span = Math.max(1, newest - oldest);
    out.push(
      new PolygonLayer<BurnDatum>({
        id: `${prefix}burn-scars`,
        data,
        pickable: pick,
        filled: true,
        stroked: true,
        extruded: false,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0.7,
        getPolygon: getBurnRing,
        getLineColor: (d) => {
          // Recent scars are the ones that changed the fuel the fire met, so
          // they read strongest and a 1900 burn is nearly gone.
          const recency = clamp((d.scar.year - oldest) / span, 0, 1);
          return rgba(BURN_SCAR_RGB, Math.round(48 + recency * 140));
        },
        // A faint recency-graduated fill was added because 112 overlapping
        // stroke-only perimeters read as spaghetti rather than as fuel history.
        // The ceiling is held very low and the hue stays desaturated: this must
        // remain incapable of being mistaken for the live hazard wash, which is
        // the one collision the palette cannot survive.
        getFillColor: (d) => {
          const recency = clamp((d.scar.year - oldest) / span, 0, 1);
          return rgba(BURN_SCAR_RGB, Math.round(6 + recency * 28));
        },
        getLineWidth: 1,
        updateTriggers: { getLineColor: [oldest, span], getFillColor: [oldest, span] },
      }),
    );
  }

  // ── transmission ──────────────────────────────────────────────────────────
  if (layers.transmission && context.transmission) {
    const lines = context.transmission.lines;
    const data = cached<TransmissionDatum[]>(owner, "transmission", "static", () =>
      lines.map<TransmissionDatum>((line) => ({ _ck: "transmission", line })),
    );
    out.push(
      new PathLayer<TransmissionDatum>({
        id: `${prefix}transmission`,
        data,
        pickable: pick,
        widthUnits: "pixels",
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        getPath: getTransmissionPath,
        getColor: getTransmissionColor,
        // Voltage is ordinal, so it is encoded by WIDTH. The hue stays fixed:
        // this is infrastructure, and the palette's chroma is spent on people.
        getWidth: getTransmissionWidth,
      }),
    );
  }

  // ── social vulnerability ──────────────────────────────────────────────────
  if (layers.socialVulnerability && context.socialVulnerability) {
    const tracts = context.socialVulnerability.tracts;
    const data = cached<SviDatum[]>(owner, "svi", "static", () =>
      tracts.flatMap((tract) =>
        tract.geometry.map<SviDatum>((ring) => ({ _ck: "svi", tract, ring })),
      ),
    );
    out.push(
      new PolygonLayer<SviDatum>({
        id: `${prefix}svi`,
        data,
        pickable: pick,
        filled: true,
        stroked: true,
        extruded: false,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0.8,
        getPolygon: getSviRing,
        getFillColor: getSviFill,
        getLineColor: getSviLine,
        getLineWidth: 1.4,
      }),
    );
  }

  // ── fire weather advisories ───────────────────────────────────────────────
  // Only LIVE alerts carry geometry. Archive products are real and timestamped
  // but their UGC zones were retired, so they surface in the rail as a band
  // rather than as an invented footprint on the map.
  if (layers.fireWeather && context.fireWeather) {
    const live = context.fireWeather.live;
    const data = cached<AdvisoryDatum[]>(owner, "advisory", "live", () =>
      live.flatMap((advisory) =>
        (advisory.rings ?? []).map<AdvisoryDatum>((ring) => ({ _ck: "advisory", advisory, ring })),
      ),
    );
    if (data.length > 0) {
      out.push(
        new PolygonLayer<AdvisoryDatum>({
          id: `${prefix}fire-weather`,
          data,
          pickable: pick,
          filled: true,
          stroked: true,
          extruded: false,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1,
          getPolygon: getAdvisoryRing,
          // Graduated by VTEC significance, which is the magnitude this product
          // actually carries: W warning > A watch > Y advisory. A flat fill made
          // a Red Flag Warning and a Lake Wind Advisory look identical.
          getFillColor: getAdvisoryFill,
          getLineColor: getAdvisoryLine,
          getLineWidth: getAdvisoryWidth,
        }),
      );
    }
  }

  // ── air quality: the monitor network, and where it was blind ─────────
  //
  // Point observations, drawn as points, with NO interpolated concentration
  // surface anywhere in this block — and that is a finding, not a limitation.
  // On the Camp Fire the network reads like this: the monitor 671 m from the
  // scenario centre published 3, 4 and 2 ug/m3 and then went dark at T+2h; the
  // other Paradise monitor published nothing all day; and the highest value in
  // the whole window, 63 ug/m3, was measured 48 km away at Gridley. Fitting a
  // smooth field to that would paint confident clean air over a burning town.
  //
  // So the layer draws three things instead: what each instrument said, which
  // instruments had stopped saying anything, and how much ground a working
  // monitor can honestly speak for.
  if (layers.airQuality && context.airQuality) {
    const aq = context.airQuality;
    const frame = airQualityFrameAt(aq, t);
    const lastSeen = cached<(Tick | null)[]>(owner, "air-last", "static", () =>
      lastReportedTicks(aq),
    );
    const data = cached<AirDatum[]>(owner, "air", String(frame?.t ?? "none"), () =>
      aq.stations.map<AirDatum>((station, i) => {
        const value = frame?.values[i] ?? null;
        return {
          _ck: "air",
          station,
          value,
          state: value !== null ? "live" : station.reporting ? "dark" : "never",
          lastT: lastSeen[i],
        };
      }),
    );
    const frameKey = frame?.t ?? -1;

    out.push(
      // COVERAGE. 4 km is EPA's neighbourhood spatial scale for PM2.5 in
      // 40 CFR 58 Appendix D — the distance over which one monitor is taken to
      // represent the air. Drawn in ground metres, so closing the camera shows
      // how little of the map any instrument actually covers. This circle is
      // DERIVED from the station position; everything else in the layer is
      // measured, and the legend says which is which.
      new ScatterplotLayer<AirDatum>({
        id: `${prefix}air-coverage`,
        data,
        pickable: false,
        filled: false,
        stroked: true,
        radiusUnits: "meters",
        lineWidthUnits: "pixels",
        getPosition: getAirPosition,
        getRadius: (d) => (d.state === "live" ? MONITOR_SCALE_M : 0),
        getLineWidth: 1,
        getLineColor: COVERAGE_LINE,
        updateTriggers: { getRadius: [frameKey] },
      }),
      // NEVER PUBLISHED. Hollow, neutral, small. Not a zero.
      new ScatterplotLayer<AirDatum>({
        id: `${prefix}air-silent`,
        data,
        pickable: pick,
        filled: false,
        stroked: true,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getPosition: getAirPosition,
        getRadius: (d) => (d.state === "never" ? 5.5 : 0),
        getLineWidth: 1.1,
        getLineColor: SILENT_LINE,
        updateTriggers: { getRadius: [frameKey] },
      }),
      // WENT DARK. A monitor that WAS working and has stopped is a different
      // fact from one that never reported, and it is the more alarming of the
      // two — so it takes warn amber and a double ring rather than the same
      // grey circle. Outer ring first.
      new ScatterplotLayer<AirDatum>({
        id: `${prefix}air-dark-halo`,
        data,
        pickable: false,
        filled: false,
        stroked: true,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getPosition: getAirPosition,
        getRadius: (d) => (d.state === "dark" ? 9.5 : 0),
        getLineWidth: 1,
        getLineColor: DARK_HALO,
        updateTriggers: { getRadius: [frameKey] },
      }),
      new ScatterplotLayer<AirDatum>({
        id: `${prefix}air-dark`,
        data,
        pickable: pick,
        filled: false,
        stroked: true,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getPosition: getAirPosition,
        getRadius: (d) => (d.state === "dark" ? 5.5 : 0),
        getLineWidth: 1.7,
        getLineColor: DARK_LINE,
        updateTriggers: { getRadius: [frameKey] },
      }),
      // LIVE. Graduated symbol, sqrt-scaled so a 60 is not twelve times the
      // area of a 5, coloured on the PM2.5 ramp.
      new ScatterplotLayer<AirDatum>({
        id: `${prefix}air-quality`,
        data,
        pickable: pick,
        filled: true,
        stroked: true,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getPosition: getAirPosition,
        getRadius: (d) => (d.value === null ? 0 : 5 + Math.sqrt(Math.max(0, d.value)) * 2.6),
        getFillColor: (d) => (d.value === null ? TRANSPARENT : rgba(pm25Color(d.value), 225)),
        getLineWidth: 1,
        getLineColor: AIR_STROKE,
        updateTriggers: { getRadius: [frameKey], getFillColor: [frameKey] },
      }),
      // The number itself. A graduated symbol gives an operator the ordering;
      // only the digits give them the value, and this console's whole posture is
      // that a number nobody can read is a number nobody can check.
      new TextLayer<AirDatum>({
        id: `${prefix}air-values`,
        data,
        pickable: false,
        characterSet: AQ_CHARSET,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 700,
        sizeUnits: "pixels",
        getPosition: getAirPosition,
        getText: getAirText,
        getSize: (d) => (d.value === null ? 0 : 11),
        getColor: AQ_TEXT,
        getPixelOffset: AQ_TEXT_OFFSET,
        background: true,
        getBackgroundColor: AQ_TEXT_BG,
        backgroundPadding: AQ_TEXT_PAD,
        updateTriggers: { getText: [frameKey], getSize: [frameKey] },
      }),
    );
  }

  // ── fire intensity ────────────────────────────────────────────────────────
  if (layers.fireIntensity && context.fireIntensity) {
    const fi = context.fireIntensity;
    const max = fi.frpRange[1];
    // Bucketed to the overpass window so the membership scan runs once per
    // window rather than once per scrubber tick.
    const bucket = Math.floor(t / OVERPASS_WINDOW);
    const data = cached<DetectionDatum[]>(owner, "detection", String(bucket), () =>
      detectionsAt(fi.detections, t).map<DetectionDatum>((detection) => ({
        _ck: "detection",
        detection,
        max,
      })),
    );
    if (data.length > 0) {
      out.push(
        new ScatterplotLayer<DetectionDatum>({
          id: `${prefix}fire-intensity`,
          data,
          pickable: pick,
          filled: true,
          stroked: false,
          radiusUnits: "pixels",
          getPosition: getDetectionPosition,
          getRadius: (d) => 3 + Math.sqrt(Math.max(1, d.detection.frp)) * 1.5,
          getFillColor: (d) => rgba(frpColor(d.detection.frp, d.max), 225),
          updateTriggers: { getRadius: [bucket], getFillColor: [bucket, max] },
        }),
      );
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stable accessors. Module-level so deck compares identical function references
// between renders instead of re-evaluating every attribute on every tick.
// ─────────────────────────────────────────────────────────────────────────────

const TRANSPARENT: Color = [0, 0, 0, 0];

const getSmokeRing = (d: SmokeDatum) => d.ring;
const getSlopeRing = (d: SlopeDatum) => d.ring;
/**
 * Alpha 1, not 0. deck's picking pass renders geometry independently of the
 * colour attribute, so 0 would very probably still pick — but "very probably"
 * is not a property to hang the terrain inspector on, and one unit of alpha is
 * invisible against any basemap while being unambiguously drawn.
 */
const SLOPE_PICK_ONLY: Color = [0, 0, 0, 1];
const getBurnRing = (d: BurnDatum) => d.ring;
const getSviRing = (d: SviDatum) => d.ring;
/**
 * Classed, not continuous. Eleven tracts on a smooth ramp are eleven shades
 * nobody can match back to a legend; five percentile bands are a choropleth.
 * Alpha rises with the class as well as hue, because a single-hue ramp read
 * across a satellite basemap needs both to stay separable.
 *
 * A suppressed tract is drawn as an empty outline. It is unknown, not safe, and
 * filling it at the low class would assert the opposite.
 */
const getSviFill = (d: SviDatum): Color => {
  if (d.tract.overall === null) return TRANSPARENT;
  const cls = sviClassOf(d.tract.overall);
  return rgba(sviClassColor(cls), SVI_CLASS_ALPHA[cls]);
};
const getSviLine = (d: SviDatum): Color => {
  if (d.tract.overall === null) return rgba(SVI_LOW, 110);
  const cls = sviClassOf(d.tract.overall);
  return rgba(sviClassColor(Math.min(4, cls + 1)), 205);
};

const getTransmissionPath = (d: TransmissionDatum) => d.line.path;
const getTransmissionWidth = (d: TransmissionDatum) =>
  d.line.voltageKv === null ? 1 : clamp(0.9 + d.line.voltageKv / 190, 1, 4);
const getTransmissionColor = (d: TransmissionDatum): Color =>
  rgba(TRANSMISSION_RGB, d.line.voltageKv === null ? 130 : 210);

const getAdvisoryRing = (d: AdvisoryDatum) => d.ring;

/** VTEC significance is the product's own severity ordering: W warning,
 *  A watch, Y advisory. Anything else falls to the weakest band. */
const ADVISORY_FILL_A: Record<string, number> = { W: 44, A: 30, Y: 20 };
const ADVISORY_LINE_A: Record<string, number> = { W: 230, A: 196, Y: 158 };
const ADVISORY_WIDTH: Record<string, number> = { W: 1.9, A: 1.4, Y: 1 };

const getAdvisoryFill = (d: AdvisoryDatum): Color =>
  rgba(ADVISORY_RGB, ADVISORY_FILL_A[d.advisory.significance] ?? 20);
const getAdvisoryLine = (d: AdvisoryDatum): Color =>
  rgba(ADVISORY_RGB, ADVISORY_LINE_A[d.advisory.significance] ?? 158);
const getAdvisoryWidth = (d: AdvisoryDatum): number => ADVISORY_WIDTH[d.advisory.significance] ?? 1;

const getAirPosition = (d: AirDatum) => d.station.position;
const AIR_STROKE: Color = [10, 12, 16, 190];
const SILENT_LINE: Color = [150, 156, 168, 190];

/**
 * EPA's neighbourhood spatial scale for PM2.5, 40 CFR 58 Appendix D: the
 * distance over which one monitor is treated as representative of the air.
 * The disc is DERIVED geometry, not a measurement, and the legend says so.
 */
const MONITOR_SCALE_M = 4000;
const COVERAGE_LINE: Color = [150, 156, 168, 74];

/** Warn amber. A working instrument that stopped is a warning, and amber is
 *  already exactly what a warning means in this console. */
const DARK_LINE: Color = [224, 169, 68, 225];
const DARK_HALO: Color = [224, 169, 68, 96];

const AQ_CHARSET = "0123456789.".split("");
const AQ_TEXT: Color = [244, 246, 250, 235];
const AQ_TEXT_BG: Color = [10, 12, 16, 170];
const AQ_TEXT_PAD: [number, number, number, number] = [3, 1, 3, 1];
/** Clear of the graduated symbol at its largest, so the digits never sit on
 *  the fill they are describing. */
const AQ_TEXT_OFFSET: [number, number] = [0, -18];
const getAirText = (d: AirDatum) =>
  d.value === null ? "" : Number.isInteger(d.value) ? String(d.value) : d.value.toFixed(1);

/**
 * Last tick each monitor published anything, index-aligned to `stations`.
 * Null for a monitor that never published at all — which is what separates
 * "went dark" from "was never there", the distinction this layer exists to
 * draw.
 */
function lastReportedTicks(aq: AirQualityPayload): (Tick | null)[] {
  return aq.stations.map((_, i) => {
    for (let f = aq.frames.length - 1; f >= 0; f--) {
      if (aq.frames[f].values[i] !== null) return aq.frames[f].t;
    }
    return null;
  });
}

const getDetectionPosition = (d: DetectionDatum) => d.detection.position;

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip. Chain after deckTooltip; returns null for anything not ours.
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
  maxWidth: "270px",
  pointerEvents: "none",
  zIndex: "40",
} as Partial<CSSStyleDeclaration>;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );

function tip(title: string, sub: string | null, rows: [string, string][], accent: string): string {
  const head =
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:${rows.length ? "6px" : "0"}">` +
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

const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
const hhmm = (t: Tick) => {
  const sign = t < 0 ? "-" : "+";
  const a = Math.abs(t);
  return `T${sign}${String(Math.floor(a / 3600)).padStart(2, "0")}:${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}`;
};

/** deck hands a BitmapLayer pick the image-space pixel rather than a datum. */
interface BitmapPick {
  bitmap?: { size: { width: number; height: number }; pixel: [number, number] };
}

export function contextTooltip(
  info: PickingInfo,
): { html: string; style: Partial<CSSStyleDeclaration> } | null {
  // A raster carries no per-feature datum, so the value under the cursor is
  // read straight out of the grid the layer was built from. Without this the
  // one layer that IS a concentration field would be the only layer on the map
  // an operator could not interrogate.
  const probe = info.layer ? fieldProbes.get(info.layer.id) : undefined;
  if (probe && probe.width > 0) {
    const bm = (info as PickingInfo & BitmapPick).bitmap;
    if (!bm) return null;
    const col = Math.floor((bm.pixel[0] / bm.size.width) * probe.width);
    const row = Math.floor((bm.pixel[1] / bm.size.height) * probe.height);
    if (col < 0 || col >= probe.width || row < 0 || row >= probe.height) return null;
    const byte = probe.cells[row * probe.width + col];
    const missing = byte === MISSING;
    return {
      html: tip(
        missing ? probe.missingLabel : `${probe.decode(byte).toFixed(2)} ${probe.unit}`,
        probe.sub,
        missing
          ? [
              ["Status", "NO RETRIEVAL"],
              // Said out loud, every time. A hole in a concentration field that
              // reads as clean air is the single most dangerous thing this
              // console could draw.
              ["Means", "not measured — NOT clean air"],
            ]
          : [
              ["Quantity", "column optical depth"],
              ["Units", "unitless — NOT ug/m3"],
              ["Provenance", "OBSERVED"],
            ],
        cssRgb(missing ? NO_RETRIEVAL_RGB : aodColor(probe.decode(byte))),
      ),
      style: TOOLTIP_STYLE,
    };
  }

  const d = info.object as ContextDatum | undefined;
  if (!d || typeof d !== "object" || !("_ck" in d)) return null;

  switch (d._ck) {
    case "air": {
      const s = d.station;
      const rows: [string, string][] =
        d.state === "live"
          ? [
              ["PM2.5 now", `${d.value} ug/m3`],
              ["Window peak", s.peak === null ? "—" : `${s.peak} ug/m3`],
              ["Represents", `${(MONITOR_SCALE_M / 1000).toFixed(0)} km (EPA scale)`],
              ["Distance", km(s.distanceM)],
            ]
          : d.state === "dark"
            ? [
                // The hour it stopped is the finding. Reading it off a tooltip
                // is how an operator discovers the network went blind.
                ["Status", "WENT DARK"],
                ["Last reading", d.lastT === null ? "—" : hhmm(d.lastT)],
                ["Window peak", s.peak === null ? "—" : `${s.peak} ug/m3`],
                ["Distance", km(s.distanceM)],
              ]
            : [
                ["Status", "NEVER PUBLISHED"],
                ["Window peak", "no data at any hour"],
                ["Distance", km(s.distanceM)],
              ];
      return {
        html: tip(
          s.name || s.id,
          s.agency,
          rows,
          cssRgb(
            d.state === "live" && d.value !== null
              ? pm25Color(d.value)
              : d.state === "dark"
                ? ADVISORY_RGB
                : [150, 156, 168],
          ),
        ),
        style: TOOLTIP_STYLE,
      };
    }
    case "smoke":
      return {
        html: tip(
          `Smoke — ${d.plume.density}`,
          `${d.plume.satellite} analysis`,
          [
            ["Window", `${hhmm(d.plume.startT)} → ${hhmm(d.plume.endT)}`],
            ["Provenance", "OBSERVED"],
          ],
          cssRgb(SMOKE_RGB[d.plume.density]),
        ),
        style: TOOLTIP_STYLE,
      };
    case "slope":
      return {
        html: tip(
          `${d.cell.slope.toFixed(1)}° slope`,
          "Copernicus / SRTM derived",
          [
            ["Elevation", `${d.cell.elevation} m`],
            ["Aspect", `${Math.round(d.cell.aspect)}°`],
            ["Upslope factor", `${d.cell.spreadFactor.toFixed(1)}x`],
          ],
          cssRgb(slopeColor(d.cell.slope)),
        ),
        style: TOOLTIP_STYLE,
      };
    case "transmission":
      return {
        html: tip(
          [d.line.from, d.line.to].filter(Boolean).join(" → ") || "Transmission line",
          d.line.owner,
          [
            ["Voltage", d.line.voltageKv === null ? "not published" : `${d.line.voltageKv} kV`],
            ["Class", d.line.voltClass],
            ["Status", d.line.status],
          ],
          cssRgb(TRANSMISSION_RGB),
        ),
        style: TOOLTIP_STYLE,
      };
    case "svi": {
      const tr = d.tract;
      const pct = (v: number | null) => (v === null ? "suppressed" : `${Math.round(v * 100)}th`);
      return {
        html: tip(
          tr.name,
          "CDC/ATSDR Social Vulnerability Index",
          [
            ["Overall", pct(tr.overall)],
            ["Socioeconomic", pct(tr.socioeconomic)],
            ["Household", pct(tr.householdComposition)],
            ["Housing/transport", pct(tr.housingTransport)],
            ["No vehicle", tr.noVehicle === null ? "—" : String(tr.noVehicle)],
          ],
          cssRgb(sviColor(tr.overall ?? 0)),
        ),
        style: TOOLTIP_STYLE,
      };
    }
    case "advisory":
      return {
        html: tip(
          d.advisory.event,
          d.advisory.office,
          [
            ["Issued", d.advisory.issuedUtc.slice(0, 16).replace("T", " ")],
            ["Expires", d.advisory.expiresUtc.slice(0, 16).replace("T", " ")],
            ["Zones", String(d.advisory.zones.length)],
            ["Feed", d.advisory.live ? "LIVE" : "ARCHIVE"],
          ],
          cssRgb(ADVISORY_RGB),
        ),
        style: TOOLTIP_STYLE,
      };
    case "burn":
      return {
        html: tip(
          `${d.scar.name} fire`,
          `${d.scar.year} — prior burn`,
          [
            ["Year", String(d.scar.year)],
            ["Area", `${d.scar.acres.toLocaleString()} ac`],
          ],
          cssRgb(BURN_SCAR_RGB),
        ),
        style: TOOLTIP_STYLE,
      };
    case "detection":
      return {
        html: tip(
          `${Math.round(d.detection.frp)} MW`,
          `${d.detection.sensor} · ${d.detection.acquiredUtc.slice(11, 16)}Z`,
          [
            ["Radiative power", `${d.detection.frp} MW`],
            ["Brightness", `${Math.round(d.detection.brightness)} K`],
            ["Confidence", d.detection.confidence || "—"],
          ],
          cssRgb(frpColor(d.detection.frp, d.max)),
        ),
        style: TOOLTIP_STYLE,
      };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rail section
// ─────────────────────────────────────────────────────────────────────────────

const ICON_PROPS = { size: 13, strokeWidth: 1.75 } as const;

const LAYER_META: Record<
  ContextLayerId,
  { key: keyof LayerVisibility; swatch: string; Icon: typeof Wind }
> = {
  airQuality: {
    key: "airQuality",
    swatch: cssRamp(PM25_STOPS.map((s) => s.rgb)),
    Icon: Wind,
  },
  aerosol: {
    key: "aerosol",
    swatch: cssRamp(AOD_STOPS.map((a) => a.rgb)),
    Icon: Satellite,
  },
  fireIntensity: { key: "fireIntensity", swatch: cssRamp(FRP_RAMP), Icon: Flame },
  smoke: {
    key: "smoke",
    swatch: cssRamp([SMOKE_RGB.light, SMOKE_RGB.medium, SMOKE_RGB.heavy]),
    Icon: CloudFog,
  },
  transmission: { key: "transmission", swatch: cssRgb(TRANSMISSION_RGB), Icon: Zap },
  socialVulnerability: {
    key: "socialVulnerability",
    swatch: `linear-gradient(90deg, ${cssRgb(SVI_LOW)}, ${cssRgb(SVI_HIGH)})`,
    Icon: Users,
  },
  fireWeather: { key: "fireWeather", swatch: cssRgb(ADVISORY_RGB), Icon: TriangleAlert },
  slope: {
    key: "slope",
    swatch: `linear-gradient(90deg, ${cssRgb(SLOPE_LOW)}, ${cssRgb(SLOPE_HIGH)})`,
    Icon: Mountain,
  },
  burnScars: { key: "burnScars", swatch: cssRgb(BURN_SCAR_RGB), Icon: History },
};

// ───────────────────────────────────────────────────────────────────────────
// Legend
//
// A graduated ramp with no legend is decoration. These are the class breaks the
// map is actually drawn with — exported rather than restated, so key-modal.tsx
// can consume the same numbers instead of keeping a second copy that goes stale
// the first time a break moves.
// ───────────────────────────────────────────────────────────────────────────

export interface ContextLegendMark {
  label: string;
  rgb: Rgb;
  hollow?: boolean;
}

export interface ContextLegend {
  id: ContextLayerId;
  /** Continuous ramp, discrete classes, or a set of named marks. */
  kind: "ramp" | "classes" | "marks";
  /** Ramp / class swatches, low to high. */
  stops: Rgb[];
  /** Tick labels under the bar, low to high. */
  ticks: string[];
  /** What the numbers are. Empty when the layer is categorical. */
  unit: string;
  marks?: ContextLegendMark[];
  /** Present when part of what is drawn was computed by us rather than
   *  measured by somebody else. Rendered as a DERIVED caption. */
  derived?: string;
}

export const CONTEXT_LEGEND: Partial<Record<ContextLayerId, ContextLegend>> = {
  aerosol: {
    id: "aerosol",
    kind: "ramp",
    stops: AOD_STOPS.map((a) => a.rgb),
    ticks: ["0", ...AOD_BREAKS.map(String)],
    unit: "AOD (unitless column depth — not ug/m3)",
    marks: [{ label: "no retrieval — not clean air", rgb: NO_RETRIEVAL_RGB, hollow: true }],
  },
  airQuality: {
    id: "airQuality",
    kind: "marks",
    stops: PM25_STOPS.map((a) => a.rgb),
    ticks: ["0", ...PM25_STOPS.slice(1).map((a) => String(a.at))],
    unit: "PM2.5 ug/m3",
    marks: [
      { label: "reporting this hour", rgb: PM25_STOPS[3].rgb },
      { label: "went dark", rgb: ADVISORY_RGB, hollow: true },
      { label: "never published", rgb: [150, 156, 168], hollow: true },
    ],
    derived: "4 km coverage disc is EPA neighbourhood scale, drawn from station position",
  },
  socialVulnerability: {
    id: "socialVulnerability",
    kind: "classes",
    stops: [0, 1, 2, 3, 4].map(sviClassColor),
    ticks: ["0", ...SVI_BREAKS.map(String), "1"],
    unit: "CDC SVI percentile",
  },
  slope: {
    id: "slope",
    kind: "ramp",
    stops: SLOPE_BREAKS.map((d) => slopeColor(d)),
    ticks: ["0", ...SLOPE_BREAKS.map(String)],
    unit: "degrees",
  },
  smoke: {
    id: "smoke",
    kind: "classes",
    stops: [SMOKE_RGB.light, SMOKE_RGB.medium, SMOKE_RGB.heavy],
    ticks: ["light", "medium", "heavy"],
    unit: "analyst density class",
  },
  fireWeather: {
    id: "fireWeather",
    kind: "classes",
    stops: [ADVISORY_RGB, ADVISORY_RGB, ADVISORY_RGB],
    ticks: ["advisory", "watch", "warning"],
    unit: "VTEC significance",
  },
  burnScars: {
    id: "burnScars",
    kind: "ramp",
    stops: [
      mix(BURN_SCAR_RGB, [20, 22, 28], 0.6),
      mix(BURN_SCAR_RGB, [20, 22, 28], 0.3),
      BURN_SCAR_RGB,
    ],
    ticks: ["1900", "1960", "2017"],
    unit: "burn year",
  },
  transmission: {
    id: "transmission",
    kind: "classes",
    stops: [TRANSMISSION_RGB, TRANSMISSION_RGB, TRANSMISSION_RGB],
    ticks: ["115 kV", "230 kV", "500 kV"],
    unit: "line weight = nominal voltage",
  },
  fireIntensity: {
    id: "fireIntensity",
    kind: "ramp",
    stops: FRP_RAMP,
    ticks: ["1", "10", "100", "1k"],
    unit: "MW radiative power",
  },
};

/** Compact in-rail legend. The rail doubles as the key, so a layer that is ON
 *  shows the breaks it is drawn with without anyone opening a modal. */
function LegendStrip({ legend }: { legend: ContextLegend }) {
  return (
    <div className="glass-inset mt-1 mb-2 rounded-xs px-2 py-1.5">
      <div
        aria-hidden
        className="h-1.5 w-full rounded-xs"
        style={{
          background:
            legend.kind === "classes"
              ? cssRamp(legend.stops)
              : `linear-gradient(90deg, ${legend.stops.map(cssRgb).join(", ")})`,
        }}
      />
      <div className="mt-1 flex justify-between gap-1">
        {legend.ticks.map((tk) => (
          <span key={tk} className="readout text-[8.5px] text-faint">
            {tk}
          </span>
        ))}
      </div>
      <div className="label-mono mt-0.5 text-[8.5px]">{legend.unit}</div>
      {legend.marks?.map((m) => (
        <div key={m.label} className="mt-1 flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 flex-none rounded-full"
            style={
              m.hollow ? { border: `1.5px solid ${cssRgb(m.rgb)}` } : { background: cssRgb(m.rgb) }
            }
          />
          <span className="text-[9.5px] text-faint">{m.label}</span>
        </div>
      ))}
      {legend.derived && (
        <div className="mt-1 text-[9px] text-faint">
          <span className="label-mono text-warn-text">derived</span> {legend.derived}
        </div>
      )}
    </div>
  );
}

export interface ContextLayerTogglesProps {
  /** Defaults to the store, so `<ContextLayerToggles />` works bare — same
   *  zero-prop shape as LayersSection. Pass it only to pin a specific
   *  scenario, as the split view does. */
  scenarioId?: string;
  /** Pre-loaded bundle, when the map already holds one. Fetched if omitted. */
  context?: ContextBundle | null;
}

/**
 * Renders nothing when the scenario has no context payloads, so it is safe to
 * mount unconditionally next to LayersSection.
 *
 * Layers the pipeline could not build are shown DISABLED with their reason
 * rather than hidden — "volunteer the seam". An operator who can see that the
 * FRP layer is off because no MAP_KEY is set will not spend the demo wondering
 * where it went.
 */
export function ContextLayerToggles({ scenarioId, context }: ContextLayerTogglesProps = {}) {
  // Both hooks run unconditionally; the prop only decides which value is used.
  const storeScenarioId = useEgress(selScenarioId);
  const visible = useEgress(selLayers);
  const fetched = useContextBundle(scenarioId ?? storeScenarioId);
  const bundle = context ?? fetched;

  if (!bundle) return null;

  const byId = new Map<ContextLayerId, ContextLayerEntry>(
    bundle.manifest.layers.map((l) => [l.id, l]),
  );
  const rows = CONTEXT_LAYER_IDS.map((id) => byId.get(id)).filter(
    (e): e is ContextLayerEntry => !!e,
  );
  if (rows.length === 0) return null;

  const built = rows.filter((r) => r.available).length;

  return (
    <section className="border-hairline border-t px-3 py-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="label-mono">Context</span>
        <span className="readout text-[9.5px] text-faint">
          {built}/{rows.length}
        </span>
      </div>

      {rows.map((entry) => {
        const meta = LAYER_META[entry.id];
        const on = visible[meta.key];
        const modelled = entry.provenance === "modelled";
        const Icon = meta.Icon;
        const legend = CONTEXT_LEGEND[entry.id];

        return (
          <div key={entry.id} className="mb-1.5 last:mb-0">
            <div
              className="flex items-center gap-2"
              style={{ opacity: entry.available ? 1 : 0.42 }}
              title={
                entry.available
                  ? `${entry.source} — ${entry.note}`
                  : `Unavailable: ${entry.reason ?? "no payload"}`
              }
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 flex-none rounded-xs border border-hairline"
                style={{ background: meta.swatch, opacity: on && entry.available ? 1 : 0.35 }}
              />
              <Icon {...ICON_PROPS} aria-hidden className="flex-none text-faint" />

              <span className="flex-1 truncate text-[11.5px] text-subtle">
                {entry.label}
                {/* Provenance is read from the manifest, never hardcoded: a layer
                  that falls back to a modelled path must relabel itself. */}
                {modelled && entry.available && (
                  <span className="label-mono ml-1.5 text-warn-text">modelled</span>
                )}
              </span>

              {entry.available ? (
                <>
                  <span className="readout text-[9.5px] text-faint tabular">
                    {entry.recordCount.toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="sw"
                    data-on={on}
                    aria-pressed={on}
                    aria-label={entry.label}
                    onClick={() => actions.toggleLayer(meta.key)}
                  />
                </>
              ) : (
                <span className="label-mono flex-none">no data</span>
              )}
            </div>
            {on && entry.available && legend && <LegendStrip legend={legend} />}
          </div>
        );
      })}
    </section>
  );
}

/**
 * Monitors that were publishing and stopped, with the hour they stopped.
 *
 * Exported for the timeline and the rail: on the Camp Fire this is the single
 * most load-bearing fact in the whole context stack, and it is invisible on a
 * map at any one instant — an operator scrubbing past T+2h just sees a circle
 * quietly become a ring. Beside the clock it is a sentence.
 *
 * "Dark" excludes monitors that never published at all. A station that was
 * never there did not fail; it was never a source of information.
 */
export interface MonitorDropout {
  station: AirQualityStation;
  /** Last tick this monitor published. */
  lastT: Tick;
  /** Peak it recorded before stopping, if any. */
  peak: number | null;
}

export function airQualityDropouts(context: ContextBundle | null): MonitorDropout[] {
  const aq = context?.airQuality;
  if (!aq) return [];
  const lastTicks = lastReportedTicks(aq);
  const lastFrame = aq.frames.length > 0 ? aq.frames[aq.frames.length - 1].t : null;
  const out: MonitorDropout[] = [];
  for (let i = 0; i < aq.stations.length; i++) {
    const lastT = lastTicks[i];
    // Still publishing at the final frame is not a dropout.
    if (lastT === null || lastT === lastFrame) continue;
    out.push({ station: aq.stations[i], lastT, peak: aq.stations[i].peak });
  }
  return out.sort((a, b) => a.station.distanceM - b.station.distanceM);
}

/**
 * Archived advisories in force at `t`. Exported for the rail or the timeline —
 * these products are real and timestamped but carry no drawable footprint, so
 * the only honest place to show them is as text beside the clock.
 */
export function activeArchiveAdvisories(
  context: ContextBundle | null,
  t: Tick,
): FireWeatherAdvisory[] {
  if (!context?.fireWeather) return [];
  return advisoriesAt(context.fireWeather.archive, t);
}

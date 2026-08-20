"use client";

import type { Color, Layer } from "@deck.gl/core";
import { BitmapLayer, PathLayer, PolygonLayer } from "@deck.gl/layers";
import { useEffect, useState } from "react";
import { HAZARD_RGB } from "@/lib/constants";
import type { HazardFrame, LngLat } from "@/types/egress";

/**
 * The hazard rendered as a field rather than a boundary.
 *
 * A wildfire has no edge. A filled polygon with a stroke says it does, and says
 * it in the one place on this map where a false certainty is most expensive —
 * an operator reading a crisp line will treat the ground just outside it as
 * safe. So the footprint is drawn as a continuous intensity field: hottest in
 * the band the front is crossing right now, falling away behind it as the burn
 * cools and ahead of it into the ground the model says is next, with nothing
 * anywhere that resolves into a line.
 *
 * WHERE THE WORK HAPPENS
 *
 *   scripts/build-hazard-field.ts scan-line fills every frame's rings into one
 *   grid and keeps, per cell, the index of the first frame that covered it.
 *   That file is the whole model. This module only re-colours it.
 *
 *   Per hazard frame — not per tick; frames step every 300 scenario seconds —
 *   the arrival grid is turned into one RGBA raster: weight from burn age, two
 *   box blurs at different radii for core and halo, then the ramp. Six linear
 *   passes over ~69k cells. Between frame boundaries the canvas reference is
 *   unchanged, so deck re-uploads nothing and the scrubber costs zero here.
 *
 * PROVENANCE
 *
 *   The field re-renders the geometry the track already carried; it invents no
 *   ground. What it must not do is flatten the difference between the one
 *   observed perimeter and the ninety-six interpolated ones, so the hairline
 *   annotation over the field is SOLID on an observed frame and DASHED on an
 *   interpolated one — the same solid/dashed language the scrubber's provenance
 *   band already uses.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Payload
// ─────────────────────────────────────────────────────────────────────────────

export interface HazardField {
  scenarioId: string;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  cellMetres: number;
  frameTicks: number[];
  /** base64 Uint8, row 0 north. 255 = never inside a modelled perimeter. */
  arrival: string;
  source: string;
  generatedAt: string;
}

/** Decoded once per payload; the base64 string is never touched again. */
export interface DecodedField extends HazardField {
  cells: Uint8Array;
}

const NEVER = 255;

// ─────────────────────────────────────────────────────────────────────────────
// Ramp. Same hue family as --hazard throughout: a deep ember for cooled burn
// and the outer halo, the token itself through the active band, and the token
// lifted toward white for the leading edge. No new hue enters the palette.
// ─────────────────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function shade(rgb: Rgb, f: number): Rgb {
  return [
    Math.round(Math.min(255, rgb[0] * f)),
    Math.round(Math.min(255, rgb[1] * f)),
    Math.round(Math.min(255, rgb[2] * f)),
  ];
}

function mix(a: Rgb, b: Rgb, f: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const EMBER: Rgb = shade(HAZARD_RGB, 0.5);
const MID: Rgb = HAZARD_RGB;
const CORE: Rgb = mix(HAZARD_RGB, [255, 250, 242], 0.7);

/** Where MID sits on the 0..1 ramp. High, so most of the burned area reads as
 *  cooled ember and only the front itself reaches the pale core. */
const RAMP_KNEE = 0.62;

// ─────────────────────────────────────────────────────────────────────────────
// Field shaping. All in frames; the track steps every 300 scenario seconds.
// ─────────────────────────────────────────────────────────────────────────────

/** Frames the front stays at full heat before it starts cooling. Two frames of
 *  advance is the band an operator reads as "burning right now". */
const FRONT_HOLD = 2;
/** Cooling constant past the hold, in frames. ~25 minutes to halfway down. */
const AGE_TAU = 5;
/** Floor the burned interior never drops below — it is still burned ground,
 *  and an operator has to be able to see that it is. */
const EMBER_FLOOR = 0.3;
/** How far ahead of the front the pre-heat glow reaches, in frames. */
const LEAD_FRAMES = 3;
/** Peak weight immediately ahead of the front. Under 1 so the hottest pixel is
 *  always ON the front, never in front of it. */
const LEAD_PEAK = 0.5;

/** Blur radii in cells (~110 m each). Core is tight enough to keep the front's
 *  shape; the halo is wide enough that the outer edge has nowhere to stop. */
const CORE_BLUR = 2;
const HALO_BLUR = 8;

const CORE_GAIN = 1.05;
const CORE_ALPHA_MAX = 0.86;
/** <1 lifts the cooled interior clear of the basemap without touching the
 *  front, which is already at the ceiling. */
const CORE_ALPHA_POW = 0.8;
const HALO_GAIN = 1.9;
const HALO_ALPHA_MAX = 0.34;

// ─────────────────────────────────────────────────────────────────────────────
// Loading. Self-contained, like the context layers: the field is optional, and
// a scenario without one keeps the polygon footprint.
// ─────────────────────────────────────────────────────────────────────────────

const fieldCache = new Map<string, DecodedField | null>();
const fieldInflight = new Map<string, Promise<DecodedField | null>>();

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function peekHazardField(scenarioId: string): DecodedField | null {
  return fieldCache.get(scenarioId) ?? null;
}

async function loadHazardField(scenarioId: string): Promise<DecodedField | null> {
  if (fieldCache.has(scenarioId)) return fieldCache.get(scenarioId) ?? null;
  const pending = fieldInflight.get(scenarioId);
  if (pending) return pending;

  const p = (async (): Promise<DecodedField | null> => {
    try {
      const res = await fetch(`/data/${scenarioId}/hazard-field.json`, { cache: "force-cache" });
      if (!res.ok) return null;
      const raw = (await res.json()) as HazardField;
      if (!raw?.arrival || !raw.width || !raw.height) return null;
      const cells = decodeBase64(raw.arrival);
      if (cells.length !== raw.width * raw.height) return null;
      return { ...raw, cells };
    } catch {
      // Absent is the normal case for a plume, or for a fire whose track has no
      // perimeter geometry. The caller falls back; nothing is faked.
      return null;
    }
  })()
    .then((f) => {
      fieldCache.set(scenarioId, f);
      return f;
    })
    .finally(() => fieldInflight.delete(scenarioId));

  fieldInflight.set(scenarioId, p);
  return p;
}

export function useHazardField(scenarioId: string): DecodedField | null {
  const [field, setField] = useState<DecodedField | null>(() => peekHazardField(scenarioId));

  useEffect(() => {
    let live = true;
    const hit = peekHazardField(scenarioId);
    if (hit) {
      setField(hit);
      return;
    }
    setField(null);
    loadHazardField(scenarioId).then((f) => {
      if (live) setField(f);
    });
    return () => {
      live = false;
    };
  }, [scenarioId]);

  return field;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raster
// ─────────────────────────────────────────────────────────────────────────────

interface Scratch {
  raw: Float32Array;
  tmp: Float32Array;
  core: Float32Array;
  halo: Float32Array;
}

const scratchCache = new WeakMap<DecodedField, Scratch>();

function scratchFor(field: DecodedField): Scratch {
  let s = scratchCache.get(field);
  if (!s) {
    const n = field.width * field.height;
    s = {
      raw: new Float32Array(n),
      tmp: new Float32Array(n),
      core: new Float32Array(n),
      halo: new Float32Array(n),
    };
    scratchCache.set(field, s);
  }
  return s;
}

/** Separable box blur, running-sum, so cost is independent of radius. */
function boxBlur(
  src: Float32Array,
  dst: Float32Array,
  tmp: Float32Array,
  w: number,
  h: number,
  r: number,
): void {
  const span = r * 2 + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / span;
      sum -= src[row + Math.min(w - 1, Math.max(0, x - r))];
      sum += src[row + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / span;
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
}

/**
 * Ramp and alpha curve, tabulated at 8-bit precision.
 *
 * The colourise pass touches ~69k cells; doing a branch, three lerps and a
 * fractional power per cell there is most of the frame's cost for a result
 * that only ever takes 256 distinct values.
 */
const LUT_STEPS = 256;
const rampLut = new Uint8Array(LUT_STEPS * 3);
const alphaLut = new Float32Array(LUT_STEPS);

for (let i = 0; i < LUT_STEPS; i++) {
  const x = i / (LUT_STEPS - 1);
  const from = x <= RAMP_KNEE ? EMBER : MID;
  const to = x <= RAMP_KNEE ? MID : CORE;
  const f = x <= RAMP_KNEE ? x / RAMP_KNEE : (x - RAMP_KNEE) / (1 - RAMP_KNEE);
  rampLut[i * 3] = from[0] + (to[0] - from[0]) * f;
  rampLut[i * 3 + 1] = from[1] + (to[1] - from[1]) * f;
  rampLut[i * 3 + 2] = from[2] + (to[2] - from[2]) * f;
  alphaLut[i] = x ** CORE_ALPHA_POW * CORE_ALPHA_MAX;
}

/**
 * One RGBA raster for one frame index. Returns a fresh canvas every call —
 * deck.gl compares the `image` prop by reference, so mutating a shared canvas
 * would leave the texture stale on screen.
 */
function rasterise(field: DecodedField, frameIndex: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const { width: w, height: h, cells } = field;
  const n = w * h;
  const { raw, tmp, core, halo } = scratchFor(field);

  // Age -> weight, tabulated once so the per-cell pass is a lookup. Behind the
  // front the burn cools toward an ember floor; ahead of it the ground the
  // model says is next carries a lower pre-heat glow.
  const behind = new Float32Array(frameIndex + 1);
  for (let age = 0; age <= frameIndex; age++) {
    behind[age] =
      age <= FRONT_HOLD
        ? 1
        : EMBER_FLOOR + (1 - EMBER_FLOOR) * Math.exp(-(age - FRONT_HOLD) / AGE_TAU);
  }
  const ahead = new Float32Array(LEAD_FRAMES + 1);
  for (let lead = 0; lead <= LEAD_FRAMES; lead++) {
    ahead[lead] = LEAD_PEAK * (1 - lead / (LEAD_FRAMES + 1));
  }

  for (let i = 0; i < n; i++) {
    const a = cells[i];
    if (a === NEVER) {
      raw[i] = 0;
    } else if (a <= frameIndex) {
      raw[i] = behind[frameIndex - a];
    } else {
      const lead = a - frameIndex;
      raw[i] = lead <= LEAD_FRAMES ? ahead[lead] : 0;
    }
  }

  boxBlur(raw, core, tmp, w, h, CORE_BLUR);
  boxBlur(raw, halo, tmp, w, h, HALO_BLUR);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const last = LUT_STEPS - 1;

  for (let i = 0; i < n; i++) {
    const c = Math.min(last, (core[i] * CORE_GAIN * last) | 0);
    const aC = alphaLut[c];
    const aG = Math.min(1, halo[i] * HALO_GAIN) * HALO_ALPHA_MAX;
    const aOut = aC + aG * (1 - aC);
    const o = i * 4;
    if (aOut <= 0.004) {
      px[o + 3] = 0;
      continue;
    }
    // Core over halo, straight (non-premultiplied) alpha, which is what a
    // canvas-backed texture is sampled as.
    const wG = (aG * (1 - aC)) / aOut;
    const wC = aC / aOut;
    const r = c * 3;
    px[o] = rampLut[r] * wC + EMBER[0] * wG;
    px[o + 1] = rampLut[r + 1] * wC + EMBER[1] * wG;
    px[o + 2] = rampLut[r + 2] * wC + EMBER[2] * wG;
    px[o + 3] = aOut * 255;
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame memo. Keyed on the frame index, so scrubbing inside one frame is
// free and the split view's two panes share one raster.
// ─────────────────────────────────────────────────────────────────────────────

interface FrameMemo {
  index: number;
  canvas: HTMLCanvasElement | null;
}

const rasterMemo = new WeakMap<DecodedField, FrameMemo>();

function rasterFor(field: DecodedField, frameIndex: number): HTMLCanvasElement | null {
  const hit = rasterMemo.get(field);
  if (hit && hit.index === frameIndex) return hit.canvas;
  const canvas = rasterise(field, frameIndex);
  rasterMemo.set(field, { index: frameIndex, canvas });
  return canvas;
}

function frameIndexOf(ticks: number[], t: number): number {
  let lo = 0;
  let hi = ticks.length - 1;
  if (t < ticks[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ticks[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Perimeter hairline
// ─────────────────────────────────────────────────────────────────────────────

/** Dash geometry in metres along the perimeter. Long enough to read as dashes
 *  at the zoom an operator works at, short enough to still trace the shape. */
const DASH_ON = 260;
const DASH_OFF = 190;

const METRES_PER_DEG_LAT = 111_320;

/** Chop closed rings into dash segments. deck has no dash primitive without an
 *  extension, and the contraflow marking already solves it this way. */
function dashRings(rings: LngLat[][]): LngLat[][] {
  const out: LngLat[][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const scale = Math.cos((ring[0][1] * Math.PI) / 180);
    let run = 0;
    let on = true;
    let current: LngLat[] = [ring[0]];

    for (let i = 1; i <= ring.length; i++) {
      const from = ring[i - 1];
      const to = ring[i % ring.length];
      const dx = (to[0] - from[0]) * scale * METRES_PER_DEG_LAT;
      const dy = (to[1] - from[1]) * METRES_PER_DEG_LAT;
      const seg = Math.hypot(dx, dy);
      if (seg === 0) continue;

      let done = 0;
      while (done < seg) {
        const budget = (on ? DASH_ON : DASH_OFF) - run;
        const step = Math.min(budget, seg - done);
        done += step;
        run += step;
        const f = done / seg;
        const point: LngLat = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
        if (on) current.push(point);
        if (run >= (on ? DASH_ON : DASH_OFF)) {
          if (on && current.length > 1) out.push(current);
          on = !on;
          run = 0;
          current = on ? [point] : [];
        }
      }
    }
    if (on && current.length > 1) out.push(current);
  }
  return out;
}

/** Closed rings as open paths, first vertex repeated so the ring joins up. */
function closedPaths(rings: LngLat[][]): LngLat[][] {
  return rings.filter((r) => r.length >= 3).map((r) => [...r, r[0]]);
}

const pathMemo = new WeakMap<object, { key: string; paths: LngLat[][] }>();

function memoPaths(owner: object, key: string, make: () => LngLat[][]): LngLat[][] {
  const hit = pathMemo.get(owner);
  if (hit && hit.key === key) return hit.paths;
  const paths = make();
  pathMemo.set(owner, { key, paths });
  return paths;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────────────────────

export interface HazardLayerArgs {
  /** Null when the scenario has no field on disk — the polygon path is used. */
  field: DecodedField | null;
  frame: HazardFrame;
  prefix: string;
  /** Camera zoom. The field is a regional read; at street level it competes
   *  with the per-structure severity ramp, which is the finer signal. */
  zoom?: number;
}

export interface HazardLayerSet {
  /** Ground plane: the field, or the fallback footprint. Drawn under the
   *  network so the fire never washes out a road an operator is reading. */
  ground: Layer[];
  /** Hairline annotation, drawn over the network. */
  over: Layer[];
}

/**
 * Faint on purpose. The field is the shape; this only lets an operator see
 * exactly where the modelled boundary sits, which is a different question and a
 * quieter one.
 */
const LINE_OBSERVED: Color = [HAZARD_RGB[0], HAZARD_RGB[1], HAZARD_RGB[2], 150];
const LINE_MODELLED: Color = [HAZARD_RGB[0], HAZARD_RGB[1], HAZARD_RGB[2], 105];

const FALLBACK_FILL: Color = [HAZARD_RGB[0], HAZARD_RGB[1], HAZARD_RGB[2], 46];

const getPath = (d: LngLat[]) => d;
const getPolygon = (d: LngLat[]) => d;

/**
 * Opacity of the ground field as the camera closes in.
 *
 * The field is painted at 110 m per cell — a regional signal. Once individual
 * structures are on screen they carry a per-building severity ramp, which is
 * strictly finer information about the same fire, and a full-strength wash on
 * top of it buries exactly the distinction the operator zoomed in to read.
 * The field does not vanish; it recedes to context.
 */
function fieldOpacityFor(zoom: number | undefined): number {
  if (zoom === undefined) return 1;
  if (zoom <= FIELD_FADE_FROM) return 1;
  if (zoom >= FIELD_FADE_TO) return FIELD_MIN_OPACITY;
  const k = (zoom - FIELD_FADE_FROM) / (FIELD_FADE_TO - FIELD_FADE_FROM);
  return 1 - k * (1 - FIELD_MIN_OPACITY);
}

/** Fade begins as buildings appear and completes once they are the subject. */
const FIELD_FADE_FROM = 13.5;
const FIELD_FADE_TO = 15.5;
const FIELD_MIN_OPACITY = 0.32;

export function buildHazardLayers({ field, frame, prefix, zoom }: HazardLayerArgs): HazardLayerSet {
  const rings = frame.rings.filter((r) => r.length >= 3);
  const ground: Layer[] = [];
  const over: Layer[] = [];
  if (rings.length === 0) return { ground, over };

  const observed = frame.provenance === "observed";

  if (field) {
    const index = frameIndexOf(field.frameTicks, frame.t);
    const image = rasterFor(field, index);
    if (image) {
      ground.push(
        new BitmapLayer({
          id: `${prefix}hazard-field`,
          image,
          bounds: field.bbox,
          pickable: false,
          /* The raster carries its own alpha ramp, so layer opacity is used for
             one thing only: receding as the camera closes on the structures.
             It never shapes the front against the cooled interior. */
          opacity: fieldOpacityFor(zoom),
        }),
      );
    }
  } else {
    // No field on disk. The flat footprint is honest about being a footprint.
    ground.push(
      new PolygonLayer<LngLat[]>({
        id: `${prefix}hazard`,
        data: rings,
        pickable: false,
        filled: true,
        stroked: false,
        extruded: false,
        getPolygon,
        getFillColor: FALLBACK_FILL,
      }),
    );
  }

  const paths = memoPaths(frame, observed ? "solid" : "dash", () =>
    observed ? closedPaths(rings) : dashRings(rings),
  );

  over.push(
    new PathLayer<LngLat[]>({
      id: `${prefix}hazard-perimeter`,
      data: paths,
      pickable: false,
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 1.4,
      capRounded: true,
      jointRounded: true,
      getPath,
      getWidth: 1,
      getColor: observed ? LINE_OBSERVED : LINE_MODELLED,
    }),
  );

  return { ground, over };
}

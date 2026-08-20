"use client";

/**
 * Gridded context layers, drawn as rasters.
 *
 * ── WHY A CANVAS AND NOT HeatmapLayer ───────────────────────────────────────
 *
 * `@deck.gl/aggregation-layers` HeatmapLayer does not render in this dependency
 * tree — luma 9.3.6 / deck 9.3.x drops `weightsTexture` from the shader layout
 * and the pass produces nothing, interleaved or overlaid. Verified twice.
 *
 * It would be the wrong tool anyway. A heatmap KERNEL-SMOOTHS points into a
 * continuous surface, which is exactly the operation these layers must not
 * perform: a MAIAC cell and a DEM cell are each a measurement of a specific
 * square of ground, and blurring one into its neighbours produces values no
 * instrument returned. So the established idiom in this codebase — the one
 * hazard-field.tsx already uses — is followed instead: build an RGBA canvas
 * from the grid and hand it to a BitmapLayer.
 *
 * ── WHY NEAREST-NEIGHBOUR SAMPLING ──────────────────────────────────────────
 *
 * hazard-field.tsx deliberately blurs, because a fire front has no edge and a
 * crisp line there would be a false certainty. The opposite is true here. A
 * 1 km satellite retrieval HAS an edge: the cell boundary is where one
 * measurement stops and the next begins. Bilinear upsampling would invent a
 * smooth gradient across that boundary and make a 1 km product look like a
 * 50 m one. These fields render blocky on purpose — the block IS the
 * resolution, and an operator can see exactly how coarse the evidence is.
 *
 * ── WHY MISSING DATA IS DRAWN, NOT SKIPPED ──────────────────────────────────
 *
 * The single most dangerous thing a concentration field can do is render "no
 * measurement here" identically to "measured, and it is clean". A transparent
 * hole reads as clear air. So absent cells are painted as a visible stipple in
 * neutral grey: present, obviously not a value, and impossible to mistake for
 * a low reading. On the Camp Fire this matters more than anything else in the
 * layer — the satellite returned no aerosol retrieval directly over Paradise.
 */

export type Rgb = [number, number, number];

/** Grid byte reserved for "the instrument returned nothing for this cell". */
export const MISSING = 255;

export interface RasterOptions {
  /** Colour for a normalised value in 0..1. */
  ramp: (t: number) => Rgb;
  /** Alpha 0..1 for a normalised value in 0..1. */
  alpha: (t: number) => number;
  /**
   * Stipple colour for cells with no measurement. Null skips the stipple, which
   * is only correct when the grid cannot contain missing cells at all.
   */
  missingRgb: Rgb | null;
  /** 0..1. Kept low: absence must be legible, never dominant. */
  missingAlpha?: number;
  /** Highest encodable byte. Byte b normalises to b / valueMax. */
  valueMax?: number;
}

/**
 * Canvas pixels per grid cell on each axis, so the missing-data stipple has
 * somewhere to exist under nearest-neighbour sampling.
 *
 * 4, not 2. The stipple lives in grid space, so its on-screen size scales with
 * the camera: at 2x it is one mark covering a quarter of a 1 km cell, which at
 * town zoom is a 25-pixel block and swallows the map. At 4x it is one mark in
 * sixteen — 6% coverage — which reads as "nothing was measured here" at every
 * zoom without ever competing with the field it is annotating.
 */
const SUB = 4;

/** Base64 -> bytes. Same shape as hazard-field's decoder; duplicated rather
 *  than imported because that module is owned by another workflow. */
export function decodeGrid(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One RGBA canvas for one grid. Returns a fresh canvas each call — deck.gl
 * compares `image` by reference, so a mutated shared canvas would leave the
 * texture stale on screen.
 */
export function rasteriseGrid(
  cells: Uint8Array,
  width: number,
  height: number,
  opts: RasterOptions,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (cells.length !== width * height) return null;

  const cw = width * SUB;
  const chh = height * SUB;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = chh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const img = ctx.createImageData(cw, chh);
  const px = img.data;
  const valueMax = opts.valueMax ?? 254;
  const missAlpha = Math.round((opts.missingAlpha ?? 0.5) * 255);

  // Ramp tabulated at byte precision: the colourise pass is one lookup per
  // subpixel and the result only ever takes 255 distinct values anyway.
  const lut = new Uint8Array(256 * 4);
  for (let b = 0; b < 255; b++) {
    const t = Math.min(1, b / valueMax);
    const c = opts.ramp(t);
    lut[b * 4] = c[0];
    lut[b * 4 + 1] = c[1];
    lut[b * 4 + 2] = c[2];
    lut[b * 4 + 3] = Math.round(Math.max(0, Math.min(1, opts.alpha(t))) * 255);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const b = cells[y * width + x];
      const missing = b === MISSING;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const o = ((y * SUB + sy) * cw + (x * SUB + sx)) * 4;
          if (missing) {
            // One subpixel in sixteen. A denser pattern reads as a second data
            // layer competing with the field; this reads as absence.
            const on = sx === 1 && sy === 1;
            const m = opts.missingRgb;
            if (!m || !on) {
              px[o + 3] = 0;
              continue;
            }
            px[o] = m[0];
            px[o + 1] = m[1];
            px[o + 2] = m[2];
            px[o + 3] = missAlpha;
            continue;
          }
          const l = b * 4;
          px[o] = lut[l];
          px[o + 1] = lut[l + 1];
          px[o + 2] = lut[l + 2];
          px[o + 3] = lut[l + 3];
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Nearest-neighbour sampler params for BitmapLayer. See the header: a gridded
 * measurement has an edge, and bilinear upsampling would erase it.
 */
export const NEAREST = { minFilter: "nearest", magFilter: "nearest" } as const;

"use client";

/**
 * The fleet sprite sheet.
 *
 * ── Why a generated atlas and not files ─────────────────────────────────────
 *
 * Nothing on this map may depend on a network the demo machine might not have.
 * An icon CDN is a token that can expire on stage, and a committed PNG is a
 * binary nobody can diff. So the silhouettes are drawn with canvas 2D path
 * commands at module scope, once, on the client, and handed to deck.gl as a
 * single `data:image/png` atlas. No fetch, no CSP surface, no asset pipeline.
 *
 * ── Why plan view and why these three shapes ────────────────────────────────
 *
 * These icons are rotated into the map plane and pointed along the direction of
 * travel, so they have to be drawn the way a vehicle looks from above. At the
 * 12–20px they actually render at, interior detail turns to mush; only the
 * OUTLINE survives. Each silhouette is therefore built around one coarse cue
 * that is still legible when the whole glyph is twenty pixels long:
 *
 *   bus        one long unbroken slab, 2.4:1, the longest thing on the map
 *   ambulance  short body with a STEPPED shoulder where the box meets the cab,
 *              and a cross cut clean through the roof
 *   engine     cab + body + a thin LADDER TAIL overhanging the rear, plus
 *              outrigger stubs at the waist
 *
 * Long bar / stepped bar with a hole / bar with a spike out the back. Those
 * three read apart at a glance, which colour is not allowed to do here.
 *
 * ── Colour ──────────────────────────────────────────────────────────────────
 *
 * Every glyph is authored as pure white alpha and every mapping entry sets
 * `mask: true`, so deck tints it from `getColor`. That is the whole point:
 * SHAPE carries vehicle type, COLOUR stays free to carry phase and risk, and
 * the design system's rule that colour only ever encodes data state survives.
 *
 * Each glyph also has a `-casing` twin — the same outline dilated by a round
 * stroke — drawn underneath in near-black. Over Esri satellite imagery a bare
 * silhouette disappears into dark tree canopy; the casing is what keeps it a
 * mark rather than a smudge.
 */

/** Atlas cell. Generous: the atlas is downscaled hard at render size, and a
 *  tight cell mip-bleeds into its neighbour. */
const CELL = 128;

/** Longest glyph extent inside a cell, leaving a clear margin for the casing
 *  dilation and for mipmap bleed. */
const SPAN = 108;

/** Casing dilation, in atlas units. Reads as a ~1.5px keyline at render size. */
const CASING = 13;

// ─────────────────────────────────────────────────────────────────────────────
// How big a glyph draws
// ─────────────────────────────────────────────────────────────────────────────

/** Zoom at which a glyph draws at its authored pixel size. z15 is where one
 *  screen pixel is roughly two metres here, so a 25px coach is about a coach. */
const SCALE_REF_ZOOM = 15;

/**
 * Sublinear falloff exponent.
 *
 * A glyph in `sizeUnits: "meters"` doubles every zoom level — pull back three
 * levels and the fleet is the only thing on the map. A glyph in pixels never
 * changes at all, so at street zoom a bus is a speck sitting on a road four
 * times its width. Neither is what an instrument wants.
 *
 * So size follows `2 ** ((zoom - ref) * K)` with K well under 1: the mark
 * shrinks as the camera pulls back, but far more slowly than the ground does.
 * At K = 0.38 a full zoom level costs about 23% of the glyph's size against the
 * ground's 50%, which is what keeps a bus findable at region zoom without
 * letting it stand on top of the zone boundary underneath it.
 */
const SCALE_EXP = 0.38;

/** Floor. Below this a bus and an ambulance are the same four-pixel smudge and
 *  the whole point of drawing silhouettes is gone — found by eye at z11, not
 *  derived. Shrinking stops here rather than continuing to nothing. */
const SCALE_MIN = 0.4;

/** Ceiling. Past street zoom the glyph has said everything it can say, and a
 *  bus wider than the road it is on reads as a bug. */
const SCALE_MAX = 1.7;

/**
 * One multiplier for every glyph on the map, at this camera zoom.
 *
 * Handed to deck as `sizeScale` / `radiusScale` rather than folded into a
 * per-datum accessor: it is one number per render, not one per vehicle, and as
 * a plain layer prop it takes effect without an `updateTriggers` entry.
 *
 * Everything that has to shrink together reads this — the vehicle silhouettes,
 * their at-risk pulse ring, the pickup rings, the stabled-engine glyphs and the
 * roadblock barriers — so a shrunk vehicle can never end up wearing a
 * full-sized halo.
 */
export function glyphScale(zoom: number): number {
  const s = 2 ** ((zoom - SCALE_REF_ZOOM) * SCALE_EXP);
  return s < SCALE_MIN ? SCALE_MIN : s > SCALE_MAX ? SCALE_MAX : s;
}

export type VehicleGlyph = "bus" | "ambulance" | "engine";

const GLYPHS: VehicleGlyph[] = ["bus", "ambulance", "engine"];

export interface IconMappingEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  mask: boolean;
}

export interface VehicleAtlas {
  /** `data:image/png;base64,...` — safe to hand straight to deck's IconLayer. */
  url: string;
  mapping: Record<string, IconMappingEntry>;
}

/** Mapping key for the tinted glyph. */
export function glyphIcon(g: VehicleGlyph): string {
  return g;
}

/** Mapping key for the dark keyline drawn under the glyph. */
export function casingIcon(g: VehicleGlyph): string {
  return `${g}-casing`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Silhouettes
//
// All drawn nose-UP in a CELL x CELL box, centred on (CELL/2, CELL/2). Nose-up
// is what makes `getAngle = -bearing` the whole of the heading maths at the
// call site: at angle 0 the glyph points to map north.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;

/** Rounded rectangle centred on (cx, cy). `roundRect` is universally available
 *  in the browsers this console runs in, but the manual arc keeps the module
 *  free of a capability check on a code path that cannot fall back. */
function roundedBox(ctx: Ctx, cx: number, cy: number, w: number, h: number, r: number): void {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Outline of one glyph, as path commands only. Called twice per glyph: once
 * filled for the mark, once filled AND stroked for the casing.
 */
function outline(ctx: Ctx, glyph: VehicleGlyph, cx: number, cy: number): void {
  ctx.beginPath();
  if (glyph === "bus") {
    // One slab. A coach is the longest thing in the fleet and nothing else on
    // the map is this shape, so the length is the identity.
    const len = SPAN;
    const wid = 42;
    roundedBox(ctx, cx, cy, wid, len, 11);
    // Mirrors. Two nubs at the shoulder, which is the only asymmetry that
    // survives downscaling and the only thing that says "front".
    roundedBox(ctx, cx - wid / 2 - 4, cy - len / 2 + 16, 10, 7, 3);
    roundedBox(ctx, cx + wid / 2 + 4, cy - len / 2 + 16, 10, 7, 3);
    return;
  }

  if (glyph === "ambulance") {
    // Box body plus a narrower cab: the step at the shoulder is the cue.
    const bodyLen = 54;
    const bodyWid = 46;
    const cabLen = 26;
    const cabWid = 34;
    const top = cy - (bodyLen + cabLen) / 2;
    roundedBox(ctx, cx, top + cabLen / 2, cabWid, cabLen, 9);
    roundedBox(ctx, cx, top + cabLen + bodyLen / 2, bodyWid, bodyLen, 6);
    // Wheels proud of the body — a van's stance, not a coach's.
    for (const sy of [top + cabLen + 12, top + cabLen + bodyLen - 12]) {
      roundedBox(ctx, cx - bodyWid / 2 - 2, sy, 8, 15, 3);
      roundedBox(ctx, cx + bodyWid / 2 + 2, sy, 8, 15, 3);
    }
    return;
  }

  // engine — cab, pump body, outriggers, and a ladder overhanging the tail.
  const cabLen = 30;
  const bodyLen = 48;
  const tailLen = 26;
  const total = cabLen + bodyLen + tailLen;
  const top = cy - total / 2;
  roundedBox(ctx, cx, top + cabLen / 2, 44, cabLen, 9);
  roundedBox(ctx, cx, top + cabLen + bodyLen / 2, 47, bodyLen, 5);
  // Outrigger / pump-panel stubs at the waist.
  roundedBox(ctx, cx - 30, top + cabLen + bodyLen / 2, 16, 12, 3);
  roundedBox(ctx, cx + 30, top + cabLen + bodyLen / 2, 16, 12, 3);
  // The ladder. A thin spike past the rear bumper — no other glyph has one.
  roundedBox(ctx, cx, top + cabLen + bodyLen + tailLen / 2 - 4, 14, tailLen + 8, 4);
}

/**
 * Holes punched through the filled silhouette. Only the ambulance has one: a
 * cross is the single most recognisable mark on a medical vehicle anywhere in
 * the world, and it stays a visible break in the fill down to about 12px.
 */
function cutouts(ctx: Ctx, glyph: VehicleGlyph, cx: number, cy: number): void {
  if (glyph !== "ambulance") return;
  const top = cy - (54 + 26) / 2;
  const centre = top + 26 + 54 / 2;
  ctx.beginPath();
  roundedBox(ctx, cx, centre, 9, 30, 2);
  roundedBox(ctx, cx, centre, 30, 9, 2);
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// Atlas
// ─────────────────────────────────────────────────────────────────────────────

let cached: VehicleAtlas | null | undefined;

/**
 * The atlas, built once and memoised.
 *
 * Returns null when there is no DOM (server render) or when a 2D context
 * cannot be acquired. Callers MUST handle null by falling back to the plain
 * scatterplot pucks — an icon layer with no atlas draws nothing at all, and a
 * fleet that silently vanishes is worse than a fleet drawn as dots.
 */
export function vehicleAtlas(): VehicleAtlas | null {
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") {
    // Not memoised: the server pass must not poison the client's first call.
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = CELL * GLYPHS.length;
  canvas.height = CELL * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    cached = null;
    return null;
  }

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const mapping: Record<string, IconMappingEntry> = {};

  GLYPHS.forEach((glyph, col) => {
    const cx = col * CELL + CELL / 2;

    // Row 0: the casing. Same outline, dilated by a fat round stroke, no holes
    // — a keyline with the cross punched out of it would fringe the cross.
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = CASING;
    outline(ctx, glyph, cx, CELL / 2);
    ctx.fill();
    ctx.stroke();

    // Row 1: the mark itself.
    const my = CELL + CELL / 2;
    outline(ctx, glyph, cx, my);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    cutouts(ctx, glyph, cx, my);
    ctx.globalCompositeOperation = "source-over";

    mapping[casingIcon(glyph)] = cell(col, 0);
    mapping[glyphIcon(glyph)] = cell(col, 1);
  });

  cached = { url: canvas.toDataURL("image/png"), mapping };
  return cached;
}

function cell(col: number, row: number): IconMappingEntry {
  return {
    x: col * CELL,
    y: row * CELL,
    width: CELL,
    height: CELL,
    anchorX: CELL / 2,
    anchorY: CELL / 2,
    mask: true,
  };
}

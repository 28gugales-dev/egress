"use client";

import type { IconMappingEntry } from "@/components/map/vehicle-icons";

/**
 * The closure mark.
 *
 * Same construction and the same reasons as vehicle-icons.ts: drawn with
 * canvas 2D at module scope, handed to deck as a `data:image/png` atlas, pure
 * white alpha with `mask: true` so `getColor` carries the state.
 *
 * The glyph is a barrier bar — authored pointing EAST, so a call site that
 * passes `getAngle = -edgeBearing` lands it square ACROSS the road rather than
 * along it. A closure drawn along the carriageway reads as another road; drawn
 * across it, it reads as a gate, which is the thing it is.
 *
 * Two entries, drawn as two layers: `barrier-casing` underneath in near-black
 * so the mark survives dark satellite imagery, `barrier` on top tinted by the
 * closure's tier.
 */

const CELL = 128;
const CASING = 12;

export const BARRIER_ICON = "barrier";
export const BARRIER_CASING_ICON = "barrier-casing";

export interface BarrierAtlas {
  url: string;
  mapping: Record<string, IconMappingEntry>;
}

type Ctx = CanvasRenderingContext2D;

function box(ctx: Ctx, cx: number, cy: number, w: number, h: number, r: number): void {
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

function barrier(ctx: Ctx, cx: number, cy: number): void {
  ctx.beginPath();
  // The bar, plus a post at either end. The posts are what stop it reading as
  // a stray road segment when the hatching is too small to resolve.
  box(ctx, cx, cy, 92, 20, 4);
  box(ctx, cx - 46, cy, 16, 40, 4);
  box(ctx, cx + 46, cy, 16, 40, 4);
}

/** Diagonal slots through the bar — the universal "do not pass" hatching. */
function hatch(ctx: Ctx, cx: number, cy: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.beginPath();
  for (const d of [-24, 0, 24]) box(ctx, d, 0, 9, 46, 1);
  ctx.fill();
  ctx.restore();
}

let cached: BarrierAtlas | null | undefined;

/** Null with no DOM. Callers fall back to drawing closure lines alone. */
export function barrierAtlas(): BarrierAtlas | null {
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = CELL;
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

  ctx.lineWidth = CASING;
  barrier(ctx, CELL / 2, CELL / 2);
  ctx.fill();
  ctx.stroke();

  const my = CELL + CELL / 2;
  barrier(ctx, CELL / 2, my);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  hatch(ctx, CELL / 2, my);
  ctx.globalCompositeOperation = "source-over";

  cached = {
    url: canvas.toDataURL("image/png"),
    mapping: {
      [BARRIER_CASING_ICON]: entry(0),
      [BARRIER_ICON]: entry(1),
    },
  };
  return cached;
}

function entry(row: number): IconMappingEntry {
  return {
    x: 0,
    y: row * CELL,
    width: CELL,
    height: CELL,
    anchorX: CELL / 2,
    anchorY: CELL / 2,
    mask: true,
  };
}

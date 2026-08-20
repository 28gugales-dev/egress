/**
 * build-hazard-field.ts — rasterise a HazardTrack into an arrival-time grid.
 *
 *   npx tsx scripts/build-hazard-field.ts [scenarioId]
 *
 * The console renders the fire as a continuous intensity field rather than a
 * filled polygon, which needs to know, for every point on the ground, WHEN the
 * modelled front reached it. That is a distance-transform-shaped problem, and
 * doing it in the browser on every frame would cost more than the whole rest of
 * the layer stack. So it is done once here: every frame's rings are scan-line
 * filled into a shared grid, and each cell keeps the index of the FIRST frame
 * that covered it.
 *
 * The output adds no information the track did not already carry — it is the
 * same perimeter geometry in raster form, and per-frame provenance stays on
 * HazardFrame where the UI already reads it. Nothing here is modelled forward
 * of the last frame or outward of the last perimeter.
 *
 * Emitted only for `hazardKind: "wildfire"` tracks that actually carry rings. A
 * plume is a concentration footprint, not a burn front; a fire ramp over it
 * would be a lie about what the colour means.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCENARIOS } from "../src/lib/constants";
import type { HazardTrack, LngLat, ScenarioMeta } from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** Target ground resolution. The field is bilinearly upsampled on the GPU, so
 *  this sets how sharply the front can turn, not how smooth the render looks. */
const CELL_METRES = 110;

/** Grown past the final perimeter so the outer glow has somewhere to dissolve
 *  into. Without the margin the field would stop at the raster edge — which is
 *  the hard line this whole layer exists to remove. */
const PAD_METRES = 2600;

/** Ceiling on either grid axis. Payload is one byte per cell before base64. */
const MAX_DIM = 320;

/** Reserved arrival value: this cell is never inside any modelled perimeter. */
const NEVER = 255;

const METRES_PER_DEG_LAT = 111_320;

// ─────────────────────────────────────────────────────────────────────────────
// Payload
// ─────────────────────────────────────────────────────────────────────────────

export interface HazardFieldPayload {
  scenarioId: string;
  /** [west, south, east, north]. Padded past the final perimeter. */
  bbox: [number, number, number, number];
  width: number;
  height: number;
  /** Ground size of one cell, metres. Lets the renderer size its blur in real
   *  distance rather than in cells. */
  cellMetres: number;
  /** Tick of every hazard frame, in order — the index space `arrival` uses. */
  frameTicks: number[];
  /**
   * base64 of a width*height Uint8Array, ROW 0 IS NORTH (image convention, so
   * it feeds a texture without a flip). Each byte is the index of the first
   * frame whose perimeter covered that cell, or 255 for never.
   */
  arrival: string;
  source: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────

function log(stage: string, msg: string): void {
  console.log(`[field] ${stage.padEnd(11)} ${msg}`);
}

function loud(msg: string): void {
  const line = `!!! NOT EMITTED: ${msg}`;
  console.log(
    `\n${"!".repeat(Math.min(100, line.length))}\n${line}\n${"!".repeat(Math.min(100, line.length))}\n`,
  );
}

function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return from;
}

const ROOT = findRoot(process.cwd());

/**
 * Even-odd scan-line fill of one ring into `arrival`, claiming only cells no
 * earlier frame has claimed. Rings in a HazardFrame are disjoint fronts rather
 * than holes, so each is filled independently.
 */
function fillRing(
  ring: LngLat[],
  frameIndex: number,
  arrival: Uint8Array,
  geo: { west: number; north: number; dLng: number; dLat: number; width: number; height: number },
): number {
  const { west, north, dLng, dLat, width, height } = geo;

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  // Row centres run north to south, so the northern extreme is the low row.
  const rowFrom = Math.max(0, Math.floor((north - maxLat) / dLat - 0.5));
  const rowTo = Math.min(height - 1, Math.ceil((north - minLat) / dLat - 0.5));

  let claimed = 0;
  const xs: number[] = [];

  for (let row = rowFrom; row <= rowTo; row++) {
    const lat = north - (row + 0.5) * dLat;
    xs.length = 0;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      // Half-open in y so a vertex exactly on the scan line is counted once.
      if (yi > lat !== yj > lat) {
        xs.push(xi + ((lat - yi) / (yj - yi)) * (xj - xi));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    const rowBase = row * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const colFrom = Math.max(0, Math.ceil((xs[k] - west) / dLng - 0.5));
      const colTo = Math.min(width - 1, Math.floor((xs[k + 1] - west) / dLng - 0.5));
      for (let col = colFrom; col <= colTo; col++) {
        const c = rowBase + col;
        if (arrival[c] === NEVER) {
          arrival[c] = frameIndex;
          claimed++;
        }
      }
    }
  }
  return claimed;
}

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario: ScenarioMeta | undefined = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario "${scenarioId}"`);

  const dir = path.join(ROOT, "public", "data", scenario.id);
  const hazardFile = path.join(dir, "hazard.json");
  if (!existsSync(hazardFile)) {
    loud(`${scenario.id}: no hazard.json on disk. Run pnpm data:hazard first.`);
    process.exit(1);
  }

  const track = JSON.parse(await readFile(hazardFile, "utf8")) as HazardTrack;

  if (track.kind !== "wildfire") {
    loud(
      `${scenario.id}: hazard kind is "${track.kind}", not wildfire. A burn-arrival field would misrepresent it; the console keeps the polygon footprint for this scenario.`,
    );
    return;
  }
  if (track.frames.length > NEVER) {
    loud(
      `${scenario.id}: ${track.frames.length} frames exceeds the ${NEVER}-frame index space of a one-byte arrival grid.`,
    );
    process.exit(1);
  }

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let vertices = 0;
  for (const frame of track.frames) {
    for (const ring of frame.rings) {
      vertices += ring.length;
      for (const [lng, lat] of ring) {
        if (lng < west) west = lng;
        if (lng > east) east = lng;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
  }

  if (vertices === 0) {
    loud(
      `${scenario.id}: the hazard track carries no perimeter rings, so there is nothing to rasterise. The console keeps the polygon footprint for this scenario.`,
    );
    return;
  }

  const midLat = (south + north) / 2;
  const metresPerDegLng = METRES_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  const padLng = PAD_METRES / metresPerDegLng;
  const padLat = PAD_METRES / METRES_PER_DEG_LAT;
  west -= padLng;
  east += padLng;
  south -= padLat;
  north += padLat;

  const spanLngM = (east - west) * metresPerDegLng;
  const spanLatM = (north - south) * METRES_PER_DEG_LAT;
  // One cell size on both axes, so a blur radius in cells is the same distance
  // horizontally and vertically.
  const cell = Math.max(CELL_METRES, spanLngM / MAX_DIM, spanLatM / MAX_DIM);
  const width = Math.max(2, Math.round(spanLngM / cell));
  const height = Math.max(2, Math.round(spanLatM / cell));

  const geo = {
    west,
    north,
    dLng: (east - west) / width,
    dLat: (north - south) / height,
    width,
    height,
  };

  const arrival = new Uint8Array(width * height).fill(NEVER);
  let burned = 0;
  let firstBurnFrame = -1;
  for (let i = 0; i < track.frames.length; i++) {
    let claimed = 0;
    for (const ring of track.frames[i].rings) {
      if (ring.length >= 3) claimed += fillRing(ring, i, arrival, geo);
    }
    if (claimed > 0 && firstBurnFrame < 0) firstBurnFrame = i;
    burned += claimed;
  }

  const payload: HazardFieldPayload = {
    scenarioId: scenario.id,
    bbox: [west, south, east, north],
    width,
    height,
    cellMetres: Math.round(cell),
    frameTicks: track.frames.map((f) => f.t),
    arrival: Buffer.from(arrival).toString("base64"),
    source: `rasterised from hazard.json (${track.source})`,
    generatedAt: new Date().toISOString(),
  };

  await mkdir(dir, { recursive: true });
  const outFile = path.join(dir, "hazard-field.json");
  const json = JSON.stringify(payload);
  await writeFile(outFile, json, "utf8");

  const observed = track.frames.filter((f) => f.provenance === "observed").length;
  log(
    "grid",
    `${width} x ${height} cells at ${Math.round(cell)} m — ${(width * height).toLocaleString("en-US")} cells`,
  );
  log(
    "extent",
    `${(spanLngM / 1000).toFixed(1)} x ${(spanLatM / 1000).toFixed(1)} km, padded ${PAD_METRES} m past the final perimeter`,
  );
  log(
    "arrival",
    `${burned.toLocaleString("en-US")} cells burn (${((burned / (width * height)) * 100).toFixed(1)}%), first at frame ${firstBurnFrame} (T+${track.frames[firstBurnFrame]?.t ?? 0}s)`,
  );
  log(
    "provenance",
    `${observed} of ${track.frames.length} source frames observed — unchanged, the field re-renders the same geometry`,
  );
  log("write", `${outFile} — ${Buffer.byteLength(json).toLocaleString("en-US")} bytes`);
}

main().catch((err) => {
  console.error("[field] FAILED:", err);
  process.exit(1);
});

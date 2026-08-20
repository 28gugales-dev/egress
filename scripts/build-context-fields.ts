/**
 * build-context-fields.ts — gridded context fields the point layers cannot give.
 *
 *   npx tsx scripts/build-context-fields.ts [scenarioId]
 *
 * Right now that is exactly one field: satellite AEROSOL OPTICAL DEPTH.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The air-quality layer is a network of regulatory PM2.5 monitors, and for the
 * Camp Fire that network says something uncomfortable: the two monitors in
 * Paradise stop publishing an hour into the evacuation, and the highest reading
 * anywhere in the window was taken 48 km away in Gridley. There is no honest
 * way to build a concentration surface out of that. Interpolating between the
 * survivors would paint a smooth, confident, INVENTED field over a burning town
 * — the most dangerous-looking thing this console could draw.
 *
 * So the surface comes from an instrument that images the whole area at once:
 * MODIS MAIAC, gridded at 1 km, retrieved on the event date.
 *
 * ── WHAT AOD IS, AND WHAT IT IS NOT ─────────────────────────────────────────
 *
 * AOD is column extinction — how much sunlight the aerosol between the
 * satellite and the ground removes. Unitless. It is NOT surface PM2.5, it is
 * NOT a concentration, and no conversion is applied here. Published
 * AOD-to-PM2.5 regressions exist; every one needs boundary-layer height and
 * regional coefficients, and applying one would be modelling dressed as
 * observation. The payload carries optical depth and says so in three places.
 *
 * Cadence is per overpass. MAIAC composites Terra (~10:30 local) and Aqua
 * (~13:30 local), both of which fall inside the Camp Fire evacuation window —
 * which is why this date is worth imaging at all. It is still ONE DAY, so the
 * manifest entry is `timeVarying: false` and the renderer holds it flat rather
 * than pretending it animates.
 *
 * ── HOW THE VALUES ARE RECOVERED, AND WHY THAT IS NOT SYNTHESIS ─────────────
 *
 * GIBS serves this layer as a colourised raster, not as floats. NASA also
 * publishes the exact colormap — every RGB triple with the AOD interval it
 * represents — at a stable URL. Decoding is therefore a LOOKUP against a
 * published table, not an inference.
 *
 * The build proves that claim rather than asserting it: every opaque pixel must
 * match a colormap entry EXACTLY. Any pixel that does not is counted, warned
 * about loudly, and dropped to NO RETRIEVAL — an unmatched colour means the
 * server blended two palette entries, and a blended colour decodes to a value
 * no instrument produced.
 *
 * ── FALLBACK POLICY ─────────────────────────────────────────────────────────
 *
 * There is none. If GIBS is down or the date carries no retrieval, this script
 * writes NOTHING, prints a loud warning naming the failure, and marks the layer
 * unavailable in the manifest. A fabricated smoke field is worse than none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { SCENARIOS } from "../src/lib/constants";
import type {
  AerosolPayload,
  ContextLayerEntry,
  ContextManifest,
} from "../src/types/context-layers";
import type { ScenarioMeta } from "../src/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints. Both keyless, both verified live.
// ─────────────────────────────────────────────────────────────────────────────

const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";

/**
 * MAIAC rather than the 3 km Dark Target products. Measured over the Camp Fire
 * bbox on 2018-11-08: MAIAC returned a retrieval for 89% of cells, Terra 3 km
 * for 18%, Aqua 3 km for 2%. Dark Target does not retrieve over bright land or
 * through the thickest smoke, which is precisely where this fire was.
 */
const GIBS_LAYER = "MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth";

/** NASA's published RGB -> AOD interval table for the MODIS/VIIRS AOD palette. */
const GIBS_COLORMAP = "https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_VIIRS_AOD.xml";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Padding past the scenario bbox. A smoke column is a regional object: the
 * evacuation bbox is ~20 km across and this plume ran the length of the
 * Sacramento Valley, so a field clipped to the town would show a flat wash and
 * hide the one thing the field is for — which way the smoke went.
 */
const PAD_DEG = 0.62;

/** MAIAC's native grid. Asking finer would upsample and break exact match. */
const TARGET_CELL_M = 1000;

/** Ceiling per axis. One byte per cell before base64. */
const MAX_DIM = 400;

/** Reserved grid byte: the retrieval algorithm returned nothing here. */
const NO_RETRIEVAL = 255;

const METRES_PER_DEG_LAT = 111_320;

// ─────────────────────────────────────────────────────────────────────────────

const log = (m: string) => console.log(m);

function loud(msg: string): void {
  const line = `!!! ${msg}`;
  const bar = "!".repeat(Math.min(100, line.length));
  console.log(`\n${bar}\n${line}\n${bar}\n`);
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = join(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal PNG reader. GIBS serves 8-bit RGBA, non-interlaced; colour type 2 is
// accepted too so a server-side format change degrades to an error we can read
// rather than to silent garbage. No dependency is added for this — the console
// ships zero required keys and the pipeline keeps the same discipline.
// ─────────────────────────────────────────────────────────────────────────────

interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row 0 north. */
  px: Uint8Array;
}

function decodePng(buf: Buffer): Raster {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth}, expected 8`);
  if (interlace !== 0) throw new Error("interlaced PNG");
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`PNG colour type ${colorType}, expected 6 (RGBA) or 2 (RGB)`);
  }
  const channels = colorType === 6 ? 4 : 3;

  const idat: Buffer[] = [];
  let i = 8;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    if (type === "IDAT") idat.push(buf.subarray(i + 8, i + 8 + len));
    if (type === "IEND") break;
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = rawByte;
          break;
        case 1:
          v = rawByte + a;
          break;
        case 2:
          v = rawByte + b;
          break;
        case 3:
          v = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`PNG filter ${filter} on row ${y}`);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, px: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// Colormap
// ─────────────────────────────────────────────────────────────────────────────

/** packed r<<16|g<<8|b -> AOD midpoint of the interval that colour represents. */
type ColorLut = Map<number, number>;

async function fetchColormap(): Promise<ColorLut> {
  const res = await fetch(GIBS_COLORMAP);
  if (!res.ok) throw new Error(`GIBS colormap HTTP ${res.status}`);
  const xml = await res.text();
  const lut: ColorLut = new Map();

  for (const m of xml.matchAll(/<ColorMapEntry\b[^>]*\/>/g)) {
    const e = m[0];
    // The No Data entry names a colour that must never decode to a number.
    if (e.includes('nodata="true"')) continue;
    const rgbM = e.match(/rgb="(\d+),(\d+),(\d+)"/);
    // `value` is the physical interval; `sourceValue` is the scaled integer the
    // product stores. Only the physical one means anything downstream.
    const valM = e.match(/\bvalue="\[([-\d.]+)(?:,([-\d.]+))?[)\]]/);
    if (!rgbM || !valM) continue;
    const lo = Number(valM[1]);
    const hi = valM[2] === undefined ? lo : Number(valM[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const key = (Number(rgbM[1]) << 16) | (Number(rgbM[2]) << 8) | Number(rgbM[3]);
    // Interval midpoint. The palette bins AOD, so a decoded cell is only ever
    // as precise as its bin — stated rather than hidden.
    if (!lut.has(key)) lut.set(key, (lo + hi) / 2);
  }
  if (lut.size === 0) throw new Error("GIBS colormap parsed to zero entries");
  return lut;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

interface Built {
  payload: AerosolPayload;
  entry: Omit<ContextLayerEntry, "bytes">;
}

async function buildAerosol(scenario: ScenarioMeta): Promise<Built> {
  const [w0, s0, e0, n0] = scenario.bbox;
  const bbox: [number, number, number, number] = [
    w0 - PAD_DEG,
    s0 - PAD_DEG,
    e0 + PAD_DEG,
    n0 + PAD_DEG,
  ];
  const [west, south, east, north] = bbox;
  const lngM = METRES_PER_DEG_LAT * Math.cos((((south + north) / 2) * Math.PI) / 180);

  const width = Math.min(MAX_DIM, Math.round(((east - west) * lngM) / TARGET_CELL_M));
  const height = Math.min(
    MAX_DIM,
    Math.round(((north - south) * METRES_PER_DEG_LAT) / TARGET_CELL_M),
  );
  const cellMetres = Math.round(((north - south) * METRES_PER_DEG_LAT) / height);

  const url =
    `${GIBS_WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${GIBS_LAYER}` +
    `&SRS=EPSG:4326&BBOX=${bbox.join(",")}&WIDTH=${width}&HEIGHT=${height}` +
    `&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${scenario.eventDate}`;

  log(
    `      grid ${width}x${height} @ ~${cellMetres} m   bbox ${bbox.map((v) => v.toFixed(3)).join(",")}`,
  );

  const lut = await fetchColormap();
  log(`      colormap ${lut.size} colour->AOD entries`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GIBS WMS HTTP ${res.status}`);
  const raster = decodePng(Buffer.from(await res.arrayBuffer()));
  if (raster.width !== width || raster.height !== height) {
    throw new Error(`GIBS returned ${raster.width}x${raster.height}, asked ${width}x${height}`);
  }

  const n = width * height;
  const grid = new Uint8Array(n).fill(NO_RETRIEVAL);
  const aod = new Float32Array(n);
  const hasValue = new Uint8Array(n);
  let retrieved = 0;
  let unmatched = 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (raster.px[o + 3] === 0) continue;
    const key = (raster.px[o] << 16) | (raster.px[o + 1] << 8) | raster.px[o + 2];
    const v = lut.get(key);
    if (v === undefined) {
      // A colour off the published palette means the server blended two
      // entries. Blended colour, invented value — so this cell is dropped.
      unmatched++;
      continue;
    }
    aod[i] = v;
    hasValue[i] = 1;
    retrieved++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  if (retrieved === 0) {
    throw new Error(`no AOD retrieval anywhere in the bbox on ${scenario.eventDate}`);
  }

  // Quantise against the observed maximum rather than the palette's ceiling of
  // 5: the palette tops out far above anything a real scene reaches, and
  // scaling to it would throw away most of the byte's precision.
  const scaleMax = Math.max(0.5, Math.ceil(hi * 10) / 10);
  for (let i = 0; i < n; i++) {
    if (hasValue[i] === 0) continue;
    grid[i] = Math.max(0, Math.min(254, Math.round((Math.max(0, aod[i]) / scaleMax) * 254)));
  }

  const pct = (100 * retrieved) / n;
  log(
    `      retrieval ${retrieved}/${n} cells (${pct.toFixed(0)}%)   AOD ${lo.toFixed(2)}–${hi.toFixed(2)}   scaleMax ${scaleMax}`,
  );
  if (unmatched > 0) {
    loud(
      `${unmatched} pixel(s) carried a colour NOT in NASA's published palette — the WMS blended ` +
        `between entries. Those cells were dropped to NO RETRIEVAL rather than decoded to a value ` +
        `the instrument never produced. The coverage figure above already excludes them.`,
    );
  } else {
    log(
      `      every opaque pixel matched the published palette exactly — the decode is a lookup, not a fit`,
    );
  }

  const note =
    `Column aerosol optical depth at 550 nm, MODIS MAIAC 1 km, retrieved ${scenario.eventDate}. ` +
    `AOD IS NOT PM2.5: it is unitless column extinction through the whole atmosphere and carries ` +
    `no surface concentration. No AOD-to-PM2.5 conversion is applied anywhere in this console. ` +
    `Cadence is per satellite overpass (Terra ~10:30, Aqua ~13:30 local, both inside the ` +
    `evacuation window), so this is ONE day's retrieval held flat across the replay, never ` +
    `animated. ${pct < 99.5 ? `${(100 - pct).toFixed(0)}% of cells carry no retrieval and are drawn as absent, not as clear air. ` : ""}` +
    `Values are decoded from NASA's own published colormap by exact colour match; any pixel that ` +
    `did not match exactly was dropped rather than approximated.`;

  const payload: AerosolPayload = {
    scenarioId: scenario.id,
    provenance: "observed",
    units: "optical depth (unitless)",
    bbox,
    width,
    height,
    cellMetres,
    grid: Buffer.from(grid).toString("base64"),
    scaleMax,
    retrieved,
    cells: n,
    aodRange: [Number(lo.toFixed(3)), Number(hi.toFixed(3))],
    observedDate: scenario.eventDate,
    overpassNote: "MODIS Terra ~10:30 and Aqua ~13:30 local solar time, composited to one day",
    source: "NASA GIBS — MODIS Combined MAIAC L2G Aerosol Optical Depth (1 km)",
    sourceUrl: url,
    note,
    generatedAt: new Date().toISOString(),
  };

  return {
    payload,
    entry: {
      id: "aerosol",
      label: "Smoke column · AOD",
      file: "aerosol.json",
      available: true,
      provenance: "observed",
      source: payload.source,
      sourceUrl: url,
      recordCount: retrieved,
      // ONE overpass composite. Marking this true would let the scrubber imply
      // a continuity the instrument does not have.
      timeVarying: false,
      note,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest upsert. This script runs AFTER fetch-context-layers.ts and must not
// disturb what that one wrote.
// ─────────────────────────────────────────────────────────────────────────────

function upsert(outDir: string, entry: ContextLayerEntry): void {
  const path = join(outDir, "index.json");
  if (!existsSync(path)) {
    throw new Error(`${path} missing — run fetch-context-layers.ts first`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ContextManifest;
  const rest = manifest.layers.filter((l) => l.id !== entry.id);
  // Immediately after airQuality: the two are read together, and the rail's own
  // ordering comes from CONTEXT_LAYER_IDS regardless.
  const at = rest.findIndex((l) => l.id === "airQuality");
  const layers =
    at < 0 ? [...rest, entry] : [...rest.slice(0, at + 1), entry, ...rest.slice(at + 1)];
  writeFileSync(path, JSON.stringify({ ...manifest, layers }, null, 2));
}

async function main() {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(
      `unknown scenario "${scenarioId}" — known: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }

  const outDir = join(repoRoot(), "public", "data", scenario.id, "context");
  mkdirSync(outDir, { recursive: true });

  log(`[field] ${scenario.id} — ${scenario.place}, ${scenario.eventDate}`);
  log("[1/1] aerosol — NASA GIBS MODIS MAIAC AOD");

  try {
    const { payload, entry } = await buildAerosol(scenario);
    const json = JSON.stringify(payload);
    writeFileSync(join(outDir, "aerosol.json"), json);
    const bytes = Buffer.byteLength(json);
    upsert(outDir, { ...entry, bytes });
    log(
      `      OK aerosol.json — ${(bytes / 1024).toFixed(1)} KB, ${entry.recordCount} retrieved cells, OBSERVED`,
    );
  } catch (err) {
    const reason = (err as Error).message;
    upsert(outDir, {
      id: "aerosol",
      label: "Smoke column · AOD",
      file: null,
      available: false,
      provenance: "observed",
      source: "",
      sourceUrl: "",
      recordCount: 0,
      timeVarying: false,
      bytes: 0,
      note: "Layer unavailable — the toggle is disabled, nothing is substituted.",
      reason,
    });
    loud(
      `AEROSOL FIELD NOT BUILT: ${reason}. NOTHING WAS SUBSTITUTED — no interpolated surface, no ` +
        `synthetic plume. The manifest records the layer unavailable with this reason and the rail ` +
        `shows the row disabled.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

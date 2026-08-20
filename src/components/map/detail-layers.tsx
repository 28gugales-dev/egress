"use client";

import type { Color, Layer, PickingInfo } from "@deck.gl/core";
import { PolygonLayer, TextLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "react-map-gl/maplibre";
import type {
  BuildingInspection,
  BuildingSeverityIndex,
  DetailBundleWithSeverity,
} from "@/components/map/building-severity";
import {
  buildingFillColor,
  buildingLineColor,
  SEVERITY_PROVENANCE,
  severityAt,
  severityBand,
  severityFrame,
  severityIndexFor,
  severityStateAt,
  severityStateLabel,
  severitySwatch,
} from "@/components/map/building-severity";
import { useHazardField } from "@/components/map/hazard-field";
import { asset } from "@/lib/base-path";
import { ZONE_STATUS_RGB } from "@/lib/constants";
import type {
  BlocksPayload,
  BuildingHazardState,
  BuildingsPayload,
  DetailBlock,
  DetailBuilding,
  DetailBundle,
} from "@/types/detail-layers";
import { DETAIL_FILES } from "@/types/detail-layers";
import type { EvacPlan, LayerVisibility, RoadNetwork, Tick, ZoneLayer } from "@/types/egress";

/**
 * Street-, block- and structure-level detail.
 *
 * ── Integration point ───────────────────────────────────────────────────────
 *
 * These layers belong in the SAME MapboxOverlay as everything else — a second
 * overlay would get its own depth buffer and buildings would paint through
 * ridgelines. So `DeckOverlay` in ./deck-layers.tsx composes them, exactly the
 * way it already composes the context layers. Inside `DeckOverlay`, beside the
 * existing `useContextBundle(scenarioId)`:
 *
 *     const { detail, zoom } = useDetailState(scenarioId);
 *     const detailBuilt = useMemo(
 *       () => buildDetailLayers({
 *         detail, zoom, t, layers,
 *         network: bundle?.network ?? null,
 *         zones: bundle?.zones ?? null,
 *         plan: run?.plan ?? null,
 *         idPrefix, interactive,
 *       }),
 *       [detail, zoom, t, layers, bundle, run, idPrefix, interactive],
 *     );
 *
 * then widen the two lines that already merge the stacks:
 *
 *     const allLayers = [...contextBuilt, ...detailBuilt, ...built];
 *     getTooltip: (i) => deckTooltip(i) ?? contextTooltip(i) ?? detailTooltip(i)
 *
 * Detail belongs between context and the core stack: it is the substrate the
 * zone polygons and flow lines sit on, not a decoration over them. This exact
 * wiring was applied, screenshotted at z15.6 over Paradise, and reverted —
 * deck-layers.tsx is another module's file.
 *
 * ── Why the zoom gate is not optional ───────────────────────────────────────
 *
 * camp-fire-2018 carries 31,233 structures. Tessellating those at z11, where
 * each one is a quarter of a pixel, costs frames and buys nothing legible. The
 * layers therefore stay MOUNTED at all zooms — deck keeps their state and the
 * attribute buffers survive — but their `data` is empty until one zoom level
 * before the gate and `visible` flips at the gate itself. Crossing z14 hands
 * deck an array it already tessellated at z13, so the buildings appear on the
 * next frame rather than after a stall.
 *
 * ── Why the colour accessors do not rebuild per tick ────────────────────────
 *
 * The scrubber writes `t` at up to 30fps and hazard state is a function of `t`.
 * Rebuilding 31k datums that often would be absurd, so `data` is the payload's
 * own array — one stable reference for the life of the payload — and the
 * per-tick part lives entirely in the accessors, re-evaluated only when the
 * quantized tick in `updateTriggers` moves. The quantum is the simulation frame
 * step, which is also the finest resolution the underlying run actually has.
 *
 * The building ramp goes further: the whole severity-by-frame cube is built
 * ONCE per payload in ./building-severity.ts, so the accessor is one indexed
 * read into a Uint8Array plus a lookup into a shared colour table. Nothing is
 * computed per structure per frame. `updateTriggers` therefore keys off the
 * frame index and the cube's identity — not raw `t`, and not the payload,
 * because the cube gains its exposure term only once the hazard field lands.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zoom at which each layer becomes visible.
 *
 * Blocks first: a block is a city-block-sized polygon and reads as structure,
 * not clutter, from z13. Buildings and street names both wait for z14, which is
 * where a 12 m footprint clears one screen pixel and a street name has room to
 * sit along its own centreline.
 */
export const DETAIL_ZOOM = {
  blocks: 13,
  buildings: 14,
  streetLabels: 14,
} as const;

/** Data is handed over this far below the gate so the tessellation is already
 *  done when the layer becomes visible. */
const PRELOAD_LEAD = 1;

/** Zoom is quantized to this before it reaches React. A pinch-zoom fires
 *  hundreds of events; only the ones that cross a gate matter. */
const ZOOM_STEP = 0.5;

/** A structure with the hazard this close is `threatened`. Half an hour is the
 *  window in which a household can still be moved, which is what makes it a
 *  different colour rather than a different shade. */
const THREAT_WINDOW: Tick = 1800;

/** Street names repeat along their whole length; one label per name per this
 *  many metres is the difference between a map and a word cloud. */
const LABEL_SPACING_M = 650;

/** Hard cap on drawn street labels. Past this the screen is full anyway. */
const LABEL_BUDGET = 500;

const NEUTRAL_RGB = ZONE_STATUS_RGB.held;

const EMPTY_BUILDINGS: DetailBuilding[] = [];
const EMPTY_BLOCKS: DetailBlock[] = [];
const EMPTY_LABELS: StreetLabel[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Payload loading
//
// data.ts owns the core bundle and is deliberately not touched: detail is
// optional, it is 7 MB, and loading it with the console would make the first
// paint wait on something nobody has zoomed in far enough to see. Same cache +
// inflight shape as data.ts, scoped to this module.
// ─────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, DetailBundle>();
const inflight = new Map<string, Promise<DetailBundle>>();
/* Per-file, because the two payloads now arrive on different gates and the
   whole-bundle cache above cannot represent "blocks in, buildings not yet". */
const partCache = new Map<string, unknown>();
const partInflight = new Map<string, Promise<unknown>>();

async function fetchDetailFile<T>(scenarioId: string, file: string): Promise<T | null> {
  try {
    const res = await fetch(asset(`/data/${scenarioId}/detail/${file}`), { cache: "force-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Load one detail payload, on its OWN zoom gate.
 *
 * These used to be fetched together under the shallower of the two gates,
 * which meant camp-fire's 7.4 MB buildings.json arrived at z12 -- two whole
 * levels before a building is drawn, and at the scenario's own authored zoom
 * of 12.2, so it landed during first paint on every cold load. blocks.json is
 * 2.2 MB and genuinely is wanted at z13. Splitting them keeps the preload lead
 * for each layer and stops the deeper one riding in on the shallower one's
 * gate.
 */
async function loadOne<T>(
  scenarioId: string,
  file: string,
  slot: "buildings" | "blocks",
): Promise<T | null> {
  const key = `${scenarioId}:${slot}`;
  if (partCache.has(key)) return partCache.get(key) as T | null;
  const pending = partInflight.get(key);
  if (pending) return pending as Promise<T | null>;
  const p = fetchDetailFile<T>(scenarioId, file).then((v) => {
    partCache.set(key, v);
    partInflight.delete(key);
    return v;
  });
  partInflight.set(key, p as Promise<unknown>);
  return p;
}

export async function loadDetail(scenarioId: string): Promise<DetailBundle> {
  const hit = cache.get(scenarioId);
  if (hit) return hit;
  const pending = inflight.get(scenarioId);
  if (pending) return pending;

  const p = (async () => {
    const [buildings, blocks] = await Promise.all([
      fetchDetailFile<BuildingsPayload>(scenarioId, DETAIL_FILES.buildings),
      fetchDetailFile<BlocksPayload>(scenarioId, DETAIL_FILES.blocks),
    ]);
    // A missing payload disables one toggle. It is never a load failure, and it
    // never reaches the shell's error path — the console works without detail.
    if (!buildings) {
      console.warn(
        `[detail] ${scenarioId}: buildings.json absent — the structure layer is EMPTY. ` +
          `Run: pnpm data:buildings ${scenarioId}`,
      );
    }
    if (!blocks) {
      console.warn(
        `[detail] ${scenarioId}: blocks.json absent — the census block layer is EMPTY. ` +
          `Run: pnpm data:blocks ${scenarioId}`,
      );
    }
    const bundle: DetailBundle = {
      buildings: buildings && Array.isArray(buildings.buildings) ? buildings : null,
      blocks: blocks && Array.isArray(blocks.blocks) ? blocks : null,
    };
    cache.set(scenarioId, bundle);
    return bundle;
  })().finally(() => {
    inflight.delete(scenarioId);
  });

  inflight.set(scenarioId, p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current view zoom, quantized.
 *
 * Deliberately NOT in the egress store: zoom is a property of one map instance
 * and the split view mounts two, so a single global value would make the two
 * panes gate each other. Local state, per instance, sourced from the MapLibre
 * instance this component is a child of.
 */
export function useMapZoom(step: number = ZOOM_STEP): number {
  const { current: ref } = useMap();
  const [zoom, setZoom] = useState(() => (ref ? quantize(ref.getZoom(), step) : 0));

  useEffect(() => {
    if (!ref) return;
    const map = ref.getMap();
    const sync = () => {
      const next = quantize(map.getZoom(), step);
      setZoom((prev) => (prev === next ? prev : next));
    };
    sync();
    map.on("zoom", sync);
    map.on("move", sync);
    return () => {
      map.off("zoom", sync);
      map.off("move", sync);
    };
  }, [ref, step]);

  return zoom;
}

function quantize(z: number, step: number): number {
  return Math.round(z / step) * step;
}

/**
 * Everything `buildDetailLayers` needs that is not already in `DeckOverlay`.
 * One hook so the integration is one line.
 *
 * The severity cube is attached HERE rather than passed in, because the caller
 * that composes this stack owns its own file and cannot be given a new
 * argument. Attaching it produces a fresh bundle reference the moment the
 * hazard field lands, which is what re-triggers the caller's `useMemo` — a
 * mutation in place would leave every structure at its field-less colour until
 * the operator happened to scrub.
 */
export function useDetailState(scenarioId: string): {
  detail: DetailBundleWithSeverity | null;
  zoom: number;
} {
  const zoom = useMapZoom();
  const [detail, setDetail] = useState<DetailBundle | null>(() => cache.get(scenarioId) ?? null);
  const wanted = useRef(false);
  /* Shared module-level cache with the hazard layer: this is the same decoded
     grid, not a second fetch. Null for a scenario with no field on disk, which
     drops the exposure term and keeps the arrival one. */
  const field = useHazardField(scenarioId);

  /* One gate per payload, not one for both. The shared gate was the shallower
     of the two, so buildings.json rode in on blocks' threshold: 7.4 MB at z12,
     while camp-fire opens at 12.2 and the structure layer does not draw until
     z14. Panning at overview zoom now pulls neither. */
  const wantBlocks = zoom >= DETAIL_ZOOM.blocks - PRELOAD_LEAD;
  const wantBuildings = zoom >= DETAIL_ZOOM.buildings - PRELOAD_LEAD;

  useEffect(() => {
    wanted.current = false;
    setDetail(cache.get(scenarioId) ?? null);
  }, [scenarioId]);

  useEffect(() => {
    if (!wantBlocks && !wantBuildings) return;
    let live = true;
    (async () => {
      const [blocks, buildings] = await Promise.all([
        wantBlocks ? loadOne<BlocksPayload>(scenarioId, DETAIL_FILES.blocks, "blocks") : null,
        wantBuildings
          ? loadOne<BuildingsPayload>(scenarioId, DETAIL_FILES.buildings, "buildings")
          : null,
      ]);
      if (!live) return;
      // Warn once per payload, and only once it was actually asked for -- a
      // console warning about a file nobody has zoomed far enough to need is
      // noise, not a finding.
      if (wantBlocks && !blocks) {
        console.warn(
          `[detail] ${scenarioId}: blocks.json absent — the census block layer is EMPTY. ` +
            `Run: pnpm data:blocks ${scenarioId}`,
        );
      }
      if (wantBuildings && !buildings) {
        console.warn(
          `[detail] ${scenarioId}: buildings.json absent — the structure layer is EMPTY. ` +
            `Run: pnpm data:buildings ${scenarioId}`,
        );
      }
      setDetail({
        buildings: buildings && Array.isArray(buildings.buildings) ? buildings : null,
        blocks: blocks && Array.isArray(blocks.blocks) ? blocks : null,
      });
    })();
    return () => {
      live = false;
    };
  }, [wantBlocks, wantBuildings, scenarioId]);

  const withSeverity = useMemo<DetailBundleWithSeverity | null>(() => {
    if (!detail) return null;
    return {
      ...detail,
      severity: detail.buildings ? severityIndexFor(detail.buildings, field) : null,
    };
  }, [detail, field]);

  return { detail: withSeverity, zoom };
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour
// ─────────────────────────────────────────────────────────────────────────────

function rgba(c: readonly [number, number, number], alpha: number): Color {
  return [c[0], c[1], c[2], alpha];
}

/**
 * Coarse three-state classification of one structure.
 *
 * The buildings layer no longer colours from this — a structure carries the
 * graded severity ramp in ./building-severity.ts, which distinguishes twenty
 * minutes from two hours where this cannot. It is kept because it is this
 * module's public three-state vocabulary and non-map callers read it: a list
 * row does not need 256 bands, it needs a word.
 */
export function buildingHazardState(b: DetailBuilding, t: Tick): BuildingHazardState {
  if (b.h === null) return "safe";
  if (t >= b.h) return "overrun";
  return b.h - t <= THREAT_WINDOW ? "threatened" : "safe";
}

// ─────────────────────────────────────────────────────────────────────────────
// Street labels — derived from the road network already in the bundle, so
// there is no third payload to fetch and no name that disagrees with the edge
// the congestion layer is drawing.
// ─────────────────────────────────────────────────────────────────────────────

interface StreetLabel {
  name: string;
  position: [number, number];
  /** Screen-space angle of the street, degrees CCW, kept upright. */
  angle: number;
}

/** Rank by how much a driver needs the name. A motorway shield matters more
 *  than a cul-de-sac, and the budget runs out from the bottom. */
const CLASS_RANK: Record<string, number> = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  residential: 5,
  unclassified: 6,
  service: 7,
};

function buildStreetLabels(network: RoadNetwork): StreetLabel[] {
  const named = network.edges.filter((e) => e.name && e.geometry.length >= 2);
  named.sort(
    (a, b) =>
      (CLASS_RANK[a.roadClass] ?? 9) - (CLASS_RANK[b.roadClass] ?? 9) || b.length - a.length,
  );

  const placed = new Map<string, [number, number][]>();
  const out: StreetLabel[] = [];
  const spacingDeg = LABEL_SPACING_M / 111320;

  for (const edge of named) {
    if (out.length >= LABEL_BUDGET) break;
    const g = edge.geometry;
    const mid = g[Math.floor(g.length / 2)];
    const prev = g[Math.max(0, Math.floor(g.length / 2) - 1)];
    const name = edge.name as string;

    const near = placed.get(name);
    if (near) {
      const scale = Math.cos((mid[1] * Math.PI) / 180);
      let clash = false;
      for (const [px, py] of near) {
        if (Math.hypot((px - mid[0]) * scale, py - mid[1]) < spacingDeg) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      near.push([mid[0], mid[1]]);
    } else {
      placed.set(name, [[mid[0], mid[1]]]);
    }

    // Longitude degrees shrink with latitude; without the cosine every
    // east-west street would be labelled at the wrong slant.
    const dx = (mid[0] - prev[0]) * Math.cos((mid[1] * Math.PI) / 180);
    const dy = mid[1] - prev[1];
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;

    out.push({ name, position: [mid[0], mid[1]], angle });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover context
//
// A building datum is the raw payload record — 31k of them, and giving each one
// a `_k` discriminator and a back-pointer to its zone would add megabytes of
// duplicated strings to the heap. The tooltip needs zone label, wave and plan
// context that live one level up, so those are stashed here and read back by
// `detailTooltip`. Keyed by the caller's id PREFIX rather than by a layer id:
// one entry serves every detail layer in a stack, so a tooltip does not go
// stale when a sibling toggle is switched off — and the split view's two
// stacks, which carry different prefixes, still cannot read each other's.
// ─────────────────────────────────────────────────────────────────────────────

interface HoverContext {
  t: Tick;
  zoneLabel: Map<string, string>;
  zoneWave: Map<string, number>;
  waveCount: number;
  imageryVintage: string;
  blockVintage: number;
  /** Null until the payload lands; every severity reading goes through it. */
  severity: BuildingSeverityIndex | null;
}

const HOVER = new Map<string, HoverContext>();

// ─────────────────────────────────────────────────────────────────────────────
// buildDetailLayers — pure, same contract as buildLayers, so the split view can
// drive two stacks from one payload.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildDetailLayersArgs {
  /** Null until the payloads land. Returns an empty stack, never throws. */
  detail: DetailBundleWithSeverity | null;
  /** Current view zoom. Every gate in this module keys off it. */
  zoom: number;
  t: Tick;
  layers: LayerVisibility;
  /** Street names come off the road network, not a fourth payload. */
  network: RoadNetwork | null;
  /** Supplies zone labels for the hover. */
  zones: ZoneLayer | null;
  /** Supplies the release wave a structure's zone belongs to. */
  plan: EvacPlan | null;
  /** Split view renders two stacks; ids must not collide between them. */
  idPrefix?: string;
  /** Split panes switch picking off on the pane that is not focused. */
  interactive?: boolean;
}

export function buildDetailLayers(args: BuildDetailLayersArgs): Layer[] {
  const { detail, zoom, t, layers, network, zones, plan } = args;
  const prefix = args.idPrefix ? `${args.idPrefix}-` : "";
  const pick = args.interactive !== false;
  const out: Layer[] = [];

  const zoneLabel = new Map<string, string>();
  for (const z of zones?.zones ?? []) zoneLabel.set(z.id, z.label);

  const zoneWave = new Map<string, number>();
  const waves = plan?.waves ?? [];
  for (const w of waves) for (const id of w.zoneIds) zoneWave.set(id, w.wave);

  // Severity is defined per simulation frame, so the accessors only need to
  // re-run when the frame does — not on every scrubber write. `frame` is
  // clamped onto the cube's axis; `tBucket` is not, so burn age keeps ageing
  // even if the playhead ever runs past the last frame.
  const severity = detail?.severity ?? null;
  const step = severity?.step ?? 300;
  const frame = severity ? severityFrame(severity, t) : 0;
  const tBucket = Math.floor(t / step) * step;

  // Written before any layer is built, and under a prefix key rather than a
  // layer id, so the block tooltip can still read the playhead when the
  // buildings layer is switched off. Keying it to the buildings layer made a
  // block's "hazard in …" count down from T+0 the moment that toggle went dark.
  HOVER.set(`${prefix}detail`, {
    t,
    zoneLabel,
    zoneWave,
    waveCount: waves.length,
    imageryVintage: detail?.buildings?.imageryVintage ?? "unknown",
    blockVintage: detail?.blocks?.vintage ?? 0,
    severity,
  });

  // ── blocks ────────────────────────────────────────────────────────────────
  if (layers.blocks) {
    const ready = zoom >= DETAIL_ZOOM.blocks - PRELOAD_LEAD;
    const blocks = detail?.blocks;
    const data = ready && blocks ? blocks.blocks : EMPTY_BLOCKS;
    // Population per block spans three orders of magnitude, so a linear ramp
    // would show one dense block and 1,400 empty ones. sqrt is the standard
    // fix and it is a shade, not a hue: the mesh stays chrome-neutral.
    const peak = Math.sqrt(
      Math.max(1, blocks ? blocks.blocks.reduce((m, b) => (b.pop > m ? b.pop : m), 0) : 1),
    );

    out.push(
      new PolygonLayer<DetailBlock>({
        id: `${prefix}detail-blocks`,
        data,
        visible: zoom >= DETAIL_ZOOM.blocks,
        pickable: pick,
        filled: true,
        stroked: true,
        extruded: false,
        positionFormat: "XY",
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0.7,
        getLineWidth: 0.7,
        getPolygon: getBlockPolygon,
        getFillColor: (d: DetailBlock) =>
          rgba(
            NEUTRAL_RGB,
            d.pop === 0 ? 0 : Math.round(10 + 46 * Math.min(1, Math.sqrt(d.pop) / peak)),
          ),
        getLineColor: rgba(NEUTRAL_RGB, 120),
        updateTriggers: { getFillColor: [peak] },
      }),
    );
  }

  // ── street labels ─────────────────────────────────────────────────────────
  if (layers.streetLabels) {
    const ready = zoom >= DETAIL_ZOOM.streetLabels - PRELOAD_LEAD;
    const data = ready && network ? streetLabelsFor(network) : EMPTY_LABELS;
    out.push(
      new TextLayer<StreetLabel>({
        id: `${prefix}detail-street-labels`,
        data,
        visible: zoom >= DETAIL_ZOOM.streetLabels,
        pickable: false,
        characterSet: "auto",
        // SDF glyphs are what make the halo work; without it a white label over
        // pale roof imagery is unreadable and a dark one over shadow is too.
        fontSettings: { sdf: true, fontSize: 56, radius: 12, buffer: 6 },
        // A CSS custom property cannot be resolved here: deck builds the glyph
        // atlas on a bare 2D canvas, whose `font` string has no cascade to read
        // `var(--font-sans)` from. The literal stack is the same one that
        // variable resolves to.
        fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontWeight: 600,
        sizeUnits: "pixels",
        getSize: 11,
        getColor: [236, 240, 243, 236],
        outlineColor: [7, 9, 12, 235],
        outlineWidth: 3.4,
        getAngle: getLabelAngle,
        getPosition: getLabelPosition,
        getText: getLabelText,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
      }),
    );
  }

  // ── buildings ─────────────────────────────────────────────────────────────
  if (layers.buildings) {
    const ready = zoom >= DETAIL_ZOOM.buildings - PRELOAD_LEAD;
    const payload = detail?.buildings;
    const data = ready && payload ? payload.buildings : EMPTY_BUILDINGS;

    /* One indexed read into the precomputed cube, then a shared colour tuple.
       The datum is not consulted at all: `data` is the payload's own array, so
       deck's own row index IS the cube's row index. Without a cube — payload
       still loading — every structure falls to the neutral chrome grey rather
       than to a colour that would be claiming something. */
    const fill = (_d: DetailBuilding, info: { index: number }): Color =>
      severity ? buildingFillColor(severity, frame, tBucket, info.index) : rgba(NEUTRAL_RGB, 150);

    const line = (_d: DetailBuilding, info: { index: number }): Color =>
      severity ? buildingLineColor(severity, frame, tBucket, info.index) : rgba(NEUTRAL_RGB, 200);

    const id = `${prefix}detail-buildings`;
    out.push(
      new PolygonLayer<DetailBuilding>({
        id,
        data,
        visible: zoom >= DETAIL_ZOOM.buildings,
        pickable: pick,
        filled: true,
        stroked: true,
        extruded: false,
        positionFormat: "XY",
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0.55,
        lineWidthMaxPixels: 1.6,
        getLineWidth: 0.55,
        getPolygon: getBuildingPolygon,
        getFillColor: fill,
        getLineColor: line,
        /* Frame index, not raw `t` — and the cube itself, because it is
           rebuilt when the hazard field arrives while `t` may not have moved. */
        updateTriggers: {
          getFillColor: [frame, tBucket, severity],
          getLineColor: [frame, tBucket, severity],
        },
      }),
    );
  }

  return out;
}

// Module-level accessors: deck compares these by identity, and a fresh arrow
// per render would force a full attribute re-evaluation every frame.
const getBlockPolygon = (d: DetailBlock) => d.ring;
const getBuildingPolygon = (d: DetailBuilding) => d.ring;
const getLabelPosition = (d: StreetLabel) => d.position;
const getLabelText = (d: StreetLabel) => d.name;
const getLabelAngle = (d: StreetLabel) => d.angle;

/** Street labels depend only on the network, which never changes for a loaded
 *  scenario — derive once per network object and hold it. */
const labelCache = new WeakMap<RoadNetwork, StreetLabel[]>();
function streetLabelsFor(network: RoadNetwork): StreetLabel[] {
  const hit = labelCache.get(network);
  if (hit) return hit;
  const built = buildStreetLabels(network);
  labelCache.set(network, built);
  return built;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip
// ─────────────────────────────────────────────────────────────────────────────

const TOOLTIP_STYLE: Partial<CSSStyleDeclaration> = {
  background: "var(--glass-deep)",
  backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-vibrancy))",
  border: "1px solid var(--hairline)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-pop)",
  color: "var(--foreground)",
  padding: "9px 11px",
  fontSize: "12px",
  pointerEvents: "none",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/** Deliberately a local copy of the markup deck-layers.tsx uses rather than an
 *  import: that file belongs to the core stack and this module must not make it
 *  export new surface just to be composed with. */
function tipHtml(
  title: string,
  sub: string | null,
  rows: [string, string][],
  accent: string,
  note?: string,
): string {
  const head =
    `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">` +
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
  // The provenance footer is prose, not a readout: it is a sentence about what
  // the numbers above are and are not, and it must not look like another value.
  const foot = note
    ? `<div style="margin-top:7px;padding-top:6px;border-top:1px solid var(--hairline);` +
      `max-width:290px;font-size:10px;line-height:1.45;color:var(--faint)">${esc(note)}</div>`
    : "";
  return head + subLine + body + foot;
}

function shortDuration(sec: Tick): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

const DAMAGE_LABEL: Record<string, string> = {
  destroyed: "Destroyed (>50%)",
  major: "Major (25-50%)",
  minor: "Minor (10-25%)",
  affected: "Affected (0-10%)",
  none: "No damage",
  inaccessible: "Inaccessible",
};

/** Strip a layer's own suffix back to the prefix its hover context is filed
 *  under, so any detail layer can read the stack's shared context. */
function hoverContext(layerId: string, suffix: string): HoverContext | undefined {
  return HOVER.get(`${layerId.slice(0, layerId.length - suffix.length)}detail`);
}

/**
 * Everything known about one picked structure, resolved against the playhead.
 *
 * Exported as the single read path for a structure: the tooltip below is built
 * from it, and the right-hand dock can bind to it without this module growing
 * a second, divergent description of the same building. Returns null for a
 * pick this module does not own.
 */
export function buildingInspection(info: PickingInfo): BuildingInspection | null {
  const id = info.layer?.id;
  if (!id || !info.object || !id.endsWith("detail-buildings")) return null;
  const d = info.object as DetailBuilding;
  const i = info.index;
  if (i < 0) return null;

  const ctx = hoverContext(id, "detail-buildings");
  const t = ctx?.t ?? 0;
  const ix = ctx?.severity ?? null;

  const s = ix ? severityAt(ix, severityFrame(ix, t), i) : 0;
  const state = ix
    ? severityStateAt(ix, t, i)
    : d.h === null
      ? "clear"
      : t >= d.h
        ? "spent"
        : "approaching";

  const exposureMetres = ix && ix.exposureM[i] >= 0 ? ix.exposureM[i] : null;
  const exposureTick = ix && ix.exposureTick[i] >= 0 ? ix.exposureTick[i] : null;
  const wave = d.z !== null ? (ctx?.zoneWave.get(d.z) ?? null) : null;

  return {
    kind: "building",
    index: i,
    building: d,
    t,
    severity: s,
    band: severityBand(s),
    state,
    stateLabel: severityStateLabel(state, s),
    arrivalTick: d.h,
    leadSeconds: d.h === null ? null : d.h - t,
    exposureMetres,
    exposureTick,
    structureType: d.s ?? null,
    damage: d.d ?? null,
    areaSqM: d.a,
    centroid: d.c,
    zoneId: d.z,
    zoneLabel: d.z !== null ? (ctx?.zoneLabel.get(d.z) ?? d.z) : null,
    wave,
    waveCount: ctx?.waveCount ?? 0,
    provenance: {
      arrival: d.h === null ? "not-reached-in-window" : "modelled-perimeter-progression",
      severity: "inferred",
      footprint: d.f,
      presence: d.p,
      imageryVintage: ctx?.imageryVintage ?? "unknown",
      exposure: !ix?.hasField
        ? "unavailable"
        : exposureMetres === null
          ? "off-grid"
          : "hazard-field",
      note: SEVERITY_PROVENANCE,
    },
  };
}

/** Absolute scenario clock, for a time that is a position rather than a gap. */
function clockTick(t: Tick): string {
  return `T+${shortDuration(t)}`;
}

/** How the front line reads for each state. Every branch that names a time
 *  names it as modelled — there is no observed per-structure arrival to quote. */
function frontRow(b: BuildingInspection): string {
  if (b.arrivalTick === null) return "not reached in window";
  const lead = b.leadSeconds ?? 0;
  if (b.state === "burning") return `reached ${shortDuration(-lead)} ago · modelled`;
  if (b.state === "spent") return `passed ${shortDuration(-lead)} ago · modelled`;
  return `arrives in ${shortDuration(lead)} · modelled`;
}

/**
 * Detail-layer tooltips. Returns null for anything it does not own, so the
 * caller can chain: `detailTooltip(info) ?? deckTooltip(info)`.
 */
export function detailTooltip(
  info: PickingInfo,
): { html: string; style: Partial<CSSStyleDeclaration> } | null {
  const id = info.layer?.id;
  if (!id || !info.object) return null;

  if (id.endsWith("detail-buildings")) {
    const b = buildingInspection(info);
    if (!b) return null;
    const d = b.building;

    // The index is quoted only where it is the thing driving the colour. Once
    // a structure has burned the ramp no longer applies to it, and printing a
    // 1.00 beside ash would read as a contradiction of what is on screen.
    const burned = b.state === "burning" || b.state === "spent";
    const rows: [string, string][] = [
      ["Severity", burned ? b.stateLabel : `${b.stateLabel} · ${b.severity.toFixed(2)}`],
      ["Front", frontRow(b)],
    ];
    // Only worth a line where it is the term actually driving the colour: for
    // a structure the model burns, its own arrival already said this.
    if (b.arrivalTick === null && b.exposureMetres !== null) {
      rows.push([
        "Nearest burn",
        b.exposureTick === null
          ? `${b.exposureMetres.toLocaleString()} m`
          : `${b.exposureMetres.toLocaleString()} m · ${clockTick(b.exposureTick)}`,
      ]);
    }
    rows.push(["Zone", b.zoneId ?? "outside mapped zones"]);
    rows.push([
      "Wave",
      b.wave === null ? "not in the plan" : `${b.wave + 1} of ${b.waveCount || "?"}`,
    ]);
    if (b.structureType) rows.push(["Structure", b.structureType]);
    rows.push(["Footprint", `${d.a.toLocaleString()} m²`]);
    // Observed, unlike everything above it — a CAL FIRE inspector recorded it.
    if (b.damage) rows.push(["Outcome (observed)", DAMAGE_LABEL[b.damage] ?? b.damage]);
    // A square standing in for a burned-down house is a reasonable drawing and
    // a dishonest one to leave unlabelled.
    rows.push([
      "Footprint source",
      d.p === "inspected"
        ? d.f === "imagery"
          ? "CAL FIRE inspection · traced outline"
          : "CAL FIRE inspection · outline derived"
        : `imagery only (${b.provenance.imageryVintage}) · may be a rebuild`,
    ]);

    const accent = severitySwatch(b.state, b.severity);
    const note =
      b.provenance.exposure === "unavailable"
        ? `${SEVERITY_PROVENANCE} No hazard field for this scenario, so proximity to burning ground is not part of this reading.`
        : b.provenance.exposure === "off-grid"
          ? `${SEVERITY_PROVENANCE} This structure sits outside the modelled hazard grid: green here means unknown, not surveyed safe.`
          : SEVERITY_PROVENANCE;

    return {
      html: tipHtml(
        b.structureType ?? "Structure",
        b.zoneLabel ?? "Unzoned",
        rows,
        `rgb(${accent[0]} ${accent[1]} ${accent[2]})`,
        note,
      ),
      style: TOOLTIP_STYLE,
    };
  }

  if (id.endsWith("detail-blocks")) {
    const d = info.object as DetailBlock;
    const ctx = hoverContext(id, "detail-blocks");
    const t = ctx?.t ?? 0;
    const rows: [string, string][] = [
      ["Population", d.pop.toLocaleString()],
      ["Housing units", d.hu.toLocaleString()],
      ["Zone", d.z ?? "outside mapped zones"],
      [
        "Hazard",
        d.h === null ? "never reached" : t >= d.h ? "reached" : `in ${shortDuration(d.h - t)}`,
      ],
    ];
    const vintage = ctx?.blockVintage;
    return {
      html: tipHtml(
        `Block ${d.id.slice(-4)}`,
        `${vintage ? `${vintage} decennial · ` : ""}GEOID ${d.id}`,
        rows,
        `rgb(${NEUTRAL_RGB[0]} ${NEUTRAL_RGB[1]} ${NEUTRAL_RGB[2]})`,
      ),
      style: TOOLTIP_STYLE,
    };
  }

  return null;
}

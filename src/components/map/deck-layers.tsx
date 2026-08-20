"use client";

import type { Color, Layer, PickingInfo } from "@deck.gl/core";
import { TripsLayer } from "@deck.gl/geo-layers";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { useMemo, useRef } from "react";
import { useControl } from "react-map-gl/maplibre";
import { pickSelect } from "@/components/inspector/pick-select";
import {
  buildContextLayers,
  contextTooltip,
  useContextBundle,
} from "@/components/map/context-layers";
import {
  buildDetailLayers,
  DETAIL_ZOOM,
  detailTooltip,
  useDetailState,
} from "@/components/map/detail-layers";
import {
  buildHazardLayers,
  type DecodedField,
  useHazardField,
} from "@/components/map/hazard-field";
import {
  buildRoadblockLayers,
  roadblockClick,
  roadblockTooltip,
} from "@/components/map/roadblock-layers";
import {
  buildVehicleLayers,
  useVehicleState,
  vehicleClick,
  vehicleTooltip,
} from "@/components/map/vehicle-layers";
import { useBundle } from "@/lib/bundle-context";
import {
  CONGESTION_RAMP,
  DISPATCH_ORIGINS,
  FACILITY_LABEL,
  HAZARD_RGB,
  PLAN_RGB,
  WARN_RGB,
  ZONE_STATUS_LABEL,
  ZONE_STATUS_RGB,
} from "@/lib/constants";
import type { ScenarioBundle } from "@/lib/data";
import {
  activeTrips,
  congestionColorFor,
  frameAt,
  hazardFrameAt,
  visibleZones,
} from "@/lib/derive";
import {
  clamp,
  formatCount,
  formatDistance,
  formatPercent,
  formatShort,
  loadBucket,
  urgencyBand,
} from "@/lib/format";
import {
  actions,
  selColorBy,
  selFilters,
  selLayers,
  selScenarioId,
  selSelection,
  selT,
  useEgress,
} from "@/lib/store";
import type {
  ContraflowOrder,
  EvacZone,
  Facility,
  LayerVisibility,
  LngLat,
  MapColorBy,
  MapFilters,
  PopulationCell,
  RoadEdge,
  RoadNetwork,
  RunFrame,
  Selection,
  SimulationRun,
  Tick,
  Trip,
  ZoneStatus,
} from "@/types/egress";

/**
 * The deck.gl layer stack.
 *
 * Two things here are load-bearing and easy to get wrong later:
 *
 * 1. The overlay is attached through react-map-gl's `useControl` as a
 *    MapboxOverlay in `interleaved` mode. Overlaid mode would stack a second
 *    canvas on top of the map, and a second canvas has no depth buffer shared
 *    with the terrain mesh — hazard polygons would float over ridgelines they
 *    are actually behind. Interleaved injects the layers into MapLibre's own
 *    WebGL2 context, so terrain occlusion is correct.
 *
 * 2. The scrubber writes `t` at up to 30fps. Every array handed to a layer as
 *    `data` is therefore cached against the tick of the *simulation frame* it
 *    came from (frames step every 300s), not against `t`. Between frame
 *    boundaries deck sees identical array references and skips the attribute
 *    re-upload entirely. Every closure accessor carries an `updateTriggers`
 *    entry for the same reason — without one, deck compares function identity,
 *    and a fresh closure per render means a full re-evaluation per render.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/** Trail length in scenario seconds. Long enough that a corridor reads as a
 *  continuous stream rather than a scatter of dots at 60x playback. */
const TRAIL_SECONDS = 420;

/** Trip membership is re-derived on this cadence, not every frame. Half the
 *  300s simulation frame step, so a trip is never more than one bucket late. */
const TRIP_BUCKET = 150;

/** Contraflow centre-line dash geometry, in metres along the road. Long on
 *  purpose: at the zoom an operator actually works at, ~200m is a dash you can
 *  see, and anything shorter resolves into a solid line. */
const DASH_ON = 170;
const DASH_OFF = 120;

/** Reference shares that saturate the vulnerability ramp. A block group where
 *  one household in ten has no car, or where three structures in five are
 *  manufactured housing, is already at the top of the scale. */
const VULN_NO_VEHICLE_REF = 0.1;
const VULN_MOBILE_HOME_REF = 0.6;

const NEUTRAL_RGB = ZONE_STATUS_RGB.held;
const OK_RGB = ZONE_STATUS_RGB.cleared;

/** Urgency ramp for `colorBy: "urgency"`. Derived from sanctioned constants
 *  only — no new hues enter the palette here. */
const URGENCY_RGB: [number, number, number][] = [
  NEUTRAL_RGB,
  mixRgb(NEUTRAL_RGB, WARN_RGB, 0.5),
  WARN_RGB,
  HAZARD_RGB,
];

// ─────────────────────────────────────────────────────────────────────────────
// Datum shapes. Every pickable layer carries a `_k` tag so one module-level
// tooltip and one module-level click handler can serve the whole stack, instead
// of a per-layer closure that would be reallocated on every tick.
// ─────────────────────────────────────────────────────────────────────────────

interface ZoneDatum {
  _k: "zone";
  zone: EvacZone;
  status: ZoneStatus;
  /** Households still inside. -1 when no run is loaded. */
  remaining: number;
  /** Seconds from now until the hazard arrives. */
  eta: Tick;
  /** Worst load fraction on this zone's primary egress route. */
  routeLoad: number;
  /** 0..1 composite of no-vehicle and manufactured-housing share. */
  vulnerability: number;
}

interface EdgeDatum {
  _k: "edge";
  edge: RoadEdge;
  load: number;
}

interface ContraflowDatum {
  _k: "contraflow";
  order: ContraflowOrder;
  path: LngLat[];
}

interface FacilityDatum {
  _k: "facility";
  facility: Facility;
  atRisk: boolean;
}

interface CellDatum {
  _k: "cell";
  cell: PopulationCell;
}

type EgressDatum = ZoneDatum | EdgeDatum | ContraflowDatum | FacilityDatum | CellDatum;

// ─────────────────────────────────────────────────────────────────────────────
// Caches. Keyed on the bundle object, which is stable for the lifetime of a
// loaded scenario, so nothing here leaks across a scenario switch.
// ─────────────────────────────────────────────────────────────────────────────

const slotCache = new WeakMap<object, Map<string, { key: string; value: unknown }>>();

/**
 * Memoise one derived array against a string key. Same key, same reference.
 *
 * Callers whose data depends on the run MUST put the run scope in the SLOT, not
 * the key. The split view calls buildLayers twice per tick against one bundle;
 * with a shared slot the two panes would evict each other every frame and every
 * run-scoped array would be rebuilt — and re-uploaded — 30 times a second.
 */
function cached<T>(owner: object, slot: string, key: string, make: () => T): T {
  let slots = slotCache.get(owner);
  if (!slots) {
    slots = new Map();
    slotCache.set(owner, slots);
  }
  const hit = slots.get(slot);
  if (hit && hit.key === key) return hit.value as T;
  const value = make();
  slots.set(slot, { key, value });
  return value;
}

const edgeIndexCache = new WeakMap<RoadNetwork, Map<string, RoadEdge>>();

function edgeIndex(network: RoadNetwork): Map<string, RoadEdge> {
  let idx = edgeIndexCache.get(network);
  if (!idx) {
    idx = new Map(network.edges.map((e) => [e.id, e]));
    edgeIndexCache.set(network, idx);
  }
  return idx;
}
function rgba(rgb: readonly [number, number, number], alpha: number): Color {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  f: number,
): [number, number, number] {
  const w = clamp(f, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * w),
    Math.round(a[1] + (b[1] - a[1]) * w),
    Math.round(a[2] + (b[2] - a[2]) * w),
  ];
}

/** Multiplicative lightness nudge. Used only to separate adjacent zones'
 *  traffic streams from each other — the hue still carries the status. */
function shade(rgb: readonly [number, number, number], factor: number): [number, number, number] {
  return [
    Math.round(clamp(rgb[0] * factor, 0, 255)),
    Math.round(clamp(rgb[1] * factor, 0, 255)),
    Math.round(clamp(rgb[2] * factor, 0, 255)),
  ];
}

const hashMemo = new Map<string, number>();

/** Stable 0..1 from an id, so a zone's stream keeps the same tint all run. */
function hash01(s: string): number {
  const memo = hashMemo.get(s);
  if (memo !== undefined) return memo;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const v = (h >>> 0) / 4294967295;
  hashMemo.set(s, v);
  return v;
}

function zoneRgb(d: ZoneDatum, colorBy: MapColorBy): [number, number, number] {
  switch (colorBy) {
    case "urgency":
      return URGENCY_RGB[urgencyBand(d.eta)];
    case "load":
      return CONGESTION_RAMP[loadBucket(d.routeLoad, CONGESTION_RAMP.length)];
    case "vulnerability":
      return mixRgb(NEUTRAL_RGB, WARN_RGB, d.vulnerability);
    default:
      return ZONE_STATUS_RGB[d.status];
  }
}

function facilityRgb(f: Facility, atRisk: boolean): [number, number, number] {
  // A facility standing inside the hazard footprint is the single most urgent
  // thing on the map, so it overrides its own kind encoding.
  if (atRisk) return HAZARD_RGB;
  if (f.kind === "shelter") return OK_RGB;
  if (DISPATCH_ORIGINS.includes(f.kind)) return PLAN_RGB;
  if (f.kind === "nursing_home" || f.kind === "hospital") return WARN_RGB;
  return NEUTRAL_RGB;
}

function vulnerabilityOf(z: EvacZone): number {
  const hh = Math.max(1, z.households);
  const noCar = z.noVehicleHouseholds / hh / VULN_NO_VEHICLE_REF;
  const mobile = z.mobileHomes / hh / VULN_MOBILE_HOME_REF;
  return clamp(Math.max(noCar, mobile), 0, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Equirectangular metres. The spans here are single-digit kilometres, where
 *  the error against the geodesic is well under a metre. */
function metres(a: LngLat, b: LngLat): number {
  const R = 6371008.8;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const x = dLng * Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  return Math.hypot(x, dLat) * R;
}

/** Dash cursor carried across the edges of one contraflow order. */
interface DashState {
  drawing: boolean;
  /** Metres left in the current on- or off-run. */
  left: number;
}

/**
 * Cut a polyline into on/off runs of the given metre lengths, appending to
 * `out` and advancing `st`.
 *
 * deck.gl dashes live in @deck.gl/extensions, which this project does not
 * install, so the dash is produced as real geometry. The cursor is threaded
 * across every edge of an order rather than reset per edge on purpose: the
 * median contraflow edge on Skyway is 66 metres, so a per-edge dash would make
 * every edge one solid stroke and the corridor would draw as a plain line.
 */
function dashInto(coords: LngLat[], on: number, off: number, st: DashState, out: LngLat[][]): void {
  if (coords.length < 2) return;
  let run: LngLat[] = st.drawing ? [coords[0]] : [];
  for (let i = 1; i < coords.length; i++) {
    let a = coords[i - 1];
    const b = coords[i];
    let seg = metres(a, b);
    if (seg <= 0) continue;
    while (seg >= st.left) {
      const f = st.left / seg;
      const p: LngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      if (st.drawing) {
        run.push(p);
        if (run.length > 1) out.push(run);
        run = [];
      } else {
        run = [p];
      }
      st.drawing = !st.drawing;
      a = p;
      seg -= st.left;
      st.left = st.drawing ? on : off;
    }
    st.left -= seg;
    if (st.drawing) run.push(b);
  }
  if (st.drawing && run.length > 1) out.push(run);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip. One module-level function for the whole stack — a stable reference
// so the overlay never re-registers it.
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
  maxWidth: "260px",
  pointerEvents: "none",
  zIndex: "40",
} as Partial<CSSStyleDeclaration>;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function tipHtml(
  title: string,
  sub: string | null,
  rows: [string, string][],
  accent?: string,
): string {
  const head = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:${
    rows.length ? "6px" : "0"
  }">${
    accent
      ? `<span style="width:7px;height:7px;border-radius:50%;flex:none;background:${accent}"></span>`
      : ""
  }<span style="font-size:12px;font-weight:650;letter-spacing:-0.005em">${esc(title)}</span></div>`;
  const subLine = sub
    ? `<div style="margin:-4px 0 6px;font-size:10.5px;color:var(--faint)">${esc(sub)}</div>`
    : "";
  const body = rows
    .map(
      ([k, v]) =>
        `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-top:2px"><span style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.13em;text-transform:uppercase;color:var(--faint)">${esc(
          k,
        )}</span><span style="font-family:var(--font-mono);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums">${esc(
          v,
        )}</span></div>`,
    )
    .join("");
  return head + subLine + body;
}

function cssRgb(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

export function deckTooltip(
  info: PickingInfo,
): { html: string; style: Partial<CSSStyleDeclaration> } | null {
  const d = info.object as EgressDatum | undefined;
  if (!d) return null;

  switch (d._k) {
    case "zone": {
      const rows: [string, string][] = [
        ["Status", ZONE_STATUS_LABEL[d.status]],
        ["Households", formatCount(d.zone.households)],
        ["No vehicle", formatCount(d.zone.noVehicleHouseholds)],
        ["Hazard in", d.eta > 0 ? formatShort(d.eta) : "arrived"],
      ];
      if (d.remaining >= 0) rows.splice(2, 0, ["Remaining", formatCount(d.remaining)]);
      return {
        html: tipHtml(
          d.zone.label,
          d.zone.primaryRouteLabel,
          rows,
          cssRgb(ZONE_STATUS_RGB[d.status]),
        ),
        style: TOOLTIP_STYLE,
      };
    }
    case "edge": {
      return {
        html: tipHtml(
          d.edge.name ?? "Unnamed road",
          `${d.edge.roadClass} · ${d.edge.lanes} lane${d.edge.lanes === 1 ? "" : "s"}`,
          [
            ["Load", formatPercent(d.load)],
            ["Capacity", `${formatCount(d.edge.capacity)}/hr`],
            ["Length", formatDistance(d.edge.length)],
          ],
          cssRgb(congestionColorFor(d.load)),
        ),
        style: TOOLTIP_STYLE,
      };
    }
    case "contraflow": {
      return {
        html: tipHtml(
          d.order.label,
          "Contraflow active",
          [
            ["Before", `${formatCount(d.order.capacityBefore)}/hr`],
            ["After", `${formatCount(d.order.capacityAfter)}/hr`],
            [
              "Gain",
              formatPercent(
                d.order.capacityBefore > 0 ? d.order.capacityAfter / d.order.capacityBefore - 1 : 0,
              ),
            ],
          ],
          cssRgb(PLAN_RGB),
        ),
        style: TOOLTIP_STYLE,
      };
    }
    case "facility": {
      const rows: [string, string][] = [["Kind", FACILITY_LABEL[d.facility.kind]]];
      if (d.facility.capacity > 0) rows.push(["Capacity", formatCount(d.facility.capacity)]);
      if (d.facility.assets.bus > 0) rows.push(["Buses", formatCount(d.facility.assets.bus)]);
      if (d.facility.assets.ambulance > 0)
        rows.push(["Ambulances", formatCount(d.facility.assets.ambulance)]);
      if (d.atRisk) rows.push(["Exposure", "INSIDE HAZARD"]);
      return {
        html: tipHtml(d.facility.name, null, rows, cssRgb(facilityRgb(d.facility, d.atRisk))),
        style: TOOLTIP_STYLE,
      };
    }
    case "cell": {
      return {
        html: tipHtml(
          `Block group ${d.cell.id}`,
          null,
          [
            ["Population", formatCount(d.cell.population)],
            ["Households", formatCount(d.cell.households)],
            ["No vehicle", formatCount(d.cell.noVehicleHouseholds)],
            ["65+", formatCount(d.cell.age65Plus)],
            ["Mobile homes", formatCount(d.cell.mobileHomes)],
          ],
          cssRgb(WARN_RGB),
        ),
        style: TOOLTIP_STYLE,
      };
    }
    default:
      return null;
  }
}

/**
 * Stable click handler. Selection kinds are the ones the store models.
 *
 * Returning true is deck's signal that the click was consumed. A click that
 * picked nothing is deliberately left alone rather than cleared here — the map
 * shell already clears on bare-basemap clicks, and doing it in both places
 * writes a fresh selection object twice for one gesture.
 */
export function deckClick(info: PickingInfo): boolean {
  const d = info.object as EgressDatum | undefined;
  if (!d) return false;
  switch (d._k) {
    case "zone":
      actions.select("zone", d.zone.id);
      return true;
    case "edge":
      actions.select("edge", d.edge.id);
      return true;
    case "facility":
      actions.select("facility", d.facility.id);
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLayers — pure, so the split view can drive two independent stacks off
// the same bundle with different runs.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildLayersArgs {
  bundle: ScenarioBundle;
  /** The run being visualised. Null before the solver output lands on disk. */
  run: SimulationRun | null;
  t: Tick;
  layers: LayerVisibility;
  filters: MapFilters;
  selection: Selection;
  colorBy: MapColorBy;
  /** Precomputed burn-arrival grid. Null renders the flat footprint instead. */
  field?: DecodedField | null;
  /** Split view renders two stacks; ids must not collide between them. */
  idPrefix?: string;
  /** Split panes switch picking off on the pane that is not focused. */
  interactive?: boolean;
  /** Camera zoom. Only decides who owns the pick at street level — see zones. */
  zoom?: number;
}

export function buildLayers(args: BuildLayersArgs): Layer[] {
  const { bundle, run, t, layers, filters, selection, colorBy } = args;
  const prefix = args.idPrefix ? `${args.idPrefix}-` : "";
  const pick = args.interactive !== false;
  /* Zone fills cover the whole town and draw above the street-level stack, so
     while they stay pickable a building can be hovered but never picked — the
     zone always wins the pick. Past the buildings' own zoom gate the operator
     is looking at structures, so structures take the pick; zones stay
     selectable from the queue list and at every zoom below this one. */
  const streetLevel = (args.zoom ?? 0) >= DETAIL_ZOOM.buildings;
  const owner = bundle as object;

  // Everything derived from the simulation is stepped, not continuous. Keying
  // the caches on the frame's own tick is what keeps the scrubber cheap.
  const frame: RunFrame | null = run ? frameAt(run, t) : null;
  const frameT = frame ? frame.t : -1;
  const runKey = run ? `${run.kind}:${run.plan.revision}` : "none";
  const hazardFrame = hazardFrameAt(bundle.hazard, t);
  const hazardT = hazardFrame.t;
  const selectedId = selection.id ?? "";
  const scope = `${prefix}${runKey}`;
  const filterKey = `${filters.minUrgency}|${filters.statuses.join(",")}|${
    filters.minNoVehicle
  }|${filters.query}|${filters.maxHazardEta ?? "-"}|${filters.facilityKinds.join(",")}`;

  const out: Layer[] = [];

  /* ── 0. hazard ────────────────────────────────────────────────────────────
     Split in two on purpose. The fire is ground: it belongs UNDER the network,
     the zones and the trips, because an operator reading a road through the
     fire needs the road to stay readable. Only the hairline that marks the
     modelled boundary is drawn back on top, further down. */
  const hazard = layers.hazard
    ? buildHazardLayers({ field: args.field ?? null, frame: hazardFrame, prefix, zoom: args.zoom })
    : null;
  if (hazard) out.push(...hazard.ground);

  // ── 1. population ─────────────────────────────────────────────────────────
  if (layers.population) {
    const data = cached<CellDatum[]>(owner, "population", "static", () =>
      bundle.population.cells.map((cell) => ({ _k: "cell", cell })),
    );
    out.push(
      new ScatterplotLayer<CellDatum>({
        id: `${prefix}population`,
        data,
        pickable: pick,
        radiusUnits: "meters",
        radiusMinPixels: 2,
        radiusMaxPixels: 64,
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: 0.8,
        getLineColor: rgba(NEUTRAL_RGB, 120),
        getPosition: getCellPosition,
        getRadius: getCellRadius,
        getFillColor: getCellFill,
      }),
    );
  }

  // ── 2. zones ──────────────────────────────────────────────────────────────
  if (layers.zones) {
    const data = cached<ZoneDatum[]>(owner, `${scope}|zones`, `${frameT}|${filterKey}`, () => {
      const visible = visibleZones(bundle.zones, filters, run, t);
      return visible.map<ZoneDatum>((zone) => {
        const status = frame?.zoneStatus[zone.id] ?? "held";
        const remaining = frame ? (frame.zoneRemaining[zone.id] ?? 0) : -1;
        let routeLoad = 0;
        if (frame) {
          for (const id of zone.primaryRouteEdgeIds) {
            const l = frame.edgeLoad[id];
            if (l !== undefined && l > routeLoad) routeLoad = l;
          }
        }
        return {
          _k: "zone",
          zone,
          status,
          remaining,
          eta: zone.hazardEta - t,
          routeLoad,
          vulnerability: vulnerabilityOf(zone),
        };
      });
    });

    out.push(
      new PolygonLayer<ZoneDatum>({
        id: `${prefix}zones`,
        data,
        pickable: pick && !streetLevel,
        filled: true,
        stroked: true,
        extruded: false,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
        lineJointRounded: true,
        getPolygon: getZonePolygon,
        getFillColor: (d) => rgba(zoneRgb(d, colorBy), d.zone.id === selectedId ? 78 : 32),
        getLineColor: (d) => rgba(zoneRgb(d, colorBy), d.zone.id === selectedId ? 255 : 185),
        getLineWidth: (d) => (d.zone.id === selectedId ? 3 : 1.1),
        updateTriggers: {
          getFillColor: [frameT, colorBy, selectedId],
          getLineColor: [frameT, colorBy, selectedId],
          getLineWidth: [selectedId],
        },
      }),
    );
  }

  // ── 3. congestion ─────────────────────────────────────────────────────────
  if (layers.congestion && frame) {
    const idx = edgeIndex(bundle.network);
    const q = filters.query.trim().toLowerCase();
    const data = cached<EdgeDatum[]>(owner, `${scope}|congestion`, `${frameT}|${q}`, () => {
      const list: EdgeDatum[] = [];
      for (const id of Object.keys(frame.edgeLoad)) {
        const edge = idx.get(id);
        if (!edge) continue;
        if (q && !(edge.name ?? "").toLowerCase().includes(q)) continue;
        list.push({ _k: "edge", edge, load: frame.edgeLoad[id] });
      }
      // Busiest last so saturated corridors draw over free-flowing ones.
      list.sort((a, b) => a.load - b.load);
      return list;
    });

    out.push(
      new PathLayer<EdgeDatum>({
        id: `${prefix}congestion`,
        data,
        pickable: pick,
        widthUnits: "pixels",
        widthMinPixels: 1,
        widthMaxPixels: 14,
        capRounded: true,
        jointRounded: true,
        getPath: getEdgePath,
        getColor: getEdgeColor,
        getWidth: getEdgeWidth,
        updateTriggers: {
          getColor: [frameT, selectedId],
          getWidth: [frameT, selectedId],
        },
      }),
    );
  }

  // ── 4. contraflow ─────────────────────────────────────────────────────────
  // No LayerVisibility key exists for this, and inventing one would desync the
  // store. Contraflow is the lever — while an order is live it is always drawn.
  if (run) {
    const idx = edgeIndex(bundle.network);
    const active = run.plan.contraflow.filter((o) => t >= o.activateAt && t < o.releaseAt);
    if (active.length > 0) {
      const activeKey = active.map((o) => o.label).join(",");
      const casing = cached<ContraflowDatum[]>(owner, `${scope}|contraflow`, activeKey, () => {
        const list: ContraflowDatum[] = [];
        for (const order of active) {
          for (const id of order.edgeIds) {
            const edge = idx.get(id);
            if (edge && edge.geometry.length > 1) {
              list.push({ _k: "contraflow", order, path: edge.geometry });
            }
          }
        }
        return list;
      });
      const dashes = cached<ContraflowDatum[]>(owner, `${scope}|contraflow-dash`, activeKey, () => {
        const list: ContraflowDatum[] = [];
        for (const order of active) {
          const st: DashState = { drawing: true, left: DASH_ON };
          const pieces: LngLat[][] = [];
          for (const d of casing) {
            if (d.order !== order) continue;
            dashInto(d.path, DASH_ON, DASH_OFF, st, pieces);
          }
          for (const piece of pieces) list.push({ _k: "contraflow", order, path: piece });
        }
        return list;
      });

      out.push(
        new PathLayer<ContraflowDatum>({
          id: `${prefix}contraflow-casing`,
          data: casing,
          pickable: pick,
          widthUnits: "pixels",
          widthMinPixels: 7,
          widthMaxPixels: 26,
          capRounded: true,
          jointRounded: true,
          getPath: getContraflowPath,
          getColor: CONTRAFLOW_CASING,
          getWidth: 14,
        }),
        new PathLayer<ContraflowDatum>({
          id: `${prefix}contraflow-dash`,
          data: dashes,
          pickable: false,
          widthUnits: "pixels",
          widthMinPixels: 2,
          widthMaxPixels: 6,
          capRounded: true,
          getPath: getContraflowPath,
          getColor: CONTRAFLOW_DASH,
          getWidth: 3,
        }),
      );
    }
  }

  // ── 5. hazard boundary + hotspots ─────────────────────────────────────────
  if (hazard) {
    /* Nothing here is pickable. By late in the run the footprint covers most of
       the map, and a pickable fill would swallow every zone and road hover
       underneath it. Provenance rides the hairline's solid/dashed treatment,
       the chip and the scrubber band — all always visible, never on hover. */
    out.push(...hazard.over);

    const hotspots = hazardFrame.hotspots;
    if (hotspots && hotspots.length > 0) {
      const spots = cached<LngLat[]>(owner, "hotspots", `${hazardT}`, () => hotspots);
      out.push(
        new ScatterplotLayer<LngLat>({
          id: `${prefix}hotspots`,
          data: spots,
          pickable: false,
          radiusUnits: "pixels",
          radiusMinPixels: 1.5,
          radiusMaxPixels: 5,
          getPosition: getHotspotPosition,
          getRadius: 2.6,
          getFillColor: HOTSPOT_FILL,
        }),
      );
    }
  }

  // ── 6. flow — the hero ────────────────────────────────────────────────────
  if (layers.flow && run) {
    const bucket = Math.floor(t / TRIP_BUCKET) * TRIP_BUCKET;
    const trips = cached<Trip[]>(owner, `${scope}|trips`, `${bucket}`, () => activeTrips(run, t));

    if (trips.length > 0) {
      // Hue carries the source zone's status; a per-zone lightness offset keeps
      // two adjacent zones feeding the same corridor visually separable.
      const statusOf = frame?.zoneStatus;
      const tripColor = (d: Trip): Color => {
        if (d.kind !== "household") return rgba(WARN_RGB, 235);
        const base = ZONE_STATUS_RGB[statusOf?.[d.zoneId] ?? "flowing"];
        return rgba(shade(base, 0.86 + hash01(d.zoneId) * 0.28), 235);
      };

      out.push(
        new TripsLayer<Trip>({
          id: `${prefix}flow`,
          data: trips,
          pickable: false,
          currentTime: t,
          trailLength: TRAIL_SECONDS,
          fadeTrail: true,
          widthUnits: "pixels",
          widthMinPixels: 1,
          widthMaxPixels: 7,
          capRounded: true,
          jointRounded: true,
          opacity: 0.92,
          getPath: getTripPath,
          getTimestamps: getTripTimestamps,
          getColor: tripColor,
          getWidth: getTripWidth,
          updateTriggers: { getColor: [frameT] },
        }),
      );
    }
  }

  // ── 8. facilities ─────────────────────────────────────────────────────────
  if (layers.facilities) {
    const kinds = filters.facilityKinds;
    const all = cached<FacilityDatum[]>(owner, "facilities", `${hazardT}|${kinds.join(",")}`, () =>
      bundle.facilities.facilities
        .filter((f) => kinds.length === 0 || kinds.includes(f.kind))
        .map<FacilityDatum>((facility) => ({
          _k: "facility",
          facility,
          atRisk: facility.atRiskFrom !== undefined && t >= facility.atRiskFrom,
        })),
    );
    /* Fire stations are drawn by the engine stack in vehicle-layers.tsx, as an
       engine glyph carrying the station's stabled count. Leaving them in the
       dots too would put a circle underneath every engine, which reads as two
       facilities at one address. One mark per station, and the richer one
       wins. */
    const dots = cached<FacilityDatum[]>(
      owner,
      "facilities-dot",
      `${hazardT}|${kinds.join(",")}`,
      () =>
        all.filter(
          (d) =>
            d.facility.kind !== "mobile_home_park" &&
            // A station with no engines gets no engine glyph, so it has to keep
            // its dot or it would drop off the map entirely.
            !(d.facility.kind === "fire_station" && d.facility.assets.engine > 0),
        ),
    );
    const parks = cached<FacilityDatum[]>(
      owner,
      "facilities-mhp",
      `${hazardT}|${kinds.join(",")}`,
      () => all.filter((d) => d.facility.kind === "mobile_home_park"),
    );

    if (dots.length > 0) {
      out.push(
        new ScatterplotLayer<FacilityDatum>({
          id: `${prefix}facilities`,
          data: dots,
          pickable: pick,
          stroked: true,
          filled: true,
          radiusUnits: "pixels",
          radiusMinPixels: 2.5,
          radiusMaxPixels: 11,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1,
          getLineWidth: 1,
          getLineColor: FACILITY_STROKE,
          getPosition: getFacilityPosition,
          getRadius: getFacilityRadius,
          getFillColor: (d) => rgba(facilityRgb(d.facility, d.atRisk), d.atRisk ? 250 : 215),
          updateTriggers: { getFillColor: [hazardT] },
        }),
      );
    }

    // 71 mobile home parks. Manufactured housing burns first and its residents
    // are the least able to leave, so it gets a mark nothing else uses: a warn
    // ring rather than a solid dot.
    if (parks.length > 0) {
      out.push(
        new ScatterplotLayer<FacilityDatum>({
          id: `${prefix}facilities-mhp`,
          data: parks,
          pickable: pick,
          stroked: true,
          filled: true,
          radiusUnits: "pixels",
          radiusMinPixels: 3.5,
          radiusMaxPixels: 9,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1.4,
          getLineWidth: 1.6,
          getRadius: 4.5,
          getPosition: getFacilityPosition,
          getFillColor: (d) => rgba(d.atRisk ? HAZARD_RGB : WARN_RGB, 55),
          getLineColor: (d) => rgba(d.atRisk ? HAZARD_RGB : WARN_RGB, 240),
          updateTriggers: { getFillColor: [hazardT], getLineColor: [hazardT] },
        }),
      );
    }
  }

  // ── 9. noVehicle — the demo beat ──────────────────────────────────────────
  if (layers.noVehicle) {
    const data = cached<CellDatum[]>(owner, "novehicle", `${filters.minNoVehicle}`, () =>
      bundle.population.cells
        .filter((c) => c.noVehicleHouseholds > 0 && c.noVehicleHouseholds >= filters.minNoVehicle)
        .map<CellDatum>((cell) => ({ _k: "cell", cell })),
    );
    if (data.length > 0) {
      out.push(
        new ScatterplotLayer<CellDatum>({
          id: `${prefix}no-vehicle`,
          data,
          pickable: pick,
          stroked: true,
          filled: true,
          radiusUnits: "meters",
          radiusMinPixels: 4,
          radiusMaxPixels: 32,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1.2,
          getLineWidth: 1.5,
          getPosition: getCellPosition,
          getRadius: getNoVehicleRadius,
          getFillColor: NO_VEHICLE_FILL,
          getLineColor: NO_VEHICLE_LINE,
        }),
      );
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level accessors. These never change identity, so deck.gl never has to
// re-run them on a tick that did not change the underlying frame.
// ─────────────────────────────────────────────────────────────────────────────

const getCellPosition = (d: CellDatum) => d.cell.centroid;
const getCellRadius = (d: CellDatum) => Math.sqrt(Math.max(1, d.cell.households)) * 24;
const getCellFill = (d: CellDatum): Color =>
  rgba(
    mixRgb(
      NEUTRAL_RGB,
      WARN_RGB,
      d.cell.noVehicleHouseholds / Math.max(1, d.cell.households) / VULN_NO_VEHICLE_REF,
    ),
    92,
  );
/** Area, not radius, carries the count — and the constant is deliberately
 *  modest: bubbles that merge into a wash stop being a count and become a
 *  colour field, which is the opposite of what this layer is for. */
const getNoVehicleRadius = (d: CellDatum) => Math.sqrt(d.cell.noVehicleHouseholds) * 58;
const NO_VEHICLE_FILL = rgba(WARN_RGB, 62);
const NO_VEHICLE_LINE = rgba(WARN_RGB, 240);

const getZonePolygon = (d: ZoneDatum) => d.zone.geometry;

const getEdgePath = (d: EdgeDatum) => d.edge.geometry;
const getEdgeColor = (d: EdgeDatum): Color => rgba(congestionColorFor(d.load), 225);
/** Lane count sets the base width; load swells it, so a saturated arterial is
 *  physically fatter on the map than the same road running free. */
const getEdgeWidth = (d: EdgeDatum) =>
  (0.85 + d.edge.lanes * 0.5) * (0.8 + Math.min(d.load, 1.5) * 1.35);

const getContraflowPath = (d: ContraflowDatum) => d.path;
/* The casing is deliberately a wide, low-alpha band rather than a brighter
   line: free-flowing congestion is the same cyan, so contraflow has to read as
   a different SHAPE — a halo with a dashed spine — not a different tint. */
const CONTRAFLOW_CASING = rgba(PLAN_RGB, 58);
const CONTRAFLOW_DASH = rgba(PLAN_RGB, 245);

const getHotspotPosition = (d: LngLat) => d;
const HOTSPOT_FILL = rgba(HAZARD_RGB, 210);

const getTripPath = (d: Trip) => d.path;
const getTripTimestamps = (d: Trip) => d.timestamps;
const getTripWidth = (d: Trip) => clamp(0.8 + Math.sqrt(Math.max(1, d.weight)) * 0.45, 0.8, 7);

const getFacilityPosition = (d: FacilityDatum) => d.facility.position;
const getFacilityRadius = (d: FacilityDatum) =>
  d.facility.kind === "shelter" ? clamp(3.2 + Math.sqrt(d.facility.capacity) / 7, 3.2, 11) : 3.2;
const FACILITY_STROKE: Color = [10, 12, 16, 190];

// ─────────────────────────────────────────────────────────────────────────────
// The overlay
// ─────────────────────────────────────────────────────────────────────────────

export interface DeckOverlayProps {
  run: SimulationRun | null;
  /** Split view passes a prefix so the two panes' layer ids stay distinct. */
  idPrefix?: string;
  /** Off on the unfocused pane of a split view. */
  interactive?: boolean;
  /**
   * Interleave into MapLibre's own WebGL context. Default true, and it should
   * stay true: an overlaid deck canvas has no shared depth buffer, so hazard
   * polygons would paint over terrain they sit behind. Exposed only as an
   * escape hatch if the map shell hits a driver-specific interleave bug.
   */
  interleaved?: boolean;
}

export function DeckOverlay({
  run,
  idPrefix,
  interactive = true,
  interleaved = true,
}: DeckOverlayProps) {
  const bundle = useBundle();
  const t = useEgress(selT);
  const layers = useEgress(selLayers);
  const filters = useEgress(selFilters);
  const selection = useEgress(selSelection);
  const colorBy = useEgress(selColorBy);
  const scenarioId = useEgress(selScenarioId);
  /* Optional: only a wildfire track with perimeter geometry has one on disk.
     Null falls the hazard back to its polygon footprint. */
  const field = useHazardField(scenarioId);
  const context = useContextBundle(scenarioId);
  const { detail, zoom } = useDetailState(scenarioId);

  const built = useMemo(
    () =>
      bundle
        ? buildLayers({
            bundle,
            run,
            t,
            layers,
            filters,
            selection,
            colorBy,
            field,
            idPrefix,
            interactive,
            zoom,
          })
        : [],
    [bundle, run, t, layers, filters, selection, colorBy, field, idPrefix, interactive, zoom],
  );

  // `interleaved` is fixed at construction; everything else flows through
  // setProps, which is the react-map-gl + deck.gl composite pattern.
  const contextBuilt = useMemo(
    () => (context ? buildContextLayers({ context, t, layers, idPrefix, interactive }) : []),
    [context, t, layers, idPrefix, interactive],
  );

  /* Street-level stack. Every layer inside is zoom-gated, so this costs
     nothing until the operator is actually close enough to read a street. */
  const detailBuilt = useMemo(
    () =>
      buildDetailLayers({
        detail,
        zoom,
        t,
        layers,
        network: bundle?.network ?? null,
        zones: bundle?.zones ?? null,
        plan: run?.plan ?? null,
        idPrefix,
        interactive,
      }),
    [detail, zoom, t, layers, bundle, run, idPrefix, interactive],
  );

  /* The fleet. Its own module and its own `_vk` datum tag, so a bus pick can
     never be claimed by the zone/flow stack and vice versa. */
  const vehicles = useVehicleState(scenarioId);

  const vehicleBuilt = useMemo(
    () =>
      buildVehicleLayers({
        plan: run?.plan ?? null,
        zones: bundle?.zones ?? null,
        network: bundle?.network ?? null,
        facilities: bundle?.facilities ?? null,
        hazard: bundle?.hazard ?? null,
        facilityKinds: filters.facilityKinds,
        zoom,
        t,
        layers,
        selection,
        reduceMotion: vehicles.reduceMotion,
        idPrefix,
        interactive,
      }),
    [
      run,
      bundle,
      t,
      layers,
      selection,
      filters.facilityKinds,
      zoom,
      vehicles.reduceMotion,
      idPrefix,
      interactive,
    ],
  );

  /* Road closures. Above the congestion band on purpose — a road the fire has
     taken must never read as a road that is merely flowing — and below the
     fleet, because a bus is the thing an operator reaches for first. */
  const roadblockBuilt = useMemo(
    () =>
      buildRoadblockLayers({
        hazard: bundle?.hazard ?? null,
        network: bundle?.network ?? null,
        plan: run?.plan ?? null,
        zones: bundle?.zones ?? null,
        t,
        layers,
        selection,
        zoom,
        reduceMotion: vehicles.reduceMotion,
        idPrefix,
        interactive,
      }),
    [bundle, run, t, layers, selection, zoom, vehicles.reduceMotion, idPrefix, interactive],
  );

  /* Draw order is array order. Context is background, detail sits above it but
     below the zone/flow stack that carries the argument. Vehicles draw last:
     they are the only thing on this map at a human scale, and a bus hidden
     under a corridor band is a bus the operator will not click. */
  const allLayers = useMemo(
    () => [...contextBuilt, ...detailBuilt, ...built, ...roadblockBuilt, ...vehicleBuilt],
    [contextBuilt, detailBuilt, built, roadblockBuilt, vehicleBuilt],
  );

  /* Context datums are tagged `_ck` rather than `_k`, so neither tooltip can
     claim the other's pick. */
  /* A roadblock's tier depends on the playhead, but a tooltip closure rebuilt
     30 times a second would push a fresh `getTooltip` into the overlay on every
     frame. The ref keeps the callback identity stable and still reads the
     current tick at hover time, which is the only time it is called. */
  const tRef = useRef(t);
  tRef.current = t;

  const tooltip = useMemo(
    () => (info: Parameters<typeof deckTooltip>[0]) =>
      vehicleTooltip(info) ??
      roadblockTooltip(info, tRef.current) ??
      deckTooltip(info) ??
      detailTooltip(info) ??
      contextTooltip(info),
    [],
  );

  /* deckClick ignores `_vk` and `_rk`, so without this a puck or a barrier
     hovers but never selects. */
  const click = useMemo(
    () => (info: Parameters<typeof deckClick>[0]) =>
      vehicleClick(info) || roadblockClick(info) || deckClick(info) || pickSelect(info),
    [],
  );

  const overlay = useControl<MapboxOverlay>(
    () =>
      new MapboxOverlay({
        interleaved,
        layers: allLayers,
        getTooltip: tooltip,
        onClick: click,
      }),
  );

  overlay.setProps({ layers: allLayers, getTooltip: tooltip, onClick: click });

  return null;
}

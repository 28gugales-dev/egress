"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MapLibreMap } from "maplibre-gl";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import {
  type MapEvent,
  Map as MapGL,
  type MapLayerMouseEvent,
  type MapRef,
  type ViewState,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre";
import { getScenario } from "@/lib/constants";
import { actions, selBasemap, selLayers, selScenarioId, useEgress } from "@/lib/store";
import type { LngLat, ScenarioMeta } from "@/types/egress";
import { basemapStyle, DEM_SOURCE_ID, terrainSpec } from "./basemap-styles";

// ─────────────────────────────────────────────────────────────────────────────
// Fly-to bus. A window event rather than a store field: "go look at zone 7" is
// a one-shot imperative, not state, and putting it in the store would make it
// replay on every unrelated re-render.
// ─────────────────────────────────────────────────────────────────────────────

export const EGRESS_FLYTO_EVENT = "egress:flyto";

export interface FlyToDetail {
  center: LngLat;
  zoom?: number;
  /** Milliseconds. 0 jumps. */
  duration?: number;
}

export function flyTo(detail: FlyToDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FlyToDetail>(EGRESS_FLYTO_EVENT, { detail }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor bus. Same reasoning as fly-to: the pointer moves far faster than any
// plane should re-render, so the coordinate readout subscribes to an event and
// is the only thing in the tree that follows the mouse.
// ─────────────────────────────────────────────────────────────────────────────

export const EGRESS_CURSOR_EVENT = "egress:cursor";

export interface CursorDetail {
  lng: number;
  lat: number;
  zoom: number;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A one-shot camera command pushed down as a prop. The console shell owns the
 * `egress:flyto` listener for the un-split map and hands the result here; a
 * bumped `nonce` is what makes flying twice to the same place animate twice.
 */
export interface ViewStateOverride {
  longitude: number;
  latitude: number;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  duration?: number;
  nonce: number;
}

export interface MapShellProps {
  /** Defaults to the scenario the store currently points at. */
  scenario?: ScenarioMeta;
  children?: ReactNode;
  /** false disables every camera handler — the follower pane in split compare. */
  interactive?: boolean;
  /** Present => controlled camera. Absent => the map owns its own camera. */
  viewState?: Partial<ViewState>;
  /**
   * Passing this (even as null) means the caller owns `egress:flyto`, so the
   * shell stops listening for it and would otherwise fly twice per request.
   */
  viewStateOverride?: ViewStateOverride | null;
  onViewStateChange?: (viewState: ViewState) => void;
  onMapLoad?: (map: MapLibreMap) => void;
  /**
   * Added to the scenario's authored zoom, on the INITIAL view state only.
   * A map that no longer gets the whole window has to pull back or it frames a
   * fraction of the town; the caller measures its own box and passes the offset
   * once. Applying it later would fight the operator's own panning.
   */
  zoomAdjust?: number;
  /**
   * CSS pixels of this canvas's left edge that something opaque is standing on.
   *
   * The console's canvas runs the full width of the window with the panel sheet
   * floating over its left half, so without this the scenario centre projects
   * to the window's centre — which is the sheet's own right edge, putting the
   * town at the far edge of the strip anyone can read. MapLibre's camera
   * padding moves the projection centre to the middle of what is left, which is
   * the same framing the map had when it was a flex sibling.
   */
  padLeft?: number;
  /** Emit `egress:cursor` while the pointer is over this map. */
  reportCursor?: boolean;
}

const MAX_PITCH = 85;
/** deck.gl interleaved layers alias badly without MSAA on the shared context. */
const CANVAS_CONTEXT = { antialias: true } as const;
/** Terrain read flat from directly overhead, so the first enable tilts in. */
const TERRAIN_PITCH = 52;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function MapShell({
  scenario,
  children,
  interactive = true,
  viewState,
  viewStateOverride,
  onViewStateChange,
  onMapLoad,
  zoomAdjust = 0,
  padLeft = 0,
  reportCursor = false,
}: MapShellProps) {
  const basemap = useEgress(selBasemap);
  const layers = useEgress(selLayers);
  const scenarioId = useEgress(selScenarioId);
  const meta = scenario ?? getScenario(scenarioId);
  const mapRef = useRef<MapRef | null>(null);

  // Two shells mount side by side in split compare; a shared DOM id would make
  // the second one unaddressable. useId gives a per-instance one.
  const rawId = useId();
  const containerId = useMemo(() => `egress-map-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [rawId]);

  // react-map-gl compares mapStyle by reference and calls setStyle on any
  // change, so this must be one object per basemap per instance — not a fresh
  // build every render, and not a module singleton shared between instances.
  const mapStyle = useMemo(() => basemapStyle(basemap), [basemap]);

  const controlled = viewState !== undefined;
  /** A caller that passes viewStateOverride has claimed the event for itself. */
  const ownsFlyTo = viewStateOverride === undefined;

  const wantTerrain = basemap === "terrain" || layers.terrain;
  const wantTerrainRef = useRef(wantTerrain);
  wantTerrainRef.current = wantTerrain;

  const overrideRef = useRef(viewStateOverride);
  overrideRef.current = viewStateOverride;

  /**
   * setStyle drops terrain on the floor, and react-map-gl's own terrain prop
   * caches the last value it applied — so after a basemap swap it believes
   * terrain is still on and never re-sets it. Owning terrain imperatively and
   * re-asserting it on styledata is the only reliable fix.
   */
  const syncTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (!map.isStyleLoaded()) return;
    const current = map.getTerrain();
    if (wantTerrainRef.current) {
      if (current?.source === DEM_SOURCE_ID) return;
      if (!map.getSource(DEM_SOURCE_ID)) return;
      map.setTerrain(terrainSpec());
    } else if (current) {
      map.setTerrain(null);
    }
  }, []);

  /**
   * The container can change size without the window doing so — collapsing the
   * panel plane is exactly that. MapLibre only tracks the window, so it needs
   * telling.
   *
   * Trailing-debounced, not per-callback: the collapse animates over 180ms and
   * resizing a GL canvas plus the deck.gl overlay on every frame of that is
   * what drops the whole console. One resize once the box has settled.
   */
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const handleLoad = useCallback(
    (e: MapEvent) => {
      const map = e.target as MapLibreMap;
      // styledata fires before the style is fully loaded on the first pass, so
      // idle is the backstop that guarantees terrain lands after a swap.
      map.on("styledata", syncTerrain);
      map.on("idle", syncTerrain);
      syncTerrain();

      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
          if (resizeTimer.current) clearTimeout(resizeTimer.current);
          resizeTimer.current = setTimeout(() => {
            resizeTimer.current = null;
            mapRef.current?.getMap().resize();
          }, 120);
        });
        ro.observe(map.getContainer());
        observerRef.current = ro;
      }

      onMapLoad?.(map);
    },
    [onMapLoad, syncTerrain],
  );

  useEffect(() => {
    return () => {
      const map = mapRef.current?.getMap();
      map?.off("styledata", syncTerrain);
      map?.off("idle", syncTerrain);
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [syncTerrain]);

  /* One dispatch per animation frame at most. The readout that listens is a
     leaf; nothing else in the tree re-renders on pointer movement. */
  const cursorFrame = useRef(0);
  const handleMouseMove = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!reportCursor) return;
      if (cursorFrame.current) return;
      const map = e.target as MapLibreMap;
      const { lng, lat } = e.lngLat;
      cursorFrame.current = requestAnimationFrame(() => {
        cursorFrame.current = 0;
        window.dispatchEvent(
          new CustomEvent<CursorDetail>(EGRESS_CURSOR_EVENT, {
            detail: { lng, lat, zoom: map.getZoom() },
          }),
        );
      });
    },
    [reportCursor],
  );

  useEffect(() => () => cancelAnimationFrame(cursorFrame.current), []);

  useEffect(() => {
    syncTerrain();
    if (controlled || !wantTerrain) return;
    const map = mapRef.current?.getMap();
    if (!map || map.getPitch() >= 15) return;
    map.easeTo({ pitch: TERRAIN_PITCH, duration: prefersReducedMotion() ? 0 : 700 });
  }, [wantTerrain, controlled, syncTerrain]);

  /* Camera padding, re-asserted whenever the sheet's width changes.
     `applied` starts null so the FIRST application jumps: at mount the operator
     has not seen a camera yet, and animating from a framing nobody looked at is
     a 240ms wobble on load. After that the panel collapsing or restoring is a
     visible change, and the map slides to match it. */
  const paddingApplied = useRef<number | null>(null);
  useEffect(() => {
    if (controlled) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (paddingApplied.current === padLeft) return;
    const first = paddingApplied.current === null;
    paddingApplied.current = padLeft;
    map.easeTo({
      padding: { left: padLeft, top: 0, right: 0, bottom: 0 },
      duration: first || prefersReducedMotion() ? 0 : 240,
      essential: true,
    });
  }, [padLeft, controlled]);

  // Caller-driven fly-to. Keyed on nonce so a repeat request to the same
  // coordinates still animates.
  const overrideNonce = viewStateOverride?.nonce ?? null;
  useEffect(() => {
    if (controlled || overrideNonce === null) return;
    const o = overrideRef.current;
    const map = mapRef.current?.getMap();
    if (!map || !o) return;
    map.easeTo({
      center: [o.longitude, o.latitude],
      zoom: o.zoom ?? map.getZoom(),
      bearing: o.bearing ?? map.getBearing(),
      pitch: o.pitch ?? map.getPitch(),
      duration: prefersReducedMotion() ? 0 : (o.duration ?? 900),
      essential: true,
    });
  }, [overrideNonce, controlled]);

  useEffect(() => {
    // A controlled pane is driven by its partner; flying it directly would
    // fight the incoming viewState prop on the very next frame.
    if (controlled || !ownsFlyTo) return;
    const onFlyTo = (ev: Event) => {
      const detail = (ev as CustomEvent<FlyToDetail>).detail;
      const map = mapRef.current?.getMap();
      if (!map || !detail?.center) return;
      map.easeTo({
        center: detail.center,
        zoom: detail.zoom ?? map.getZoom(),
        duration: prefersReducedMotion() ? 0 : (detail.duration ?? 900),
        essential: true,
      });
    };
    window.addEventListener(EGRESS_FLYTO_EVENT, onFlyTo);
    return () => window.removeEventListener(EGRESS_FLYTO_EVENT, onFlyTo);
  }, [controlled, ownsFlyTo]);

  const handleClick = useCallback((e: MapLayerMouseEvent) => {
    // deck.gl's overlay marks a click handled when one of its layers picks an
    // object, so anything reaching here hit bare basemap.
    if (e.features && e.features.length > 0) return;
    actions.clearSelection();
  }, []);

  const handleMove = useCallback(
    (e: ViewStateChangeEvent) => {
      onViewStateChange?.(e.viewState);
    },
    [onViewStateChange],
  );

  const initialViewState = useMemo(
    () => ({
      longitude: meta.center[0],
      latitude: meta.center[1],
      zoom: meta.zoom + zoomAdjust,
      pitch: 0,
      bearing: 0,
    }),
    // Remounting on scenario change is the caller's job (key on scenario.id);
    // MapLibre reads this once.
    [meta.center, meta.zoom, zoomAdjust],
  );

  return (
    <MapGL
      ref={mapRef}
      id={containerId}
      initialViewState={initialViewState}
      {...(controlled ? viewState : null)}
      mapStyle={mapStyle}
      canvasContextAttributes={CANVAS_CONTEXT}
      maxPitch={MAX_PITCH}
      minZoom={7}
      maxZoom={19}
      attributionControl={{ compact: true }}
      dragPan={interactive}
      dragRotate={interactive}
      scrollZoom={interactive}
      boxZoom={interactive}
      keyboard={interactive}
      doubleClickZoom={interactive}
      touchZoomRotate={interactive}
      touchPitch={interactive}
      cursor={interactive ? undefined : "default"}
      onLoad={handleLoad}
      onMove={handleMove}
      onMouseMove={reportCursor ? handleMouseMove : undefined}
      onClick={handleClick}
      reuseMaps={false}
    >
      {children}
    </MapGL>
  );
}

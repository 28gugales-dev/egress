"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_PARAMS, DEFAULT_SCENARIO_ID } from "@/lib/constants";
import type {
  BasemapId,
  InspectorTab,
  LayerVisibility,
  MapColorBy,
  MapFilters,
  RunParams,
  Selection,
  Tick,
  ViewMode,
} from "@/types/egress";

/**
 * Minimal external store.
 *
 * Deliberately not React context: the time scrubber writes `t` up to 30x a
 * second while playing, and a context provider would re-render every consumer
 * on every tick. With useSyncExternalStore + a selector, only components that
 * actually read `t` re-render, and the deck.gl layer stack reads it once.
 */

export interface EgressState {
  scenarioId: string;
  /** Current playhead, seconds since T+0. */
  t: Tick;
  playing: boolean;
  /** Playback multiplier against real time. */
  speed: number;
  view: ViewMode;
  params: RunParams;
  basemap: BasemapId;
  colorBy: MapColorBy;
  layers: LayerVisibility;
  filters: MapFilters;
  selection: Selection;
  inspectorTab: InspectorTab;
  /** Left rail collapsed — for the presentation pass. */
  railCollapsed: boolean;
  inspectorCollapsed: boolean;
  /**
   * Incident feed collapsed to its one-line summary.
   *
   * The events themselves are NOT state: they are a pure function of the run on
   * disk and the playhead (see lib/incident-feed.ts), so putting a fired queue
   * in here would let the feed disagree with the timeline the moment anyone
   * scrubs backwards. Only the operator's own choice to fold it away lives here.
   */
  feedCollapsed: boolean;
  /** Set while a scenario's payloads are in flight. */
  loading: boolean;
  loadError: string | null;
}

export const INITIAL_STATE: EgressState = {
  scenarioId: DEFAULT_SCENARIO_ID,
  t: 0,
  playing: false,
  speed: 60,
  view: "planned",
  params: { ...DEFAULT_PARAMS },
  basemap: "satellite",
  colorBy: "status",
  layers: {
    hazard: true,
    flow: true,
    congestion: true,
    zones: true,
    noVehicle: false,
    facilities: true,
    busArcs: true,
    roadblocks: true,
    population: false,
    terrain: false,
    // Context layers: off until the operator asks for them. They explain the
    // picture; they never carry the argument.
    airQuality: false,
    aerosol: false,
    fireIntensity: false,
    smoke: false,
    transmission: false,
    socialVulnerability: false,
    fireWeather: false,
    slope: false,
    burnScars: false,
    // Detail layers: on, but invisible until the operator zooms past their
    // gate. Nothing to discover in a menu — zoom in and the town is there.
    buildings: true,
    blocks: true,
    streetLabels: true,
  },
  filters: {
    minUrgency: 0,
    statuses: [],
    facilityKinds: [],
    minNoVehicle: 0,
    query: "",
    maxHazardEta: null,
  },
  selection: { kind: null, id: null },
  inspectorTab: "queue",
  railCollapsed: false,
  inspectorCollapsed: false,
  feedCollapsed: false,
  loading: true,
  loadError: null,
};

type Listener = () => void;

let state: EgressState = INITIAL_STATE;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function getState(): EgressState {
  return state;
}

export function setState(patch: Partial<EgressState> | ((s: EgressState) => Partial<EgressState>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  let changed = false;
  for (const k of Object.keys(next) as (keyof EgressState)[]) {
    if (!Object.is(state[k], next[k])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...next };
  emit();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Subscribe to one slice. Re-renders only when that slice changes identity. */
export function useEgress<T>(selector: (s: EgressState) => T): T {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => selector(state), [selector]),
    useCallback(() => selector(INITIAL_STATE), [selector]),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions — every mutation goes through one of these, never setState inline in
// a component, so the state transitions stay greppable.
// ─────────────────────────────────────────────────────────────────────────────

export const actions = {
  setScenario(scenarioId: string) {
    setState({
      scenarioId,
      t: 0,
      playing: false,
      loading: true,
      loadError: null,
      selection: { kind: null, id: null },
    });
  },
  setT(t: Tick) {
    setState({ t: Math.max(0, t) });
  },
  advance(dt: Tick, max: Tick) {
    const next = state.t + dt;
    if (next >= max) {
      setState({ t: max, playing: false });
    } else {
      setState({ t: next });
    }
  },
  togglePlay() {
    setState({ playing: !state.playing });
  },
  setPlaying(playing: boolean) {
    setState({ playing });
  },
  setSpeed(speed: number) {
    setState({ speed });
  },
  setView(view: ViewMode) {
    setState({ view });
  },
  setParam<K extends keyof RunParams>(key: K, value: RunParams[K]) {
    setState({ params: { ...state.params, [key]: value } });
  },
  resetParams() {
    setState({ params: { ...DEFAULT_PARAMS } });
  },
  setBasemap(basemap: BasemapId) {
    setState({ basemap });
  },
  setColorBy(colorBy: MapColorBy) {
    setState({ colorBy });
  },
  toggleLayer(key: keyof LayerVisibility) {
    setState({ layers: { ...state.layers, [key]: !state.layers[key] } });
  },
  setLayer(key: keyof LayerVisibility, on: boolean) {
    setState({ layers: { ...state.layers, [key]: on } });
  },
  setFilter<K extends keyof MapFilters>(key: K, value: MapFilters[K]) {
    setState({ filters: { ...state.filters, [key]: value } });
  },
  resetFilters() {
    setState({ filters: { ...INITIAL_STATE.filters } });
  },
  select(kind: Selection["kind"], id: string | null) {
    setState({
      selection: { kind, id },
      // Selecting a zone should land you on the tab that explains it.
      inspectorTab: kind === "zone" ? "route" : kind === "vehicle" ? "teams" : state.inspectorTab,
      inspectorCollapsed: false,
    });
  },
  clearSelection() {
    setState({ selection: { kind: null, id: null } });
  },
  setInspectorTab(inspectorTab: InspectorTab) {
    setState({ inspectorTab });
  },
  toggleRail() {
    setState({ railCollapsed: !state.railCollapsed });
  },
  toggleInspector() {
    setState({ inspectorCollapsed: !state.inspectorCollapsed });
  },
  toggleFeed() {
    setState({ feedCollapsed: !state.feedCollapsed });
  },
  setLoading(loading: boolean, loadError: string | null = null) {
    setState({ loading, loadError });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Selector helpers — exported so components import a stable function reference
// rather than defining an inline arrow that breaks memoisation.
// ─────────────────────────────────────────────────────────────────────────────

export const selT = (s: EgressState) => s.t;
export const selPlaying = (s: EgressState) => s.playing;
export const selSpeed = (s: EgressState) => s.speed;
export const selScenarioId = (s: EgressState) => s.scenarioId;
export const selView = (s: EgressState) => s.view;
export const selParams = (s: EgressState) => s.params;
export const selBasemap = (s: EgressState) => s.basemap;
export const selColorBy = (s: EgressState) => s.colorBy;
export const selLayers = (s: EgressState) => s.layers;
export const selFilters = (s: EgressState) => s.filters;
export const selSelection = (s: EgressState) => s.selection;
export const selInspectorTab = (s: EgressState) => s.inspectorTab;
export const selRailCollapsed = (s: EgressState) => s.railCollapsed;
export const selInspectorCollapsed = (s: EgressState) => s.inspectorCollapsed;
export const selFeedCollapsed = (s: EgressState) => s.feedCollapsed;
export const selLoading = (s: EgressState) => s.loading;
export const selLoadError = (s: EgressState) => s.loadError;

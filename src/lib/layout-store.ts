"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Layout state, kept in its own external store beside lib/store.ts.
 *
 * Not React context, for store.ts's own stated reason and one more: collapsing
 * the panel plane or switching a work pane would otherwise re-render every
 * consumer of the console — including the deck.gl layer stack, which is the
 * most expensive tree in the app and cares about none of this.
 *
 * Separate from EgressState rather than merged into it because store.ts is
 * owned by another workflow this session; a sibling store adds layout state
 * with zero edits to that file. The coupling is one-directional by rule: a
 * component may read the egress store and write layout, never the reverse.
 */

export interface LayoutState {
  /**
   * Layout axis: is the panel column on screen. Never call this "split" — the
   * word belongs to baseline-vs-planned comparison and nothing else.
   *
   * ONE field for both layouts, wide and narrow. There used to be a second,
   * `stacked`, for which plane won below 1280 — and the two could disagree, so
   * the backslash key flipped `plane` while narrow and appeared to do nothing.
   * A hidden panel whose only restore control lives inside the hidden panel is
   * a one-way door; two fields that can disagree about whether it is hidden is
   * how that door got built.
   */
  plane: "both" | "map";
  workPane: "sequence" | "inspect" | "control";
  argument: "full" | "strip";
  /** Map bezel popover. Only one is ever open. */
  bezelPopover: "none" | "layers" | "legend";
}

export const INITIAL_LAYOUT: LayoutState = {
  plane: "both",
  workPane: "sequence",
  argument: "full",
  bezelPopover: "none",
};

type Listener = () => void;

/* Nothing here is persisted. getServerSnapshot has to return a value derived
   from a stable object or hydration mismatches, and there is no layout state
   worth the risk of a stale localStorage value opening the console in a state
   nobody chose. */
let state: LayoutState = INITIAL_LAYOUT;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function getLayout(): LayoutState {
  return state;
}

export function setLayout(patch: Partial<LayoutState>) {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof LayoutState)[]) {
    if (!Object.is(state[k], patch[k])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Subscribe to one slice. Re-renders only when that slice changes identity. */
export function useLayout<T>(selector: (s: LayoutState) => T): T {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => selector(state), [selector]),
    useCallback(() => selector(INITIAL_LAYOUT), [selector]),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions — every mutation goes through one of these, so the transitions stay
// greppable exactly as they do in store.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const layoutActions = {
  setPlane(plane: LayoutState["plane"]) {
    setLayout({ plane });
  },
  togglePlane() {
    setLayout({ plane: state.plane === "both" ? "map" : "both" });
  },
  /** The one way back. Called by the map bezel's restore control, which is the
   *  affordance that exists OUTSIDE the thing it un-hides. */
  showPanel() {
    setLayout({ plane: "both" });
  },
  setWorkPane(workPane: LayoutState["workPane"]) {
    setLayout({ workPane });
  },
  setArgument(argument: LayoutState["argument"]) {
    setLayout({ argument });
  },
  collapseArgument() {
    setLayout({ argument: "strip" });
  },
  setBezelPopover(bezelPopover: LayoutState["bezelPopover"]) {
    setLayout({ bezelPopover });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Selectors — exported so components import a stable function reference rather
// than defining an inline arrow that breaks memoisation.
// ─────────────────────────────────────────────────────────────────────────────

export const selPlane = (s: LayoutState) => s.plane;
export const selWorkPane = (s: LayoutState) => s.workPane;
export const selArgument = (s: LayoutState) => s.argument;
export const selBezelPopover = (s: LayoutState) => s.bezelPopover;

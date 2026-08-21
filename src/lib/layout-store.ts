"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Layout state, kept in its own external store beside lib/store.ts.
 *
 * Not React context, for store.ts's own stated reason and one more: switching a
 * work pane or opening a map popover would otherwise re-render every consumer
 * of the console — including the deck.gl layer stack, which is the most
 * expensive tree in the app and cares about none of this.
 *
 * Separate from EgressState rather than merged into it because store.ts is
 * owned by another workflow this session; a sibling store adds layout state
 * with zero edits to that file. The coupling is one-directional by rule: a
 * component may read the egress store and write layout, never the reverse.
 */

export interface LayoutState {
  /**
   * Which LAYOUT the console is in, and the only field that answers it.
   *
   * "both"  the panel column down the left with the map beside it, framed by
   *         its own control strips. The default, and the working layout.
   * "map"   the two-column design: a full-bleed map with one modal down each
   *         side and nothing else over the geography.
   *
   * ONE FIELD, and that is not negotiable. There used to be a second — a
   * `stacked` flag for which plane won below 1280 — and the two could disagree,
   * so the key that switched layouts flipped this one while the other still
   * said the panel was hidden, and the only control that could bring it back
   * was inside the thing it had hidden. A one-way door built out of two
   * booleans describing the same thing. Per-modal collapse flags on top of this
   * field would rebuild exactly that door, which is why the fold affordance IS
   * this axis: the Panel|Map segment in the SITUATION band, mounted in the
   * column that is on screen in both states.
   */
  plane: "both" | "map";
  /**
   * Which screen the work band's navigation rail has selected. ONE field for
   * the rail's selection too — a separate `railScreen` beside this would be the
   * `stacked` mistake above, rebuilt one register lower.
   *
   * INSPECT is in this union but not always on screen. In map view the
   * inspector is a permanent modal down the right of the window, so a work pane
   * mounting a second copy of it would put the same dock on screen twice —
   * WorkBand drops the entry there and coerces a stale value rather than
   * storing a second, plane-dependent field that could disagree with this one.
   *
   * TRANSPORT and POLICE are APPENDED, never inserted. The digit hotkeys are an
   * entry's 1-based position in `workPanesFor()`, so slotting either of them
   * before CONTROL would silently move what key 3 does.
   */
  workPane: "sequence" | "inspect" | "control" | "transport" | "police";
  argument: "full" | "strip";
  /** Map popover. Only one is ever open. */
  bezelPopover: "none" | "layers" | "legend";
  /**
   * Operator-dragged sheet widths, in px. Null means "use the layout's own
   * clamp" — an explicit number only appears once someone has actually dragged,
   * so the responsive default keeps working at every window size until they
   * override it, and a narrow window does not inherit a width chosen on a wide
   * one.
   *
   * Session-only, like everything else here. See the note above on
   * getServerSnapshot: a width restored from storage would render server-side
   * as the default and client-side as the stored value, which is a hydration
   * mismatch on the largest element in the tree.
   */
  leftWidth: number | null;
  rightWidth: number | null;
}

export const INITIAL_LAYOUT: LayoutState = {
  plane: "both",
  workPane: "sequence",
  argument: "full",
  bezelPopover: "none",
  leftWidth: null,
  rightWidth: null,
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
  /** Px, already clamped by the caller — the clamp needs the window width and
   *  the sibling sheet's width, neither of which the store knows. */
  setLeftWidth(leftWidth: number | null) {
    setLayout({ leftWidth });
  },
  setRightWidth(rightWidth: number | null) {
    setLayout({ rightWidth });
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
export const selLeftWidth = (s: LayoutState) => s.leftWidth;
export const selRightWidth = (s: LayoutState) => s.rightWidth;
export const selWorkPane = (s: LayoutState) => s.workPane;
export const selArgument = (s: LayoutState) => s.argument;
export const selBezelPopover = (s: LayoutState) => s.bezelPopover;

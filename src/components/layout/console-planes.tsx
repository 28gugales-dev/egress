"use client";

import "./console-planes.css";

import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InspectorPlane } from "@/components/layout/inspector-plane";
import { MapPlane } from "@/components/layout/map-plane";
import { PanelPlane } from "@/components/layout/panel-plane";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { workPanesFor } from "@/components/layout/work-band";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import {
  getLayout,
  layoutActions,
  selArgument,
  selLeftWidth,
  selPlane,
  selRightWidth,
  selWorkPane,
  useLayout,
} from "@/lib/layout-store";
import { selLoading, selScenarioId, selSelection, useEgress } from "@/lib/store";

/**
 * The console, as planes — and as TWO layouts on one axis.
 *
 * PANEL VIEW is the working layout: the panel column down the left, the map
 * beside it, framed by its own control strip above the geography and its key
 * strip below. The inspector is a pane of the panel's work band.
 *
 * MAP VIEW is the two-column design: a full-bleed map with one modal down each
 * side and nothing else on the geography. The map's two strips fold into the
 * left sheet as its first and last rows; the inspector becomes the right sheet,
 * with the incident feed merged in beneath it. Both sheets run the full window
 * height. The map has no frame there because the sheets are the frame.
 *
 * THE MAP IS FULL-BLEED IN BOTH. The canvas is `absolute inset-0` under
 * everything and every sheet is one `.glass-thin` surface over it, with the map
 * continuing underneath. That continuation is not a nicety: a translucent sheet
 * with nothing behind it to refract is just a different solid, and the first
 * version of this layout made the two planes flex siblings so the map began
 * exactly where the panel ended.
 *
 * ONE AXIS, ONE FIELD, and the control that crosses it lives in the SITUATION
 * band — which is mounted in the column that is on screen in BOTH states. That
 * is the whole rule, and lib/layout-store.ts records the version of this
 * console that broke it: a second field disagreeing about whether the panel was
 * hidden, and the only way back living inside the thing that was hidden.
 *
 * Takes no props. Everything is derived from useBundle() and the two stores,
 * which is what keeps the shell's adoption of it down to a single element.
 */

/**
 * THE SHEETS DO NOT ANIMATE THEIR WIDTH, and the reason is measured, not
 * stylistic. They carried `transition-[width] duration-[180ms]`, and a keyboard
 * step from 480 to 1152 read 480 at 1.2s and 1152 at 2.7s: `width` is not a
 * compositable property, so every frame of that ease relayouts the map beside
 * it, and the "180ms" ease ran an order of magnitude over budget. Under a drag
 * it is worse than slow -- each pointermove sets a new target and restarts an
 * ease that never finishes, so the sheet trails the pointer instead of tracking
 * it. The axis switch and the drag both snap now.
 */

/**
 * The panel column in PANEL VIEW.
 *
 * Half and half up to 2240, so the split is exactly even from 1280 upward and
 * the map takes the surplus above that. The cap is measured, not chosen: the
 * release table's widest tier needs 836px and the control grid packs 288px
 * columns, so a panel past ~1120 is buying whitespace with geography.
 */
const PANEL_WIDTH = "clamp(640px, 50vw, 1120px)";

/**
 * The two sheets in MAP VIEW, and the window they are solved for.
 *
 * ONE expression each, passed to the map plane rather than duplicated there —
 * two copies of a clamp are two things that can drift, and the failure mode is
 * a popover opening a few pixels under the glass where nobody notices until it
 * is on a projector.
 *
 * The floors are the binding constraint and they come from the narrowest window
 * this is verified at, 900px: the two sheets take 760 and the map keeps 140.
 * Thin, but a real strip of geography, and both sheets stay honest rather than
 * one stacking over the other.
 *
 * 496 for the left sheet is what its own contents need, not a round number: the
 * release table's narrowest tier has a measured 416px min-content, over 24px of
 * padding and a 1px seam. 264 for the right is the inspector's five-tab strip
 * plus a queue row that can still print an id and a countdown side by side.
 * They are narrower than the panel column above because in this layout the map
 * is the point, and a second sheet is being paid for out of the same window.
 */
/* Drag bounds. The floors are measured min-contents, not round numbers, and the
   left one MOVED when the work band grew its navigation rail.

   440 was the release table's narrowest tier plus the column's padding and its
   seam. The rail takes 40px plus a 1px rule out of that band at every width,
   and map view spends 20 more on the sheet's margin, so the binding case is the
   left sheet dragged to its floor in map view:

     370 table min-content + 41 rail + 24 padding + 2 border + 20 margin = 457

   480 rounds that up with room for the seam's grab target rather than sitting
   on the number. Below it the release table starts scrolling sideways inside
   its own scroller, which hides MARGIN — the one column that says whether a
   wave makes it — behind a scrollbar, and does so without ever overflowing the
   page, so nothing external catches it.

   Both responsive clamps floor above this (496 in map view, 640 in panel view),
   so nothing changes until an operator drags. MAX_SHARE stops EITHER sheet from
   taking so much that the map stops being the thing you are looking at. */
const LEFT_MIN = 480;
const RIGHT_MIN = 264;
const MAX_SHARE = 0.6;

/* THE TWO SHEETS SHARE ONE BUDGET, and MAX_SHARE alone did not say so: 0.6 each
   is 1.2 of the window, and driving both to their own maximum in map view put
   the inspector's right edge at x=2334 on a 1920 viewport. Nothing caught it --
   the root is overflow: hidden, so the sheet was CLIPPED rather than scrolled,
   and every overflow check on this layout reads zero while 414px of a column
   sits off screen with its controls on it.

   MAP_MIN is the strip of geography that is not negotiable. The map is the
   thing this console is looking at; a layout that can push it to nothing is a
   layout that can delete the subject. */
const MAP_MIN = 320;

const MAP_LEFT_WIDTH = "clamp(496px, 46vw, 940px)";
const MAP_RIGHT_WIDTH = "clamp(264px, 18vw, 336px)";

export function ConsolePlanes() {
  const loading = useEgress(selLoading);
  const scenarioId = useEgress(selScenarioId);
  const selection = useEgress(selSelection);
  const plane = useLayout(selPlane);
  const workPane = useLayout(selWorkPane);
  const argument = useLayout(selArgument);
  const bundle = useBundle();

  const scenario = bundle?.meta ?? getScenario(scenarioId);
  /* The provider owns `loading`; treat an arrived bundle as authoritative so a
     stale flag can never leave the console veiled over a drawable map. */
  const veiled = loading && bundle === null;
  const simMissing = bundle !== null && bundle.baseline === null && bundle.planned === null;

  const mapView = plane === "map";
  const dragLeft = useLayout<number | null>(selLeftWidth);
  const dragRight = useLayout<number | null>(selRightWidth);

  /* The window, measured, because the drag clamps need a number and a clamp()
     expression is not one. Only read after mount — on the server there is no
     window and the sheets fall back to their responsive defaults, which is the
     correct SSR output either way. */
  const [winW, setWinW] = useState(0);
  useEffect(() => {
    const measure = () => setWinW(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /* A dragged width wins over the clamp, and ONLY over the clamp: the min and
     max below still apply, so a width chosen at 1920 cannot survive onto a
     900px window as a sheet wider than the console. */
  /* LEFT IS RESOLVED FIRST AND THE RIGHT SHEET YIELDS TO IT. The order is a
     decision, not an implementation detail: the left column is the work surface
     -- the release sequence, the controls, the response screens -- and the
     right one inspects whatever the left or the map selected. When the window
     cannot hold both at the width someone asked for, the inspector is the one
     that should give way.

     So the left cap only has to leave room for the map and a floor-width
     inspector, while the right cap is whatever survives after the left sheet
     has taken its resolved width. */
  const win = winW || 1920;
  const rightFloor = mapView ? RIGHT_MIN : 0;
  const leftCap = Math.max(LEFT_MIN, Math.min(win * MAX_SHARE, win - MAP_MIN - rightFloor));
  const clampLeft = (n: number) => Math.min(Math.max(n, LEFT_MIN), leftCap);

  /**
   * ONE function resolves a resting width, and both the sheet's style and the
   * handle's announced value read it.
   *
   * They used to be computed separately, and disagreed: the style applied the
   * CSS clamp -- floor 640 in panel view, 496 in map view -- while the handle
   * announced a raw 50vw with no floor at all, so a 1000px window put the sheet
   * at its 640 floor and told a screen reader it was 500. aria-valuenow on a
   * separator IS the control's value to anyone not looking at it.
   *
   * Zero is the pre-measure state, where the CSS clamp is still the right
   * answer: it is correct at every window size without JavaScript and it is
   * what the server emitted, so the first paint matches. The swap to px lands
   * on the same measured value and nothing moves.
   */
  const restingLeft = (w: number) =>
    mapView ? Math.min(940, Math.max(496, w * 0.46)) : Math.min(1120, Math.max(640, w * 0.5));
  const restingRight = (w: number) => Math.min(336, Math.max(264, w * 0.18));

  /* Resolved left FIRST, because the right cap is measured against it. The
     RESTING width goes through the same clamp as a dragged one: at 1024 the
     responsive floor resolves to 496 against a 480 cap, and leaving it
     unclamped both stole the map's last 16px and made the handle announce a
     value above the maximum it was announcing in the same breath. */
  const leftPx = dragLeft !== null ? clampLeft(dragLeft) : clampLeft(Math.round(restingLeft(win)));
  const rightCap = Math.max(RIGHT_MIN, Math.min(win * MAX_SHARE, win - MAP_MIN - leftPx));
  const clampRight = (n: number) => Math.min(Math.max(n, RIGHT_MIN), rightCap);
  const rightPx =
    dragRight !== null ? clampRight(dragRight) : clampRight(Math.round(restingRight(win)));

  const leftWidth =
    dragLeft !== null || winW ? `${leftPx}px` : mapView ? MAP_LEFT_WIDTH : PANEL_WIDTH;
  const rightWidth = !mapView
    ? "0px"
    : dragRight !== null || winW
      ? `${rightPx}px`
      : MAP_RIGHT_WIDTH;

  /**
   * Follow a NEW selection onto the pane that can render it — PANEL VIEW ONLY.
   *
   * In map view the inspector is a sheet that is already on screen, so there is
   * nothing to route to and moving the work band would take the release table
   * away from someone who did not ask.
   *
   * Two guards, both deliberate. The ref means a repeated identical selection
   * does not yank the pane out from under a reading operator. The
   * `workPane === "sequence"` condition means someone who deliberately opened
   * CONTROL with a zone selected is not thrown out of it — and it limits the
   * blast radius of the upstream bug where the zone polygon eats road clicks
   * inside town, so a click meant for a corridor returns a zone.
   */
  const lastSelection = useRef<string | null>(null);
  useEffect(() => {
    // Cold load has no selection, and a map click on bare basemap clears one —
    // MapShell's own handler fires after deck.gl's pick, so a click INSIDE a
    // zone lands as clear-then-select. Remembering only the last non-empty key
    // is what stops that churn from reading as a brand new selection and
    // yanking the pane every time the same zone is clicked twice.
    if (!selection.kind || !selection.id) return;
    const key = `${selection.kind}:${selection.id}`;
    if (key === lastSelection.current) return;
    lastSelection.current = key;
    if (plane === "both" && workPane === "sequence") layoutActions.setWorkPane("inspect");
  }, [selection, workPane, plane]);

  /**
   * The argument band is loud on use one and a spine on use one hundred. It
   * folds itself the first time the operator leaves SEQUENCE for real work,
   * and the chevron brings it back for good.
   */
  const argumentFolded = useRef(false);
  useEffect(() => {
    if (argumentFolded.current) return;
    if (typeof window !== "undefined" && window.innerHeight < 900) {
      argumentFolded.current = true;
      layoutActions.collapseArgument();
      return;
    }
    if (workPane !== "sequence" && argument === "full") {
      argumentFolded.current = true;
      layoutActions.collapseArgument();
    }
  }, [workPane, argument]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Two panes contain a text field. Without this, typing "1" into the
      // filter search box switches panes instead of filtering.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;

      // The digit is the pane's position in the strip the operator is looking
      // at, read from the same function the strip renders from — map view has
      // no Inspect tab, and a hard-coded 2 would mean two different things
      // depending on a layout the keymap could not see.
      const panes = workPanesFor(getLayout().plane);
      const index = Number.parseInt(e.key, 10) - 1;
      const chosen = Number.isNaN(index) ? undefined : panes[index];
      if (chosen) layoutActions.setWorkPane(chosen.id);
      else if (e.key === "\\") layoutActions.togglePlane();
      else if (e.key === "Escape") layoutActions.setBezelPopover("none");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      data-plane={plane}
      className="relative flex h-dvh w-full overflow-hidden bg-background text-foreground"
    >
      {/* min-w-0 is stated rather than inferred, and so is overflow-hidden on
          the column itself: the SITUATION band's cells are deliberately nowrap
          and the release table has a 416px min-content, so this column's own
          min-content runs past its floor. Only `overflow: hidden` on the item
          zeroes a flex item's automatic minimum size, and relying on that side
          effect to keep the console free of a horizontal scrollbar is a trap
          for whoever removes it. */}
      <div
        className="plane-seam glass-thin plane-sheet relative z-10 flex min-h-0 min-w-0 flex-none flex-col overflow-hidden"
        style={{ width: leftWidth }}
      >
        <PanelPlane />
        <ResizeHandle
          edge="right"
          width={leftPx}
          min={LEFT_MIN}
          max={leftCap}
          onResize={layoutActions.setLeftWidth}
          onReset={() => layoutActions.setLeftWidth(null)}
          label="Resize the control column"
        />
      </div>

      {/* The visible map, as a flex item rather than a calculation. Nothing is
          rendered into it — the map plane is absolute behind all three columns
          — but its width is what the sheets leave over, so it is the one place
          the layout states that fact. */}
      <div className="pointer-events-none relative z-10 min-w-0 flex-1" aria-hidden />

      {/* Zero width in panel view rather than unmounted, so the inspector's own
          selection bus and tab routing keep running across the axis. `inert` because a 0px column still
          holds focusable controls: without it Tab walks the whole tab strip at
          x=-264 before reaching anything on screen. */}
      <div
        className="plane-seam-right glass-thin plane-sheet relative z-10 flex min-h-0 min-w-0 flex-none flex-col overflow-hidden"
        style={{ width: rightWidth }}
        inert={!mapView}
        aria-hidden={!mapView}
      >
        <InspectorPlane />
        {mapView ? (
          <ResizeHandle
            edge="left"
            width={rightPx}
            min={RIGHT_MIN}
            max={rightCap}
            onResize={layoutActions.setRightWidth}
            onReset={() => layoutActions.setRightWidth(null)}
            label="Resize the inspector column"
          />
        ) : null}
      </div>

      <MapPlane
        /* Absolute, under all three columns. As a flex sibling the canvas would
           start where the left sheet ended, and a sheet with a hard edge of
           nothing behind it cannot be glass. */
        className="absolute inset-0 z-0"
        leftInset={leftWidth}
        rightInset={rightWidth}
        veiled={veiled}
        notice={simMissing ? <SimNotice /> : null}
      />

      {veiled ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div className="glass flex items-center gap-3 px-4 py-3">
            <span className="loading-sweep relative block h-[3px] w-24 overflow-hidden rounded-full bg-glass-inset" />
            <span className="label-mono">Loading {scenario.name}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Quiet, permanent-until-fixed: the map is real, the numbers are not there. */
function SimNotice() {
  return (
    <div className="glass pointer-events-auto flex max-w-[min(100%,620px)] items-center gap-2.5 px-3 py-1.5">
      <TriangleAlert
        size={13}
        strokeWidth={1.75}
        className="shrink-0"
        style={{ color: "var(--warn)" }}
      />
      <span className="text-[11.5px] leading-snug text-subtle">
        Zones, hazard and facilities are loaded. No simulation on disk, so clearance figures stay
        blank.
      </span>
      <span className="readout shrink-0 whitespace-nowrap text-[11px] text-foreground">
        pnpm data:simulate
      </span>
    </div>
  );
}

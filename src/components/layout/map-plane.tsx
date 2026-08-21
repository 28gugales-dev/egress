"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SplitView } from "@/components/compare/split-view";
import {
  LayersPopover,
  LegendFlyout,
  MapControlRow,
  MapKeyRow,
} from "@/components/layout/map-controls";
import { DeckOverlay } from "@/components/map/deck-layers";
import { MapKey } from "@/components/map/key-modal";
import { MapShell } from "@/components/map/map-shell";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { clamp, cx } from "@/lib/format";
import { selPlane, useLayout } from "@/lib/layout-store";
import { selScenarioId, selView, useEgress } from "@/lib/store";
import type { RunKind } from "@/types/egress";

/**
 * The map plane: a canvas that bleeds to all four window edges, with the
 * console's sheets floating on it.
 *
 * The canvas is FULL-WINDOW IN BOTH LAYOUTS and the sheets float over it, so
 * the map continues under the glass instead of stopping at a hard edge — that
 * continuation is the only reason a sheet can read as glass at all.
 *
 * WHAT THE PLANE CHANGES HERE. In panel view this plane draws the map's own
 * frame: an opaque control strip along the top of the visible geography and a
 * key strip along the bottom, both built from the shared rows in map-controls.
 * In map view the frame is the two sheets themselves, so the strips are not
 * mounted and their rows appear inside the left sheet instead. Same components,
 * same order, different parent.
 *
 * Everything that floats over the map is parented into ONE box — `visibleRef` —
 * whose left and right edges are the sheets' inner edges. That box is both the
 * geometry every floater is positioned against and the single measurement of
 * how much map the operator can actually see. Two copies of that arithmetic is
 * two things that can drift, and the failure mode is a popover opening a few
 * pixels under the glass where nobody notices until it is on a projector.
 */

/**
 * Reference width for the zoom pull-back.
 *
 * 900 is chosen so the canonical 960px map plane at a 1920 viewport gets
 * exactly 0 — no change at the design target. The visible strip is narrower now
 * that a sheet stands on both sides, so this reaches its -0.6 floor at the
 * narrow end rather than sitting near zero.
 */
const ZOOM_REFERENCE = 900;

/** Gap kept between the hover tooltip and the visible map's right edge — which
 *  is the right sheet's seam, not the window. */
const TOOLTIP_MARGIN = 8;

/** How long the camera waits before re-centring on a changed sheet width. The
 *  sheets follow the window rather than animating, so this only has to outlast
 *  a drag-resize's stream of events. */
const PAD_SETTLE_MS = 220;

function zoomAdjustFor(width: number): number {
  if (width <= 0) return 0;
  return clamp(Math.log2(width / ZOOM_REFERENCE), -0.6, 0);
}

export function MapPlane({
  className,
  leftInset,
  rightInset,
  veiled = false,
  notice,
}: {
  className?: string;
  /** How much of the window's left edge the left sheet covers, as a CSS length.
   *  The caller owns the expression; this plane only frames what is left over. */
  leftInset: string;
  /** Same, for the right sheet. */
  rightInset: string;
  veiled?: boolean;
  notice?: ReactNode;
}) {
  const view = useEgress(selView);
  const scenarioId = useEgress(selScenarioId);
  const plane = useLayout(selPlane);
  const bundle = useBundle();
  /* Panel view is the one that needs a frame drawn on the geography; map view's
     frame is the sheets. */
  const framed = plane === "both";
  const scenario = bundle?.meta ?? getScenario(scenarioId);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  /* The visible-map box. Its content box IS the strip of geography nobody is
     standing on, measured rather than derived — the canvas box would answer
     "the whole window" and every camera decision downstream would be made
     against terrain a sheet is covering. */
  const visibleRef = useRef<HTMLDivElement | null>(null);
  /* Measured once, before the map mounts: MapShell reads initialViewState on
     its first render and never again, so a later measurement would arrive too
     late to matter — and re-keying the map to apply one would throw away the
     camera the operator had. */
  const [zoomAdjust, setZoomAdjust] = useState<number | null>(null);
  /* What the camera believes the sheets cover. Deliberately late — see the
     settle timer below. */
  const [pad, setPad] = useState({ left: 0, right: 0 });
  const padTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = visibleRef.current;
    if (!el) return;
    setZoomAdjust((prev) => (prev === null ? zoomAdjustFor(el.clientWidth) : prev));
    const measure = () => {
      const box = el.getBoundingClientRect();
      const canvas = canvasRef.current?.getBoundingClientRect();
      const left = Math.max(0, box.left - (canvas?.left ?? 0));
      const right = Math.max(0, (canvas?.right ?? box.right) - box.right);
      /* Feeding padding on every frame of a drag-resize would restart a camera
         animation on each one, so the value after things stop moving is the one
         that lands. */
      if (padTimer.current) clearTimeout(padTimer.current);
      padTimer.current = setTimeout(() => {
        padTimer.current = null;
        setPad((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
      }, PAD_SETTLE_MS);
    };
    measure();
    /* A window listener BESIDE the observer, not instead of it. Observer
       deliveries are tied to the rendering pipeline, so a throttled or
       backgrounded document can leave the camera padded for a window size it no
       longer has. */
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
      if (padTimer.current) clearTimeout(padTimer.current);
    };
  }, []);

  /**
   * Keep deck.gl's hover tooltip inside the VISIBLE map.
   *
   * deck's default tooltip anchors at the cursor and extends rightwards with no
   * flip, so a hover near the right seam used to push it under the inspector
   * sheet — and the canvas bleeds to the window edge, so clamping to the window
   * is not enough now that a modal stands in front of the last 300px of it.
   *
   * deck owns the element and rewrites its inline left/top on every move, so
   * this reads the position deck just wrote and corrects it. It converges: the
   * clamp is applied only while the element overflows, and after one write it
   * does not.
   */
  useEffect(() => {
    const host = canvasRef.current;
    if (!host || typeof MutationObserver === "undefined") return;

    const clampInto = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const limit =
        (visibleRef.current?.getBoundingClientRect().right ?? window.innerWidth) - TOOLTIP_MARGIN;
      const overflow = rect.right - limit;
      if (overflow <= 0) return;
      const left = Number.parseFloat(el.style.left || "0");
      el.style.left = `${left - overflow}px`;
    };

    const sweep = () => {
      for (const el of host.querySelectorAll<HTMLElement>(".deck-tooltip")) clampInto(el);
    };

    const mo = new MutationObserver(sweep);
    mo.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => mo.disconnect();
  }, []);

  const activeRun = view === "baseline" ? (bundle?.baseline ?? null) : (bundle?.planned ?? null);

  /* One overlay instance per half in compare. `idPrefix` is not cosmetic:
     deck.gl keys layers by id, so two unprefixed stacks collide and the second
     pane silently takes over the first pane's layers. */
  const renderCompareOverlay = useCallback(
    (kind: RunKind) => (
      <DeckOverlay
        run={kind === "baseline" ? (bundle?.baseline ?? null) : (bundle?.planned ?? null)}
        idPrefix={kind}
      />
    ),
    [bundle],
  );

  const canvas = useMemo(() => {
    if (view === "split") {
      /* Compare is the one view that does NOT bleed. Two panes are a figure to
         be read side by side, not a continuous surface, and half of either pane
         parked under a sheet would put a run where nobody can see it. Both
         insets, because there is a sheet on both sides now. */
      return (
        <div className="h-full" style={{ marginLeft: leftInset, marginRight: rightInset }}>
          <SplitView className="h-full" renderOverlay={renderCompareOverlay} />
        </div>
      );
    }
    if (zoomAdjust === null) return null;
    return (
      // MapShell reads initialViewState once, so the scenario key is what
      // actually recentres the camera on a scenario swap. DeckOverlay must be a
      // CHILD of MapShell: it registers through react-map-gl's useControl,
      // which resolves the map instance from context.
      <MapShell
        key={scenario.id}
        scenario={scenario}
        zoomAdjust={zoomAdjust}
        padLeft={pad.left}
        padRight={pad.right}
        reportCursor
      >
        <DeckOverlay run={activeRun} />
      </MapShell>
    );
  }, [view, zoomAdjust, pad, leftInset, rightInset, scenario, activeRun, renderCompareOverlay]);

  return (
    /* NO `relative` here. The caller positions this plane absolutely, and a
       position utility baked into the base list does not lose to one passed in
       `className` -- Tailwind resolves the winner by its own layer order, not
       by the order of the class attribute. With both present `relative` won and
       the full-bleed canvas this whole layout depends on never happened. */
    <div className={cx("bg-sunken", className)}>
      {/* The canvas, running to all four window edges and continuing under both
          sheets. */}
      <div
        ref={canvasRef}
        className={cx(
          "absolute inset-0 z-0 transition-opacity duration-500",
          veiled && "opacity-35",
        )}
      >
        {canvas}
      </div>

      {/* The visible map. Transparent to the pointer, so a drag started
          anywhere in it reaches the canvas underneath; each floater re-arms its
          own hit target. */}
      <div
        ref={visibleRef}
        className="pointer-events-none absolute inset-y-0 z-10"
        style={{ left: leftInset, right: rightInset }}
      >
        {framed ? (
          <>
            {/* The map's own frame, and the reason the canvas is not inset
                behind it: the strips sit ON the geography at its top and bottom
                edges, opaque, so what the operator sees is framed rather than
                overlapped. Nothing else is ever drawn over the canvas. */}
            <div className="pointer-events-auto absolute inset-x-0 top-0 z-20 flex h-[30px] items-center border-hairline border-b bg-sunken px-2">
              <MapControlRow className="min-w-0 flex-1" />
            </div>
            <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex h-7 items-center gap-3 border-hairline border-t bg-sunken px-2">
              <MapKeyRow className="min-w-0 flex-1" />
              <MapKey />
            </div>
          </>
        ) : null}

        {notice ? (
          <div
            className={cx(
              "absolute inset-x-0 z-20 flex justify-center px-3",
              framed ? "top-[42px]" : "top-3",
            )}
          >
            {notice}
          </div>
        ) : null}

        {/* The key, in map view only: with no bottom strip to seat it, it is a
            28px circle in the corner furthest from anything the operator
            reads. */}
        {framed ? null : (
          <div className="pointer-events-auto absolute right-3 bottom-3 z-20">
            <MapKey />
          </div>
        )}

        <LayersPopover side={framed ? "right" : "left"} />
        <LegendFlyout side={framed ? "right" : "left"} />
      </div>
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SplitView } from "@/components/compare/split-view";
import {
  BezelBottom,
  type BezelTier,
  BezelTop,
  BezelTransport,
  LayersPopover,
  LegendFlyout,
} from "@/components/layout/map-bezel";
import { DeckOverlay } from "@/components/map/deck-layers";
import { MapShell } from "@/components/map/map-shell";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { clamp, cx } from "@/lib/format";
import { selPlane, useLayout } from "@/lib/layout-store";
import { selScenarioId, selView, useEgress } from "@/lib/store";
import type { RunKind } from "@/types/egress";

/**
 * The map plane: two bezel strips with the canvas inset between them.
 *
 * Zero padding, bleeding to the window's top, right and bottom edges. Nothing
 * is ever drawn over the canvas except a hover tooltip and the two bezel
 * popovers, which are explicitly transient.
 */

/**
 * Reference width for the zoom pull-back.
 *
 * 900 is chosen so the canonical 960px map plane at a 1920 viewport gets
 * exactly 0 — no change at the design target. At a 1280 viewport the plane is
 * 640 and this returns -0.49, taking Camp Fire's authored 12.2 to 11.71
 * (~36 m/px), where 640px still covers ~23 km against a zone-set E-W extent of
 * about 18 km.
 */
const ZOOM_REFERENCE = 900;

/** Gap kept between the hover tooltip and the window's right edge. */
const TOOLTIP_MARGIN = 8;

/**
 * What the top bezel can seat, measured rather than guessed.
 *
 * Every number below came off the running strip at a 1920 window: views
 * segment 180, provenance chip 85, "Colour by" label 61, colour-by segment
 * 198, Layers button 66, basemap segment 120, 8px gaps and 8px of padding a
 * side. So the strip needs 766px to hold all of it, 697 without the label, and
 * 569 once the basemap segment has folded away too.
 *
 * The single 900px threshold this replaces was set by eye, and it cost a click
 * it did not have to: at a 1440 window this plane is 720, comfortably past the
 * 697 the basemap segment actually needs, yet the segment was in the popover
 * with 23px of strip still empty.
 */
const BEZEL_FULL_ABOVE = 766;
const BEZEL_BASEMAP_ABOVE = 697;
const BEZEL_COLOURBY_ABOVE = 573;

/** Panel restore button plus its gap. Present only while the panel is hidden,
 *  and it is the one control in the strip that must never be squeezed out —
 *  it is the only way back to the console. */
const BEZEL_RESTORE_COST = 74;

function bezelTierFor(width: number, panelHidden: boolean): BezelTier {
  const avail = width - (panelHidden ? BEZEL_RESTORE_COST : 0);
  if (avail >= BEZEL_FULL_ABOVE) return "full";
  if (avail >= BEZEL_BASEMAP_ABOVE) return "compact";
  if (avail >= BEZEL_COLOURBY_ABOVE) return "tight";
  return "minimal";
}

function zoomAdjustFor(width: number): number {
  if (width <= 0) return 0;
  return clamp(Math.log2(width / ZOOM_REFERENCE), -0.6, 0);
}

export function MapPlane({
  className,
  veiled = false,
  notice,
}: {
  className?: string;
  veiled?: boolean;
  notice?: ReactNode;
}) {
  const view = useEgress(selView);
  const scenarioId = useEgress(selScenarioId);
  const plane = useLayout(selPlane);
  const bundle = useBundle();
  const scenario = bundle?.meta ?? getScenario(scenarioId);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  /* Measured once, before the map mounts: MapShell reads initialViewState on
     its first render and never again, so a later measurement would arrive too
     late to matter — and re-keying the map to apply one would throw away the
     camera the operator had. */
  const [zoomAdjust, setZoomAdjust] = useState<number | null>(null);
  const [bezelWidth, setBezelWidth] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    setZoomAdjust((prev) => (prev === null ? zoomAdjustFor(el.clientWidth) : prev));
    const measure = () => setBezelWidth(el.clientWidth);
    measure();
    /* A window listener BESIDE the observer, not instead of it. This plane
       changes width twice for reasons a ResizeObserver is not guaranteed to
       deliver promptly: when the console crosses 1280 the plane stops being a
       flex sibling and becomes `absolute inset-0`, and when the panel collapses
       the width animates. Observer deliveries are tied to the rendering
       pipeline, so a throttled or backgrounded document can leave the strip
       showing the tier it had before the switch. */
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, []);

  /* Zero is the pre-measure state. Fall back to the design target rather than
     to the narrowest tier, so the first paint is not a flash of folded-away
     controls. */
  const tier = bezelWidth > 0 ? bezelTierFor(bezelWidth, plane === "map") : "full";
  /* And once more after every render, deliberately without a dependency list.
     Two things change this plane's width without resizing anything the observer
     watches on that frame: crossing 1280 turns it from a flex sibling into
     `absolute inset-0`, and the restore control appears with `plane`, changing
     the strip's budget rather than its box. React bails out when the width is
     unchanged, so the steady-state cost is one clientWidth read per render. */
  useEffect(() => {
    const el = canvasRef.current;
    if (el) setBezelWidth(el.clientWidth);
  });

  /**
   * Keep deck.gl's hover tooltip inside the window.
   *
   * This plane bleeds to the window's right edge on purpose, and deck's default
   * tooltip anchors at the cursor and extends rightwards with no flip — so at
   * a 1920 window a hover at x=1880 put the tooltip's right edge at 2131, and
   * the rightmost ~260px of geography could not show a readable one. The old
   * shell never exposed this because the inspector dock occluded that strip.
   *
   * deck owns the element and rewrites its inline left/top on every move, so
   * this reads the position deck just wrote and corrects it. It converges: the
   * clamp is applied only while the element overflows, and after one write it
   * does not.
   */
  useEffect(() => {
    const host = canvasRef.current;
    if (!host || typeof MutationObserver === "undefined") return;

    const clamp2 = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const overflow = rect.right - (window.innerWidth - TOOLTIP_MARGIN);
      if (overflow <= 0) return;
      const left = Number.parseFloat(el.style.left || "0");
      el.style.left = `${left - overflow}px`;
    };

    const sweep = () => {
      for (const el of host.querySelectorAll<HTMLElement>(".deck-tooltip")) clamp2(el);
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
      return <SplitView className="h-full" renderOverlay={renderCompareOverlay} />;
    }
    if (zoomAdjust === null) return null;
    return (
      // MapShell reads initialViewState once, so the scenario key is what
      // actually recentres the camera on a scenario swap. DeckOverlay must be a
      // CHILD of MapShell: it registers through react-map-gl's useControl,
      // which resolves the map instance from context.
      <MapShell key={scenario.id} scenario={scenario} zoomAdjust={zoomAdjust} reportCursor>
        <DeckOverlay run={activeRun} />
      </MapShell>
    );
  }, [view, zoomAdjust, scenario, activeRun, renderCompareOverlay]);

  return (
    // Position comes from the caller: in stacked mode this plane is absolutely
    // placed behind the panel, and a `relative` baked in here would fight it.
    <div className={cx("flex min-w-0 flex-col bg-sunken", className)}>
      <BezelTop tier={tier} />

      <div
        ref={canvasRef}
        className={cx(
          "relative min-h-0 flex-1 transition-opacity duration-500",
          veiled && "opacity-35",
        )}
      >
        {canvas}
        {notice ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
            {notice}
          </div>
        ) : null}
      </div>

      <BezelBottom />
      <BezelTransport />
      <LayersPopover tier={tier} />
      <LegendFlyout />
    </div>
  );
}

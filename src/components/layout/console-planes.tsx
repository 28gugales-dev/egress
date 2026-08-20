"use client";

import "./console-planes.css";

import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MapChrome } from "@/components/layout/map-chrome";
import { MapPlane } from "@/components/layout/map-plane";
import { PanelPlane } from "@/components/layout/panel-plane";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { cx } from "@/lib/format";
import { layoutActions, selArgument, selPlane, selWorkPane, useLayout } from "@/lib/layout-store";
import { selLoading, selScenarioId, selSelection, useEgress } from "@/lib/store";

/**
 * The console, as two planes side by side.
 *
 * A PANEL plane carrying every piece of chrome, and a MAP plane that nothing
 * overlaps. There is no floating-overlay mode to fall back to, on purpose: the
 * inspector dock's left edge used to sit at x=1280 of 1600 while the hazard
 * front rendered at x~1250-1300, so the console occluded the thing it exists
 * to show. A layout you can be in wrongly is a layout that will be wrong on
 * stage.
 *
 * THE MAP IS FULL-BLEED AND THE PANEL FLOATS ON IT. The panel used to be
 * `bg-surface` — opaque — and the two planes were flex siblings, so the map
 * began exactly where the panel ended. That made glass impossible rather than
 * merely unused: a translucent sheet with nothing behind it to refract is just
 * a different solid. So the map plane is `absolute inset-0` under everything
 * and the panel is one `.glass-thin` sheet over it, with the map continuing
 * underneath. Only the map's own bezel strips are inset, because those are a
 * frame around the VISIBLE geography and would otherwise slide under the sheet.
 *
 * HALF AND HALF, UP TO 2240. The panel is clamp(640px, 50vw, 1120px), so the
 * split is exactly even from 1280 to 2240 and the map takes the surplus above
 * that — 56% of a 2560 window, 71% of a 3840 one. The cap is deliberate and the
 * number behind it is measured: the release table's widest tier needs 836px and
 * the control grid packs 288px columns, so a panel past ~1120 is buying
 * whitespace with geography. Above 2240 this is a map-led layout that keeps a
 * full-size panel, and calling it a 50/50 split would be a claim the pixels do
 * not support.
 *
 * The escape hatch is not a second layout, it is a width state of the same DOM:
 * `plane: "map"` animates the panel column to zero. Same tree, no remount, the
 * map never re-initialises. Getting back out is BezelTop's restore control,
 * which lives in the plane that stays on screen — see the note on `plane` in
 * lib/layout-store.ts for why that is not negotiable.
 *
 * Takes no props. Everything is derived from useBundle() and the two stores,
 * which is what keeps the shell's adoption of it down to a single element.
 */

/** Below this the planes stack and one shows at a time. 1280 is the point
 *  where a 640px map still frames Paradise and 640px still holds the release
 *  table; it is a floor, not a breakpoint ladder. */
const STACK_BELOW = 1280;

/** Matches the panel column's width transition in console-planes.css terms —
 *  kept here because the element that animates is authored here too. */
const COLLAPSE_MS = 180;

/**
 * The panel column's width — and, handed to the map plane, the left inset of
 * its bezel strips.
 *
 * ONE expression, passed rather than duplicated. The map plane now spans the
 * whole window, so its frame has to be told where the sheet ends; two copies of
 * this clamp would be two things that can drift, and the failure mode is a
 * bezel row sliding a few pixels under the glass where nobody notices until it
 * is on a projector.
 */
const PANEL_WIDTH = "clamp(640px, 50vw, 1120px)";

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

  /* Starts false on the server and on the first client render, so the two agree
     and hydration is quiet; the media query lands a frame later. */
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${STACK_BELOW - 1}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /**
   * Follow a NEW selection onto the pane that can render it.
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
    if (workPane === "sequence") layoutActions.setWorkPane("inspect");
  }, [selection, workPane]);

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

      // Choosing a work pane implies wanting to see it. This is also a second
      // keyboard route out of map-only mode, which matters because the state
      // used to be escapable by exactly one undocumented key.
      if (e.key === "1") {
        layoutActions.setWorkPane("sequence");
        layoutActions.showPanel();
      } else if (e.key === "2") {
        layoutActions.setWorkPane("inspect");
        layoutActions.showPanel();
      } else if (e.key === "3") {
        layoutActions.setWorkPane("control");
        layoutActions.showPanel();
      } else if (e.key === "\\") layoutActions.togglePlane();
      else if (e.key === "Escape") layoutActions.setBezelPopover("none");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* One resize, at the end of the collapse. MapShell's own observer is the
     backstop; this is what makes the settle crisp rather than a frame late.
     MapLibre tracks the window, so a window resize event is the cheapest way
     to reach every map on screen without holding a reference to any of them. */
  const onPanelTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== "width") return;
    window.dispatchEvent(new Event("resize"));
  };

  /* One predicate for both layouts. Narrow hides the panel by stacking the map
     over it; wide hides it by animating the column to zero. Same state, so the
     backslash key and the bezel's restore control mean the same thing at every
     width. */
  const panelVisible = plane === "both";
  const panelWidth = narrow ? "100%" : panelVisible ? PANEL_WIDTH : "0px";
  /* Stacked mode puts the panel ON the map rather than beside it, so the map's
     frame owes it no room: the inset is the width the sheet actually takes out
     of the geography, which below 1280 is none of it. */
  const bezelInset = narrow ? "0px" : panelWidth;

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <div
        onTransitionEnd={onPanelTransitionEnd}
        // overflow-hidden on the column itself, not just the root: the release
        // table's 703px min-content would otherwise throw a horizontal
        // scrollbar across the whole console while the column is shrinking.
        // min-w-0 is stated rather than inferred. The SITUATION band's cells
        // are deliberately nowrap, so this column's min-content is around
        // 700px; only `overflow: hidden` on the item itself zeroes a flex
        // item's automatic minimum size, and relying on that side effect to
        // keep the collapse working is a trap for whoever removes it.
        className={cx(
          "plane-seam glass-thin flex min-h-0 min-w-0 flex-none flex-col overflow-hidden",
          narrow ? "absolute inset-0 z-10" : "relative z-10 transition-[width] duration-[180ms]",
          narrow && !panelVisible && "invisible",
        )}
        style={{
          width: panelWidth,
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
          transitionDuration: narrow ? "0ms" : `${COLLAPSE_MS}ms`,
        }}
        /* `inert` and not just aria-hidden: a 0px column still held eighteen
           focusable controls, so Tab walked through the scenario chip, the
           pane tabs and the validation line at x=-30 before reaching anything
           on screen. inert takes them out of the tab order and the a11y tree
           together, and unlike display:none it does not kill the width
           transition. */
        inert={!panelVisible}
        aria-hidden={!panelVisible}
      >
        <PanelPlane />
      </div>

      <MapPlane
        /* Absolute in BOTH layouts, not just the stacked one. As a flex sibling
           the canvas started where the panel ended, and a sheet with a hard
           edge of nothing behind it cannot be glass. */
        className="absolute inset-0 z-0"
        bezelInset={bezelInset}
        veiled={veiled}
        notice={simMissing ? <SimNotice /> : null}
        /* Only when the panel is collapsed. With both planes up the chrome
           lives in its own plane and the canvas stays clean. */
        chrome={panelVisible ? null : <MapChrome />}
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

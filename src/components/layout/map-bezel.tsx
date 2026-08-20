"use client";

import { Layers, PanelLeft, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { ContextLayerToggles } from "@/components/map/context-layers";
import { HazardProvenanceChip } from "@/components/map/hazard-provenance-chip";
import { MapKey } from "@/components/map/key-modal";
import { MapLegend } from "@/components/map/map-legend";
import { type CursorDetail, EGRESS_CURSOR_EVENT } from "@/components/map/map-shell";
import { LayersSection } from "@/components/rail/layers-section";
import { useBundle } from "@/lib/bundle-context";
import { getScenario, ZONE_STATUS_LABEL, ZONE_STATUS_VAR } from "@/lib/constants";
import { clamp, cx, formatTick, formatWallClock } from "@/lib/format";
import { layoutActions, selBezelPopover, selPlane, useLayout } from "@/lib/layout-store";
import {
  actions,
  selBasemap,
  selColorBy,
  selPlaying,
  selScenarioId,
  selSpeed,
  selT,
  selView,
  useEgress,
} from "@/lib/store";
import type { BasemapId, MapColorBy, ViewMode, ZoneStatus } from "@/types/egress";

/**
 * The map's own chrome, as a bezel rather than an overlay.
 *
 * The canvas is inset BELOW the top strip and ABOVE the bottom strip, so this
 * is a frame around the geography, not something parked on it — "the right half
 * is map and nothing but map" then holds literally for every pixel of terrain.
 * Only a hover tooltip is ever allowed over the canvas.
 */

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "planned", label: "Planned" },
  { id: "baseline", label: "Baseline" },
  // The layout axis is PANEL/MAP; this axis is COMPARE. The word "split" never
  // appears in the interface — only in ViewMode's literal value, which is not
  // ours to rename.
  { id: "split", label: "Compare" },
];

const COLOR_BY: { id: MapColorBy; label: string; hint: string }[] = [
  { id: "status", label: "Status", hint: "Zone status" },
  { id: "urgency", label: "ETA", hint: "Time to hazard" },
  { id: "load", label: "Load", hint: "Egress route load — which road is the bottleneck" },
  { id: "vulnerability", label: "Vulnerable", hint: "No-vehicle / mobile-home share" },
];

const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: "satellite", label: "Sat" },
  { id: "dark", label: "Dark" },
  { id: "terrain", label: "Relief" },
];

const STATUS_ORDER: ZoneStatus[] = ["held", "ordered", "flowing", "cleared", "cutoff"];

/** Matches scrubber.tsx. Forked rather than imported for the reason every fork
 *  in this layout is: timeline/ belongs to another workflow. */
const SPEEDS = [1, 30, 60, 120];

/**
 * How much of itself the top bezel shows.
 *
 * Four steps, each one dropping the least load-bearing thing left:
 *   full     everything, including the COLOUR BY label
 *   compact  the label goes
 *   tight    the basemap segment moves into the Layers popover
 *   minimal  the colour-by segment follows it
 *
 * Chosen by measured content width in map-plane.tsx, never by a viewport
 * breakpoint. The minimal tier exists because in map-only mode at a 480px
 * window the strip still has to seat the Panel control that is the only way
 * back to the console, and that control never yields to anything.
 */
export type BezelTier = "full" | "compact" | "tight" | "minimal";

/** The key that toggles the panel column, named wherever it is offered. */
const PLANE_KEY = "\\";

/**
 * The way back.
 *
 * This control is the entire reason map-only mode is a mode and not a trap. The
 * Panel|Map segment that puts the console into it lives INSIDE the panel, and
 * once the column animates to zero with overflow-hidden that segment stops
 * being hit-testable: elementFromPoint at its own coordinates returned the
 * maplibre canvas. Every hittable control on screen belonged to this bezel, and
 * none of them came back. An affordance that un-hides a thing has to live in
 * the thing that stays on screen.
 */
function PanelRestore() {
  return (
    <button
      type="button"
      onClick={() => layoutActions.showPanel()}
      title={`Restore the panel — key ${PLANE_KEY}`}
      className="flex flex-none cursor-pointer items-center gap-1.5 rounded-sm border border-hairline bg-glass-inset px-2 py-[3px] text-[10px] text-subtle transition-colors hover:bg-glass-hover hover:text-foreground"
    >
      <PanelLeft size={11} strokeWidth={1.75} />
      Panel
    </button>
  );
}

export function BezelTop({ tier = "full" }: { tier?: BezelTier }) {
  const view = useEgress(selView);
  const colorBy = useEgress(selColorBy);
  const basemap = useEgress(selBasemap);
  const popover = useLayout(selBezelPopover);
  const plane = useLayout(selPlane);

  return (
    <div className="relative z-20 flex h-[30px] flex-none items-center gap-2 border-hairline border-b bg-sunken px-2">
      {plane === "map" ? <PanelRestore /> : null}

      <div className="seg bezel-seg">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            data-on={view === v.id}
            onClick={() => actions.setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Clickable, because the chip already answers half of "what is this
          frame made of" for free and the other half was three clicks away —
          Inspect, then Detail, then "Inspect hazard frame", because the dock's
          tab strip does not exist until the Inspect pane is selected. Selecting
          the hazard is enough on its own: the dock re-routes to DETAIL when the
          active tab cannot handle the selection's kind. */}
      <button
        type="button"
        onClick={() => {
          actions.select("hazard", "current");
          layoutActions.setWorkPane("inspect");
          // Nothing to route to if the panel is off screen.
          layoutActions.showPanel();
        }}
        title="Open this hazard frame in the inspector"
        className="flex min-w-0 cursor-pointer items-center rounded-sm transition-colors hover:bg-glass-hover"
      >
        <HazardProvenanceChip className="flat-surface" compact />
      </button>

      <div className="ml-auto flex items-center gap-2">
        {tier === "full" ? <span className="label-mono">Colour by</span> : null}
        {tier === "minimal" ? null : <ColorBySeg colorBy={colorBy} />}

        <button
          type="button"
          aria-expanded={popover === "layers"}
          onClick={() => layoutActions.setBezelPopover(popover === "layers" ? "none" : "layers")}
          className={cx(
            "flex cursor-pointer items-center gap-1.5 rounded-sm border border-hairline px-2 py-[3px] text-[10px] transition-colors",
            popover === "layers"
              ? "bg-glass-active text-foreground"
              : "bg-glass-inset text-subtle hover:bg-glass-hover hover:text-foreground",
          )}
        >
          <Layers size={11} strokeWidth={1.75} />
          Layers
        </button>

        {/* At a narrow map plane the basemap moves into the Layers popover
            rather than wrapping the strip onto a second line — a bezel that
            reflows is a bezel that stops reading as a frame. */}
        {tier === "tight" || tier === "minimal" ? null : <BasemapSeg basemap={basemap} />}
      </div>
    </div>
  );
}

function ColorBySeg({ colorBy }: { colorBy: MapColorBy }) {
  return (
    <div className="seg bezel-seg">
      {COLOR_BY.map((c) => (
        <button
          key={c.id}
          type="button"
          title={c.hint}
          data-on={colorBy === c.id}
          onClick={() => actions.setColorBy(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function BasemapSeg({ basemap }: { basemap: BasemapId }) {
  return (
    <div className="seg bezel-seg">
      {BASEMAPS.map((b) => (
        <button
          key={b.id}
          type="button"
          data-on={basemap === b.id}
          onClick={() => actions.setBasemap(b.id)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

/** The layers popover. Genuinely floats over the map, so it keeps its glass.
 *  Takes in whichever segments the strip could not seat, so nothing the bezel
 *  drops becomes unreachable — it only becomes one click further away. */
export function LayersPopover({ tier = "full" }: { tier?: BezelTier }) {
  const popover = useLayout(selBezelPopover);
  const basemap = useEgress(selBasemap);
  const colorBy = useEgress(selColorBy);
  if (popover !== "layers") return null;
  return (
    <div
      /* lg-surface: this floats over the map rather than living in a plane, so
         it is the same register as the key and the scenario picker and takes
         the same light refractive ground. `glass` stays for the radius, border
         and scroll behaviour it shares with the rest of the deck. */
      className="thin-scroll glass lg-surface absolute top-[34px] right-2 z-30 max-h-[min(66vh,520px)] w-[248px] overflow-y-auto pb-2"
    >
      <LayersSection />
      <ContextLayerToggles />
      {tier === "minimal" ? (
        <div className="px-3 pt-4">
          <div className="label-mono mb-2">Colour by</div>
          <ColorBySeg colorBy={colorBy} />
        </div>
      ) : null}
      {tier === "tight" || tier === "minimal" ? (
        <div className="px-3 pt-4">
          <div className="label-mono mb-2">Basemap</div>
          <BasemapSeg basemap={basemap} />
        </div>
      ) : null}
    </div>
  );
}

/** MapLegend, mounted for the first time. It self-filters to the layers that
 *  are actually on, so it is wrapped and positioned here and never edited. */
export function LegendFlyout({ inset = "0px" }: { inset?: string }) {
  const popover = useLayout(selBezelPopover);
  if (popover !== "legend") return null;
  return (
    /* Anchored to the VISIBLE map's left edge, not the plane's. The plane now
       spans the window, so a plain `left-2` opens this behind the panel sheet —
       one of the few floaters in this file that is left-hung and therefore the
       only one the full-bleed canvas could hide. */
    <div className="absolute bottom-[32px] z-30" style={{ left: `calc(${inset} + 0.5rem)` }}>
      <MapLegend className="max-h-[min(46vh,300px)]" />
    </div>
  );
}

function CursorReadout() {
  const [cursor, setCursor] = useState<CursorDetail | null>(null);

  /* A window event rather than a prop: the pointer moves far faster than React
     should re-render a plane, and this leaf is the only thing that has to
     follow it. MapShell throttles the dispatch to one per animation frame. */
  useEffect(() => {
    const onMove = (e: Event) => setCursor((e as CustomEvent<CursorDetail>).detail ?? null);
    window.addEventListener(EGRESS_CURSOR_EVENT, onMove);
    return () => window.removeEventListener(EGRESS_CURSOR_EVENT, onMove);
  }, []);

  if (!cursor) return null;
  return (
    <span className="readout whitespace-nowrap text-[10px] text-faint tabular-nums">
      z {cursor.zoom.toFixed(1)} · {cursor.lat.toFixed(4)}, {cursor.lng.toFixed(4)}
    </span>
  );
}

export function BezelBottom() {
  const popover = useLayout(selBezelPopover);

  return (
    <div className="relative z-20 flex h-7 flex-none items-center gap-3 border-hairline border-t bg-sunken px-2">
      {/* Permanent key. The five status hues are on screen at all times, and
          the full legend is one click away — replacing a 12px "?" glyph whose
          affordance nobody found. */}
      <button
        type="button"
        aria-expanded={popover === "legend"}
        onClick={() => layoutActions.setBezelPopover(popover === "legend" ? "none" : "legend")}
        className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 transition-colors hover:bg-glass-hover"
        title="Open the full map legend"
      >
        {STATUS_ORDER.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span
              aria-hidden
              className="size-[8px] flex-none rounded-[2px]"
              style={{ background: ZONE_STATUS_VAR[s] }}
            />
            <span className="text-[9px] leading-none text-faint">{ZONE_STATUS_LABEL[s]}</span>
          </span>
        ))}
      </button>

      <div className="ml-auto flex items-center gap-3">
        <CursorReadout />
        <MapKey />
      </div>
    </div>
  );
}

/**
 * Transport, for the state where the panel is not on screen.
 *
 * Every time control the console had — the scrubber, play, the four speeds and
 * the T+ / wall-clock readout — lives in band 4 of the panel column, so all of
 * it was clipped in map-only mode. The arrow keys still stepped the playhead,
 * which is worse than nothing: the operator could scrub and had no way to see
 * what time they had scrubbed to. Full-bleed geography and time replay were
 * mutually exclusive.
 *
 * A strip below the bezel rather than controls dropped onto the canvas, for the
 * rule the whole plane exists to keep: nothing is drawn over the map. It is
 * mounted only while the panel is hidden, so the console never carries two of
 * the same control at once.
 *
 * The scrubber itself keeps running behind the collapsed column — it is hidden,
 * never unmounted — so this drives the same rAF loop rather than a second one.
 */
export function BezelTransport() {
  const plane = useLayout(selPlane);
  const t = useEgress(selT);
  const playing = useEgress(selPlaying);
  const speed = useEgress(selSpeed);
  const scenarioId = useEgress(selScenarioId);
  const bundle = useBundle();

  const meta = bundle?.meta ?? getScenario(scenarioId);
  if (plane !== "map") return null;

  return (
    <div className="relative z-20 flex h-[34px] flex-none items-center gap-3 border-hairline border-t bg-sunken px-2">
      <button
        type="button"
        onClick={() => actions.togglePlay()}
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        className="glass-inset glass-inset-hover flex h-[22px] w-[22px] flex-none items-center justify-center rounded-sm text-foreground"
      >
        {playing ? <Pause size={12} strokeWidth={1.75} /> : <Play size={12} strokeWidth={1.75} />}
      </button>

      <div className="flex flex-none items-baseline gap-2">
        <span className="readout text-[12.5px] text-foreground">{formatTick(t)}</span>
        <span className="label-mono whitespace-nowrap">
          {formatWallClock(meta.eventDate, t, meta.startHourLocal)}
        </span>
      </div>

      {/* A bare track. The panel's scrubber carries the wave marks, the
          burnover tick and the provenance band, and reproducing those in a
          34px strip would be a second, worse instrument rather than a way
          back to the first one. */}
      <input
        type="range"
        className="rng min-w-0 flex-1"
        min={0}
        max={meta.duration}
        step={meta.frameStep}
        value={clamp(t, 0, meta.duration)}
        aria-label="Playhead"
        onChange={(e) => actions.setT(Number(e.target.value))}
      />

      <div className="seg bezel-seg flex-none">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            data-on={speed === s}
            onClick={() => actions.setSpeed(s)}
            aria-label={`${s} times speed`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}

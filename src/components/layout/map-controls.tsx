"use client";

import { Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { ContextLayerToggles } from "@/components/map/context-layers";
import { HazardProvenanceChip } from "@/components/map/hazard-provenance-chip";
import { MapLegend } from "@/components/map/map-legend";
import { type CursorDetail, EGRESS_CURSOR_EVENT } from "@/components/map/map-shell";
import { LayersSection } from "@/components/rail/layers-section";
import { ZONE_STATUS_LABEL, ZONE_STATUS_VAR } from "@/lib/constants";
import { cx } from "@/lib/format";
import { layoutActions, selBezelPopover, useLayout } from "@/lib/layout-store";
import { actions, selBasemap, selColorBy, selView, useEgress } from "@/lib/store";
import type { BasemapId, MapColorBy, ViewMode, ZoneStatus } from "@/types/egress";

/**
 * The map's controls: ONE definition, TWO mount points.
 *
 * This file used to author two strips of its own — a 30px frame across the top
 * of the geography and a 28px one across the bottom, each with its contents
 * inlined. That was fine while there was one layout. There are two now, and the
 * alternative to this file was a second pair of strips for map view: two
 * definitions of the views segment, two of the colour-by axis, two status keys,
 * and a guarantee that a change to one of them would eventually not reach the
 * other.
 *
 * So the STRIPS went and the CONTROLS stayed, as two rows that do not care what
 * is around them:
 *
 *   panel view  map-plane.tsx frames the geography with them, exactly where the
 *               bezels were — MapControlRow above it, MapKeyRow below.
 *   map view    panel-plane.tsx mounts them as the left sheet's first and last
 *               rows, at the SAME heights. The move is sideways, out of the
 *               geography and into the sheet, and nothing else.
 *
 * The two popovers live here too, because both genuinely float over the map in
 * both layouts — only the edge they fly out of changes, and that follows the
 * trigger. See PopoverSide.
 */

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "planned", label: "Planned" },
  { id: "baseline", label: "Baseline" },
  // The layout axis is PANEL/MAP; this axis is COMPARE. The word "split" never
  // appears in the interface — only in ViewMode's literal value, which is not
  // ours to rename.
  { id: "split", label: "Compare" },
];

/* Labels are the SHORT form now, and the hints carry the long one. "Vulnerable"
   was 10 characters in a segment that has to survive a 496px sheet, and a
   segment which truncates reads "S… E… L… V…" — four buttons that say nothing
   at the width where saying something matters most. */
const COLOR_BY: { id: MapColorBy; label: string; hint: string }[] = [
  { id: "status", label: "Status", hint: "Zone status" },
  { id: "urgency", label: "ETA", hint: "Time to hazard" },
  { id: "load", label: "Load", hint: "Egress route load — which road is the bottleneck" },
  { id: "vulnerability", label: "Vuln", hint: "Vulnerable — no-vehicle / mobile-home share" },
];

const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: "satellite", label: "Sat" },
  { id: "dark", label: "Dark" },
  { id: "terrain", label: "Relief" },
];

const STATUS_ORDER: ZoneStatus[] = ["held", "ordered", "flowing", "cleared", "cutoff"];

/** Which side of the visible map a popover flies out of. It follows the
 *  TRIGGER, not the layout: in panel view the Layers button is at the right end
 *  of a strip above the geography, and in map view it is inside the left sheet.
 *  A popover that opens on the far side of the map from the control that opened
 *  it is a popover the operator has to go looking for. */
export type PopoverSide = "left" | "right";

/**
 * WHAT EARNED PERMANENT SPACE, and what did not.
 *
 * The brief was "more compact", not "relocated", so the old strip's contents
 * were re-argued one at a time rather than stacked onto the modal:
 *
 *   VIEWS      Planned / Baseline / Compare is the most-used control in the
 *              console. It leads the row.
 *   COLOUR BY  changes what every polygon on the map MEANS, so it stays on the
 *              face — but the "Colour by" label above it does not. Four buttons
 *              reading Status / ETA / Load / Vuln do not need a fifth word
 *              telling you they are a colour choice, and the tooltips carry the
 *              long form. That is 61px and one whole tier of the old fold-away
 *              ladder deleted outright.
 *   LAYERS     one button, and it is the door everything below is behind.
 *   PROVENANCE the only thing on screen that says whether the hazard frame is
 *              an observed perimeter or an interpolation between two, so it
 *              stays. It is also the one item here that can be given up: at a
 *              narrow row it folds (see `.chip-fold` in console-planes.css),
 *              and the fact survives in the scrubber's own MODELLED / OBSERVED
 *              band four rows down, which is in the same sheet at every width.
 *   BASEMAP    moved into the Layers popover UNCONDITIONALLY. It was already
 *              the first thing the old width ladder dropped, and it is a
 *              once-a-session choice sitting next to controls used once a
 *              minute. Losing the ladder with it is the point: four measured
 *              width tiers existed only to decide when to hide this segment.
 */
export function MapControlRow({ className }: { className?: string }) {
  const view = useEgress(selView);
  const colorBy = useEgress(selColorBy);
  const popover = useLayout(selBezelPopover);

  return (
    <div className={cx("map-control-row flex h-[28px] items-center gap-2", className)}>
      {/* NO `min-w-0` on a .seg or its buttons, and that is load-bearing rather
          than tidy. `.seg > button` is `flex: 1`, i.e. flex-basis 0, so each
          button's max-content CONTRIBUTION to the segment's intrinsic width is
          only its automatic minimum size. Zero that with min-w-0 and the
          segment's max-content collapses to its padding: it truncated to
          "Comp…" and "St…" inside a 944px strip with 420px of empty space
          beside it. The rows give up width by FOLDING, in the container queries
          in console-planes.css, never by squeezing a control until its labels
          stop being words. */}
      <div className="seg bezel-seg flex-none">
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
          frame made of" for free and the other half was three clicks away.
          Selecting the hazard is enough on its own: the dock re-routes to
          DETAIL when the active tab cannot handle the selection's kind. */}
      <button
        type="button"
        onClick={() => actions.select("hazard", "current")}
        title="Open this hazard frame in the inspector"
        className="chip-fold flex min-w-0 shrink cursor-pointer items-center overflow-hidden rounded-sm transition-colors hover:bg-glass-hover"
      >
        <HazardProvenanceChip className="flat-surface" compact />
      </button>

      <div className="ml-auto flex flex-none items-center gap-2">
        <div className="colourby-fold flex flex-none">
          <ColorBySeg colorBy={colorBy} />
        </div>

        <button
          type="button"
          aria-expanded={popover === "layers"}
          onClick={() => layoutActions.setBezelPopover(popover === "layers" ? "none" : "layers")}
          className={cx(
            "flex flex-none cursor-pointer items-center gap-1.5 rounded-sm border border-hairline px-2 py-[3px] text-[10px] transition-colors",
            popover === "layers"
              ? "bg-glass-active text-foreground"
              : "bg-glass-inset text-subtle hover:bg-glass-hover hover:text-foreground",
          )}
        >
          <Layers size={11} strokeWidth={1.75} />
          Layers
        </button>
      </div>
    </div>
  );
}

function ColorBySeg({ colorBy }: { colorBy: MapColorBy }) {
  return (
    <div className="seg bezel-seg flex-none">
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

/** The layers popover. Genuinely floats over the map, so it keeps its glass —
 *  and it is mounted OUTSIDE the modals for that reason: `.glass-thin .glass`
 *  flattens any nested pane to transparent, and both sheets clip their
 *  overflow, so a popover parented into one would lose its surface and then be
 *  cut off by the seam. */
export function LayersPopover({ side = "left" }: { side?: PopoverSide }) {
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
      className={cx(
        "thin-scroll glass lg-surface pointer-events-auto absolute z-30 max-h-[min(66vh,520px)] w-[248px] overflow-y-auto pb-2",
        side === "left" ? "top-2 left-2" : "top-[34px] right-2",
      )}
    >
      <LayersSection />
      <ContextLayerToggles />
      {/* Both segments live here unconditionally, and colour-by therefore
          appears twice at a wide row. That is the deliberate trade: the row
          folds the segment away below 428px of its own width (see
          `.colourby-fold`), and a control that becomes unreachable at a window
          size is a worse fault than a control that is reachable from two
          places. Both read the same store field, so they cannot disagree. */}
      <div className="px-3 pt-4">
        <div className="label-mono mb-2">Colour by</div>
        <ColorBySeg colorBy={colorBy} />
      </div>
      <div className="px-3 pt-4">
        <div className="label-mono mb-2">Basemap</div>
        <BasemapSeg basemap={basemap} />
      </div>
    </div>
  );
}

/** MapLegend, mounted for the first time. It self-filters to the layers that
 *  are actually on, so it is wrapped and positioned here and never edited.
 *  Bottom-left of the VISIBLE map, which is where its trigger — the status key
 *  in the left modal's footer — sits. */
export function LegendFlyout({ side = "left" }: { side?: PopoverSide }) {
  const popover = useLayout(selBezelPopover);
  if (popover !== "legend") return null;
  return (
    <div
      className={cx(
        "pointer-events-auto absolute left-2 z-30",
        side === "left" ? "bottom-2" : "bottom-[32px]",
      )}
    >
      <MapLegend className="max-h-[min(46vh,300px)]" />
    </div>
  );
}

/**
 * The permanent status key, and the pointer's own position.
 *
 * Both came off the bottom bezel unchanged. The key is still the legend's
 * trigger — the five hues are on screen at all times and the full legend is one
 * click away, which is what replaced a 12px "?" glyph whose affordance nobody
 * found.
 */
export function MapKeyRow({ className }: { className?: string }) {
  const popover = useLayout(selBezelPopover);

  return (
    <div className={cx("map-key-row flex h-[22px] items-center gap-3", className)}>
      <button
        type="button"
        aria-expanded={popover === "legend"}
        onClick={() => layoutActions.setBezelPopover(popover === "legend" ? "none" : "legend")}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 transition-colors hover:bg-glass-hover"
        title="Open the full map legend"
      >
        {STATUS_ORDER.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span
              aria-hidden
              className="size-[8px] flex-none rounded-[2px]"
              style={{ background: ZONE_STATUS_VAR[s] }}
            />
            <span className="status-label text-[9px] leading-none text-faint">
              {ZONE_STATUS_LABEL[s]}
            </span>
          </span>
        ))}
      </button>

      <div className="ml-auto flex items-center">
        <CursorReadout />
      </div>
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
    <span className="cursor-readout readout whitespace-nowrap text-[10px] text-faint tabular-nums">
      z {cursor.zoom.toFixed(1)} · {cursor.lat.toFixed(4)}, {cursor.lng.toFixed(4)}
    </span>
  );
}

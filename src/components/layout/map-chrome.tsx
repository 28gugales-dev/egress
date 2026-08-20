"use client";

import { IncidentFeed } from "@/components/feed/incident-feed";
import { InspectorDock } from "@/components/inspector/inspector-dock";
import { ControlRail } from "@/components/rail/control-rail";
import { KpiStrip, ScenarioChip } from "@/components/timeline/kpi-strip";
import { cx } from "@/lib/format";

/**
 * The chrome, floating over the map.
 *
 * Mounted ONLY while the panel plane is collapsed. That is the whole rule, and
 * it is what keeps this from contradicting the map plane's own principle that
 * nothing is drawn over the canvas: with both planes up the chrome has a plane
 * of its own to live in and the map stays clean, and with the panel at zero
 * width it has nowhere else to be. Collapsing the panel used to take the KPI
 * strip, the control rail, the inspector and the incident feed off screen
 * entirely — the map got bigger and the console got dumber, which is not a
 * trade anyone asked for.
 *
 * Arrangement is the pre-split-plane shell's, deliberately: whoever used this
 * console before the layout change already knows where these four things are,
 * and moving them because the mount point moved would spend that for nothing.
 *
 * Transport is the one island NOT restored here. The map plane's bottom bezel
 * grows a transport strip in exactly this state (see BezelTransport, which
 * returns null unless plane === "map"), so a floating scrubber would be a
 * second set of play controls three inches away from the first. The bezel's
 * track is bare where the panel's scrubber carries wave marks and the hazard
 * sparkline; that is a real difference, and the fix for it belongs in the
 * bezel rather than in a duplicate.
 */
export function MapChrome({ className }: { className?: string }) {
  return (
    /* Transparent to the pointer except where an island actually sits, or this
       layer would eat every pan and click meant for the map underneath. */
    <div className={cx("pointer-events-none absolute inset-0 z-30 flex gap-3 p-3", className)}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {/* Islands rather than full-width bands: the map is the product here,
            and a band spanning the window would take a horizontal strip of it
            for chrome that only needs its own content width. */}
        <div className="flex shrink-0 items-stretch justify-start gap-2">
          <div className="pointer-events-auto w-full max-w-[360px]">
            <KpiStrip />
          </div>
          <ScenarioChip className="pointer-events-auto flex-none" />
        </div>

        <div className="flex min-h-0 flex-1 gap-3">
          <div className="pointer-events-auto flex min-h-0 shrink-0">
            <ControlRail />
          </div>

          {/* mt-auto parks the feed on the floor of the column, clear of the
              rail beside it and the dock to its right. */}
          <div className="flex min-h-0 flex-1 flex-col items-end justify-end">
            <IncidentFeed className="pointer-events-auto mt-auto" />
          </div>
        </div>
      </div>

      <div className="pointer-events-auto flex min-h-0 shrink-0">
        <InspectorDock />
      </div>
    </div>
  );
}

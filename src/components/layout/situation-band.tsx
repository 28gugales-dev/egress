"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { dispatchSummary } from "@/components/layout/dispatch-summary";
import { ScenarioChip } from "@/components/layout/scenario-chip";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { frameAt } from "@/lib/derive";
import { cx, formatCount, formatTick, formatWallClock } from "@/lib/format";
import { layoutActions, selPlane, useLayout } from "@/lib/layout-store";
import { actions, selScenarioId, selT, selView, useEgress } from "@/lib/store";
import type { SimulationRun, ViewMode } from "@/types/egress";

/**
 * Band 1 — what is happening now.
 *
 * One row, hairline-divided, never scrolls and never moves. Everything in it is
 * a readout or a mono label; if two cells run long the scenario label truncates
 * first and a number never does.
 *
 * That rule is now enforced structurally rather than hoped for: every CELL is
 * flex-none and nowrap, the spacer before the pane segment has a zero flex
 * basis so it surrenders nothing under pressure, and the scenario chip is the
 * single shrinkable item in the row. Any shortfall lands on the one element
 * whose content is a label. Before this the chip was flex-none at a fixed 248px
 * and DISPATCH was the only min-w-0 item, so DISPATCH absorbed the entire
 * shortfall and printed "79 veh · 2,0…" at a 1600 window.
 */

/** Which run the time-varying cells read. Forked from kpi-strip.tsx on purpose:
 *  neither file owns a shared module and a three-line fork beats reaching into
 *  a file another workflow owns. */
function runForView(
  view: ViewMode,
  baseline: SimulationRun | null,
  planned: SimulationRun | null,
): SimulationRun | null {
  if (view === "baseline") return baseline ?? planned;
  return planned ?? baseline;
}

/**
 * How much of itself the band shows.
 *
 * Driven by the PANEL's own inner width, never the viewport: the same band is
 * 936px wide at a 1920 window, 616 at 1280, and the full window width stacked.
 * Four steps, because the cells differ hugely in what they cost:
 *
 *   full     DISPATCH spells out fleet, seats and coverage — 417px of cell
 *   mid      the seat count goes; it is in this cell's tooltip and in Teams
 *   compact  only the coverage ratio survives, and the wall clock goes with it
 *   tiny     labels shorten and the unit suffixes go
 *
 * Measured, not guessed, and the thresholds live in panel-plane.tsx. The full
 * tier's cells need 778px before the scenario chip gets a pixel, so a single
 * step at 780 put the band in FULL from 780 upwards: at a 1600 window it
 * overflowed by 25px — clipping the Panel|Map segment, the same failure that
 * made the Map button an 8px invisible sliver at 480 — and at 1920 it squeezed
 * the chip to 151px and rendered the scenario as "Cam…". The band's rule is
 * that the label truncates before a number does. It is not that the label is
 * annihilated so a seat count can stay.
 */
export type SituationTier = "full" | "mid" | "compact" | "tiny";

/** The key that toggles the panel column. Written once so the two tooltips and
 *  the handler in console-planes.tsx cannot drift apart. */
const PLANE_KEY = "\\";

function Cell({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div
      className="flex flex-none flex-col justify-center whitespace-nowrap border-hairline border-l px-3"
      title={title}
    >
      <span className="label-mono whitespace-nowrap">{label}</span>
      <span className="flex items-baseline gap-1.5">{children}</span>
    </div>
  );
}

export function SituationBand({ tier = "mid" }: { tier?: SituationTier }) {
  const t = useEgress(selT);
  const view = useEgress(selView);
  const scenarioId = useEgress(selScenarioId);
  const plane = useLayout(selPlane);
  const bundle = useBundle();

  const meta = bundle?.meta ?? getScenario(scenarioId);
  const run = runForView(view, bundle?.baseline ?? null, bundle?.planned ?? null);
  const frame = useMemo(() => (run ? frameAt(run, t) : null), [run, t]);

  const dispatch = useMemo(
    () => dispatchSummary(bundle?.planned?.plan ?? null, bundle?.zones ?? null),
    [bundle],
  );

  /* Wall clock and the long dispatch string are the two cells that cost real
     width; they leave together at COMPACT. */
  const roomy = tier === "full" || tier === "mid";
  const tiny = tier === "tiny";

  const exposed = frame?.vehiclesInHazard ?? null;
  const isExposed = (exposed ?? 0) > 0;
  const cleared = frame?.peopleCleared ?? null;
  const late = dispatch.late.length;

  /* One control, one state, every width. Below 1280 the panel stacks over the
     map instead of sitting beside it, but "is the panel on screen" is the same
     question and the same store field either way — see layout-store.ts. */
  const paneOn = plane === "both";

  return (
    <div className="flex h-[46px] flex-none items-stretch overflow-hidden">
      {/* The only shrinkable item in the row. */}
      <ScenarioChip className="mr-1 max-w-[248px] shrink" showDate={!tiny} />

      <Cell label="Clock">
        <span className="readout text-[12.5px] text-foreground">{formatTick(t, false)}</span>
        {/* Local time only. The scenario chip two cells left already carries
            the date, and repeating it cost the dispatch cell its last word. */}
        {roomy ? (
          <span className="readout whitespace-nowrap text-[10px] text-faint">
            {formatWallClock(meta.eventDate, t, meta.startHourLocal).slice(11)}
          </span>
        ) : null}
      </Cell>

      <Cell
        label={tiny ? "Exposed" : "Exposed now"}
        title="Vehicles inside the hazard footprint at this instant. The number that means lives."
      >
        {isExposed ? (
          <span
            className="pulse-critical h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: "var(--hazard)" }}
            aria-hidden="true"
          />
        ) : null}
        <span
          className="readout text-[12.5px]"
          style={{ color: isExposed ? "var(--hazard-text)" : undefined }}
        >
          {exposed === null ? "—" : formatCount(exposed)}
        </span>
        {tiny ? null : <span className="text-[10px] text-faint">veh</span>}
      </Cell>

      {/* The one aggregate that moves with the clock and counts UP. Without it
          the only figures tracking a twelve-hour replay were the clock itself
          and a hazard-exposure count that reads 0 for most of the run — the
          console replayed an evacuation while saying nothing about how much of
          it had happened. `peopleCleared` had exactly two references in src
          before this: an unmounted KPI strip, and a zero default in derive. */}
      <Cell
        label="Out"
        title="People clear of the town at this instant, in the run you are looking at."
      >
        <span className="readout text-[12.5px] text-foreground">
          {cleared === null ? "—" : formatCount(cleared)}
        </span>
        {tiny ? null : <span className="text-[10px] text-faint">ppl</span>}
      </Cell>

      <Cell
        label="Dispatch"
        title="Pickup fleet for households with no vehicle, across the whole town."
      >
        {dispatch.vehicles === 0 ? (
          <span className="readout text-[12.5px] text-faint">—</span>
        ) : (
          <>
            <span
              className="readout whitespace-nowrap text-[12.5px] text-foreground"
              title={`${formatCount(dispatch.vehicles)} vehicles · ${formatCount(dispatch.seats)} seats · ${dispatch.zonesCovered} of ${dispatch.zonesNeeding} zones with no-vehicle households covered`}
            >
              {/* The seat count is the first thing to go and the coverage
                  ratio is the last: the ratio is the claim, and everything
                  behind it is in this cell's tooltip and in the Teams tab. */}
              {tier === "full"
                ? `${formatCount(dispatch.vehicles)} veh · ${formatCount(dispatch.seats)} seats · ${dispatch.zonesCovered}/${dispatch.zonesNeeding} zones`
                : tier === "mid"
                  ? `${formatCount(dispatch.vehicles)} veh · ${dispatch.zonesCovered}/${dispatch.zonesNeeding} zones`
                  : `${dispatch.zonesCovered}/${dispatch.zonesNeeding}`}
            </span>
            {late > 0 ? (
              <button
                type="button"
                onClick={() => {
                  // Selecting the vehicle is what routes the dock to Teams, and
                  // the auto-promote in console-planes carries the work band
                  // over to INSPECT behind it.
                  const first = dispatch.late[0];
                  if (first) actions.select("vehicle", first.id);
                }}
                className="label-mono shrink-0 cursor-pointer whitespace-nowrap rounded-xs px-1 py-px transition-colors hover:bg-glass-hover"
                style={{ color: "var(--warn)" }}
                title={dispatch.late
                  .map((m) => `${m.id} → ${m.assignedZoneIds.join(", ")}`)
                  .join(" · ")}
              >
                {late} {tier === "full" ? "arrive after fire" : "late"}
              </button>
            ) : null}
          </>
        )}
      </Cell>

      {/* Zero flex basis, so it takes the slack when there is any and gives up
          nothing when there is none. */}
      <div className="min-w-0 flex-1 basis-0 border-hairline border-l" aria-hidden />

      <div className={cx("flex flex-none items-center", tiny ? "pl-1.5" : "pl-3")}>
        <div className="seg bezel-seg">
          {/* The key binding is named here because this is the only place an
              operator can read it BEFORE they need it. The map bezel carries
              the way back; this carries the way out. */}
          <button
            type="button"
            data-on={paneOn}
            title={`Show the panel — key ${PLANE_KEY}`}
            onClick={() => layoutActions.setPlane("both")}
          >
            Panel
          </button>
          <button
            type="button"
            data-on={!paneOn}
            title={`Map only — key ${PLANE_KEY}. The map bezel keeps a Panel control to come back.`}
            onClick={() => layoutActions.setPlane("map")}
          >
            Map
          </button>
        </div>
      </div>
    </div>
  );
}

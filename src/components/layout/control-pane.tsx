"use client";

import { useMemo } from "react";
import { CoverageSection } from "@/components/layout/coverage-section";
import { AssumptionsSection } from "@/components/rail/assumptions-section";
import { FiltersSection } from "@/components/rail/filters-section";
import { LeversSection } from "@/components/rail/levers-section";
import { ScenarioSection } from "@/components/rail/scenario-section";
import { useBundle } from "@/lib/bundle-context";
import { DEFAULT_PARAMS } from "@/lib/constants";
import { summaryFor } from "@/lib/derive";
import { formatCount, formatDelta, formatDuration } from "@/lib/format";
import { selParams, useEgress } from "@/lib/store";

/**
 * Work pane 3 — what the model is assuming.
 *
 * The rail's sections, unfolded into columns. The rail asked 1,653px of content
 * to live in an 829px slot; the same sections in a 936px-wide multi-column pane
 * have no overflow at all. Nothing here was redesigned — the sections are
 * mounted exactly as the rail mounted them, and the only thing that changed is
 * the horizontal space they never had.
 *
 * Layers, Context and Basemap are NOT here: they moved to the map bezel, where
 * a control that changes only what the map draws belongs. That move is also why
 * the rail's one Divider is gone — it separated "changes the model" from
 * "changes the drawing", and after the move there is nothing on the other side.
 */

/** Sections are wrapped so `break-inside: avoid` has something to bind to. */
function Block({ children }: { children: React.ReactNode }) {
  return <div className="glass-inset px-0.5 py-1">{children}</div>;
}

/**
 * What the four assumption sliders actually move.
 *
 * Two figures, one provenance line, and both of them interpolated from the
 * swept parameter grid rather than solved. That is stated in the caption in the
 * same breath, because the ARGUMENT band four inches up reads 3:45 from a
 * SOLVED run and these two numbers must never be mistaken for it.
 *
 * MODELLED CLEARANCE exists because without it two of the four sliders drove
 * nothing on screen at all. Removing the swept headline from the argument band
 * was right — it turned green while abandoning people — but it left "Notice
 * time" and "Vehicles / household" inert, and NOT MOVING responds only to
 * compliance and shadowEvac. Dragging vehicles/household from 1.40 to 2.00
 * changed exactly one token in the entire document: the slider's own readout.
 * Two live-looking dead controls beside two live ones is worse than either.
 *
 * NOT MOVING is never wired to `summary.unassigned`: that field is 8 in the
 * planned run, 8 in the baseline and 4-9 across all 1,050 grid entries — it is
 * solver dispatch slack, and rendering it as "not evacuated" would be a lie
 * that reads as a triumph. `totalEvacuated` is not a solver outcome either; it
 * is population x (compliance + shadowEvac). Both live beside the sliders that
 * drive them rather than in the ARGUMENT band, because dragging compliance down
 * must move the abandonment figure in front of the operator who did it.
 */
function SweptReadout() {
  const bundle = useBundle();
  const params = useEgress(selParams);

  const modelled = useMemo(() => {
    const zones = bundle?.zones?.zones ?? null;
    if (!zones || zones.length === 0) return null;
    let population = 0;
    for (const z of zones) population += z.population;
    return { population, zoneCount: zones.length };
  }, [bundle]);

  const grid = bundle?.grid ?? null;
  const swept = useMemo(() => (grid ? summaryFor(grid, params) : null), [grid, params]);
  const atDefault = useMemo(() => (grid ? summaryFor(grid, DEFAULT_PARAMS) : null), [grid]);

  // No zone layer means no honest denominator. An em-dash, never a fallback.
  const value =
    modelled && swept ? Math.max(0, Math.round(modelled.population - swept.totalEvacuated)) : null;
  const baselineValue =
    modelled && atDefault
      ? Math.max(0, Math.round(modelled.population - atDefault.totalEvacuated))
      : null;

  // Amber only above the default-params figure. A cell that is permanently
  // coloured is a cell nobody reads.
  const raised = value !== null && baselineValue !== null && value > baselineValue;

  const clearance = swept?.clearanceTime ?? null;
  const clearanceDelta = swept && atDefault ? swept.clearanceTime - atDefault.clearanceTime : null;

  return (
    <div className="glass-inset px-3 py-2">
      <div className="flex items-baseline gap-3">
        <span className="label-mono flex-none">Modelled clearance</span>
        <span className="readout text-[15px] text-foreground">
          {clearance === null ? "—" : formatDuration(clearance)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
          {clearanceDelta === null
            ? "param grid not loaded"
            : clearanceDelta === 0
              ? "at the default assumptions"
              : `${formatDelta(clearanceDelta)} against the default assumptions`}
        </span>
      </div>

      <div className="mt-1.5 flex items-baseline gap-3">
        <span className="label-mono flex-none">Not moving</span>
        <span
          className="readout text-[15px]"
          style={{ color: raised ? "var(--warn)" : "var(--foreground)" }}
        >
          {value === null ? "—" : formatCount(value)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
          {modelled
            ? `of ${formatCount(modelled.population)} in ${modelled.zoneCount} modelled zones`
            : "zone layer not loaded"}
        </span>
      </div>

      {/* .label-mono, not a hand-rolled near-copy of it. The old caption was
          8.5px / 1.275px tracking / weight 400 sitting 20px below a real
          .label-mono at 9px / 1.35px / weight 500 — same family, same case,
          same colour, close enough that it read as an inconsistency rather
          than as a distinct type role. */}
      <p className="label-mono mt-1.5">Interpolated from param grid — not the solved run</p>
    </div>
  );
}

export function ControlPane() {
  return (
    <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
      <div className="control-grid">
        <Block>
          {/* The view segment lives in the map bezel; see ScenarioSection. */}
          <ScenarioSection showView={false} />
        </Block>
        <Block>
          <AssumptionsSection />
          {/* The Levers block below carries this disclosure and these four did
              not, so two genuinely-live sliders and two that moved nothing on
              screen were visually indistinguishable. */}
          <p className="px-3 pt-1 pb-2 text-[10px] leading-[1.4]" style={{ color: "var(--warn)" }}>
            The swept grid's four axes. They move the interpolated figures at the foot of this pane;
            the solved runs in the argument band were computed at the defaults and do not follow.
          </p>
        </Block>
        <Block>
          <LeversSection />
          {/* param_grid keys have exactly four parts — compliance, shadowEvac,
              noticeTime, vehiclesPerHousehold. There is no boolean axis, so
              these four move no solved figure. Saying so is cheaper than
              letting an operator believe a toggle did something. */}
          <p className="px-3 pt-1 pb-2 text-[10px] leading-[1.4]" style={{ color: "var(--warn)" }}>
            Narrative controls. The swept grid has no boolean axis, so these four describe the plan
            rather than re-solve it.
          </p>
        </Block>
        <Block>
          <FiltersSection />
        </Block>
        {/* Last, and deliberately: it describes what the map can draw, not what
            the operator can change, so it belongs after every control rather
            than competing with one. */}
        <Block>
          <CoverageSection />
        </Block>
      </div>

      <SweptReadout />
    </div>
  );
}

"use client";

import { useMemo } from "react";
import { InspectorDock } from "@/components/inspector/inspector-dock";
import { ControlPane } from "@/components/layout/control-pane";
import { dispatchSummary } from "@/components/layout/dispatch-summary";
import { ReleaseSequence } from "@/components/plan/release-sequence";
import { useBundle } from "@/lib/bundle-context";
import { DEFAULT_PARAMS } from "@/lib/constants";
import { bindingWave, zoneClearance } from "@/lib/derive";
import { cx, formatPercent, formatShort } from "@/lib/format";
import {
  type LayoutState,
  layoutActions,
  selPlane,
  selWorkPane,
  useLayout,
} from "@/lib/layout-store";
import { actions, selFilters, selParams, selSelection, selView, useEgress } from "@/lib/store";
import type { EvacZone, ReleaseWave, RunParams, Selection, SimulationRun } from "@/types/egress";

/**
 * Band 4 — what the plan demands of you now.
 *
 * One pane at a time, and that is the whole reason this region exists. The
 * surveyed content is 4,567 linear px against roughly 1,000 of column height:
 * no accordion, gap or font size closes 4.5x. A single variable region holds
 * any ONE pane at or near its intrinsic size instead.
 *
 * THREE PANES IN PANEL VIEW, TWO IN MAP VIEW. Map view puts the inspector in a
 * permanent modal down the right of the window, so an Inspect tab there would
 * mount a second copy of the same dock a few inches from the first. The tab
 * list is DERIVED from the plane rather than stored, and a `workPane` left on
 * "inspect" by the other view is coerced at render — a second field saying
 * which panes exist is a second field that can disagree with this one.
 *
 * The contextual readout on the right of the tab strip is not decoration — it
 * is what keeps the other panes' state legible while you are working in one.
 */

interface WorkPane {
  id: LayoutState["workPane"];
  label: string;
}

/** The visible pane list, and the hotkey order with it: the key is the pane's
 *  1-based position in THIS list, so the strip and the keyboard can never
 *  disagree about what 2 means. Exported because console-planes.tsx binds the
 *  keys and must read the same list. */
export function workPanesFor(plane: LayoutState["plane"]): WorkPane[] {
  const panes: WorkPane[] = [{ id: "sequence", label: "Sequence" }];
  if (plane === "both") panes.push({ id: "inspect", label: "Inspect" });
  panes.push({ id: "control", label: "Control" });
  return panes;
}

/** What the header calls the thing that is selected. Forked from the dock so
 *  the strip does not have to import a private map out of it. */
const KIND_LABEL: Record<NonNullable<Selection["kind"]>, string> = {
  zone: "Zone",
  edge: "Segment",
  facility: "Facility",
  vehicle: "Vehicle",
  cell: "Block group",
  context: "Context",
  wave: "Wave",
  hazard: "Hazard",
  block: "Block",
  building: "Structure",
};

/**
 * The binding wave's real margin, computed exactly the way the SEQUENCE table
 * computes it — hazard arrival minus the moment the wave finishes clearing,
 * worst zone wins, zones that never empty in either run excluded rather than
 * allowed to swallow the number. See release-sequence.tsx for the evidence
 * behind both halves of that.
 *
 * Forked rather than imported because the table keeps it private, and the two
 * surfaces have to agree: this strip printed "MARGIN 35M" for a baseline run
 * whose ARGUMENT band two inches above read 9:30 with 3,797 vehicles caught at
 * burnover, because it was subtracting depart from hazard ETA.
 */
function bindingMargin(
  run: SimulationRun | null,
  wave: ReleaseWave,
  zones: EvacZone[] | null,
): number | null {
  if (!run || !zones) return null;
  let worst = Number.POSITIVE_INFINITY;
  for (const id of wave.zoneIds) {
    const zone = zones.find((z) => z.id === id);
    if (!zone) continue;
    const clearance = zoneClearance(run, id, 0);
    if (!clearance || clearance.clearedAt === null) continue;
    worst = Math.min(worst, zone.hazardEta - clearance.clearedAt);
  }
  return Number.isFinite(worst) ? worst : null;
}

function paramsTouched(p: RunParams): boolean {
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof RunParams)[]) {
    if (p[k] !== DEFAULT_PARAMS[k]) return true;
  }
  return false;
}

/** 5px dot, coloured only by data state. Exactly two badges exist, and both
 *  are verified to fire — an unlit badge is indistinguishable from a broken
 *  one, so a third was not added. */
function Badge({ tone }: { tone: string }) {
  return (
    <span aria-hidden className="size-[5px] flex-none rounded-full" style={{ background: tone }} />
  );
}

export function WorkBand() {
  const stored = useLayout(selWorkPane);
  const plane = useLayout(selPlane);
  const params = useEgress(selParams);
  const filters = useEgress(selFilters);
  const selection = useEgress(selSelection);
  const view = useEgress(selView);

  const panes = workPanesFor(plane);
  /* Coerced, not stored. Switching to map view with INSPECT selected must not
     leave the band rendering a tab that is not in its own strip. */
  const pane = panes.some((p) => p.id === stored) ? stored : "sequence";
  const bundle = useBundle();

  /* Same run the SEQUENCE pane is showing, so the strip and the table can
     never disagree about which wave binds. */
  const run = (view === "baseline" ? bundle?.baseline : bundle?.planned) ?? null;
  const plan = run?.plan ?? null;
  const binding = useMemo(() => bindingWave(plan), [plan]);
  const margin = useMemo(
    () => (binding ? bindingMargin(run, binding, bundle?.zones?.zones ?? null) : null),
    [run, binding, bundle],
  );
  const dispatch = useMemo(() => dispatchSummary(plan, bundle?.zones ?? null), [plan, bundle]);

  const touched = paramsTouched(params);
  const lateVehicles = dispatch.late.length;

  const filterCount =
    (filters.query.trim() ? 1 : 0) +
    (filters.minUrgency > 0 ? 1 : 0) +
    (filters.statuses.length ? 1 : 0) +
    (filters.minNoVehicle > 0 ? 1 : 0) +
    (filters.maxHazardEta !== null ? 1 : 0) +
    (filters.facilityKinds.length ? 1 : 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Work"
        className="flex h-[34px] flex-none items-stretch gap-0.5 border-hairline border-b px-1.5"
      >
        {panes.map((p, i) => {
          const on = p.id === pane;
          const badge =
            p.id === "control" && touched
              ? "var(--plan)"
              : p.id === "sequence" && lateVehicles > 0
                ? "var(--warn)"
                : null;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => layoutActions.setWorkPane(p.id)}
              aria-current={on ? "page" : undefined}
              title={`${p.label} — key ${i + 1}`}
              className={cx(
                "flex cursor-pointer items-center gap-1.5 border-b-2 px-2 text-[11.5px] transition-colors duration-[120ms]",
                on
                  ? "font-semibold text-foreground"
                  : "border-transparent font-medium text-faint hover:text-subtle",
              )}
              // Chrome is neutral: the active marker carries no data, so it
              // takes the ink colour, not a hazard hue.
              style={on ? { borderBottomColor: "var(--foreground)" } : undefined}
            >
              {p.label}
              {badge ? <Badge tone={badge} /> : null}
            </button>
          );
        })}

        <div className="ml-auto flex min-w-0 items-center pl-3">
          {pane === "sequence" ? (
            binding ? (
              <span className="label-mono truncate">
                Binding wave {binding.wave} ·{" "}
                <span style={{ color: "var(--hazard-text)" }}>
                  {formatPercent(binding.egressLoad)}
                </span>{" "}
                · margin{" "}
                {margin === null ? (
                  <span style={{ color: "var(--hazard-text)" }}>no zone clears</span>
                ) : margin <= 0 ? (
                  <span style={{ color: "var(--hazard-text)" }}>{formatShort(-margin)} late</span>
                ) : (
                  formatShort(margin)
                )}
              </span>
            ) : (
              <span className="label-mono">No release plan</span>
            )
          ) : null}

          {pane === "inspect" ? (
            <span className="label-mono max-w-[280px] truncate" title={selection.id ?? undefined}>
              {selection.kind && selection.id
                ? `${KIND_LABEL[selection.kind]} · ${selection.id}`
                : "No selection"}
            </span>
          ) : null}

          {pane === "control" ? (
            <span className="flex items-center gap-2">
              <span className="label-mono">
                {filterCount === 0
                  ? "No filters active"
                  : `${filterCount} filter${filterCount === 1 ? "" : "s"} active`}
              </span>
              {filterCount > 0 ? (
                <button
                  type="button"
                  onClick={() => actions.resetFilters()}
                  className="label-mono cursor-pointer rounded-xs px-1 py-px transition-colors hover:bg-glass-hover hover:text-foreground"
                >
                  Clear
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      </nav>

      <div className="min-h-0 flex-1">
        {pane === "sequence" ? (
          // The panel CLAUDE.md names as *the* product, and until now it had
          // zero callers in the running UI. Landing pane, inline, full width.
          <ReleaseSequence className="flat-surface h-full" />
        ) : pane === "inspect" ? (
          <InspectorDock variant="pane" />
        ) : (
          <div className="thin-scroll h-full overflow-y-auto">
            <ControlPane />
          </div>
        )}
      </div>
    </div>
  );
}

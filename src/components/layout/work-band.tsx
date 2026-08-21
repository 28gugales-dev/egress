"use client";

import {
  Crosshair,
  ListOrdered,
  type LucideIcon,
  Siren,
  SlidersHorizontal,
  Truck,
} from "lucide-react";
import { useMemo } from "react";
import { InspectorDock } from "@/components/inspector/inspector-dock";
import { runForView } from "@/components/inspector/queue-tab";
import { ControlPane } from "@/components/layout/control-pane";
import { dispatchSummary } from "@/components/layout/dispatch-summary";
import { PolicePane } from "@/components/layout/police-pane";
import { TransportPane } from "@/components/layout/transport-pane";
import { ReleaseSequence } from "@/components/plan/release-sequence";
import { useBundle } from "@/lib/bundle-context";
import { DEFAULT_PARAMS } from "@/lib/constants";
import { bindingWave, zoneClearance } from "@/lib/derive";
import { formatCount, formatPercent, formatShort } from "@/lib/format";
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
 * Band 4 — what the plan demands of you now, and the console's whole spine.
 *
 * One screen at a time, and that is the reason this region exists. The surveyed
 * content is 4,567 linear px against roughly 1,000 of column height: no
 * accordion, gap or font size closes 4.5x. A single variable region holds any
 * ONE screen at or near its intrinsic size instead.
 *
 * THE RAIL REPLACED THE TAB STRIP, it does not sit beside it. A horizontal
 * strip of five destinations is a strip that starts truncating at the width
 * this column is dragged to most, and two navigation controls over one region
 * is the failure this file is meant to avoid, not add to. So the strip rotated:
 * a vertical rail down the left of the band, five entries, folding to icons at
 * a width the band measures for itself. See console-planes.css for the fold —
 * it is a container query on the band, never on the window, because the sheets
 * are draggable now and the window no longer knows how wide this band is.
 *
 * FIVE ENTRIES IN PANEL VIEW, FOUR IN MAP VIEW. Map view puts the inspector in
 * a permanent modal down the right of the window, so an Inspect entry there
 * would mount a second copy of the same dock a few inches from the first. The
 * entry list is DERIVED from the plane rather than stored, and a `workPane`
 * left on "inspect" by the other view is coerced at render — a second field
 * saying which screens exist is a second field that can disagree with this one.
 *
 * The contextual readout is not decoration — it is what keeps the other
 * screens' state legible while you are working in one. It moved to the header
 * row above the screen, because a vertical rail has no right-hand end to hang
 * it off, and the header carries the active screen's name with it: at the
 * collapsed width the rail shows glyphs, so the header is the only thing on
 * screen that says in words where you are.
 */

interface WorkPane {
  id: LayoutState["workPane"];
  /** Rail label. Short enough to survive the 132px expanded rail. */
  label: string;
  /** Header title and tooltip. The long form lives here, once. */
  title: string;
  icon: LucideIcon;
}

/**
 * The visible entry list, and the hotkey order with it: the key is the entry's
 * 1-based position in THIS list, so the rail and the keyboard can never
 * disagree about what 2 means. Exported because console-planes.tsx binds the
 * keys and must read the same list.
 *
 * TRANSPORT and POLICE are appended AFTER control rather than grouped with
 * SEQUENCE by subject. Grouping would read better and would silently move what
 * key 3 does for anyone who has already learned it, and a keymap that changes
 * under an operator is worse than a list in a slightly odd order.
 */
export function workPanesFor(plane: LayoutState["plane"]): WorkPane[] {
  const panes: WorkPane[] = [
    { id: "sequence", label: "Sequence", title: "Zone release sequence", icon: ListOrdered },
  ];
  if (plane === "both") {
    panes.push({ id: "inspect", label: "Inspect", title: "Selection detail", icon: Crosshair });
  }
  panes.push(
    {
      id: "control",
      label: "Control",
      title: "Assumptions, levers and filters",
      icon: SlidersHorizontal,
    },
    { id: "transport", label: "Transport", title: "Dispatched fleet", icon: Truck },
    { id: "police", label: "Police", title: "Police & response assets", icon: Siren },
  );
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
     leave the band rendering a screen that is not in its own rail. */
  const pane = panes.some((p) => p.id === stored) ? stored : "sequence";
  /* The rail's own record, so the header's title cannot drift from the entry
     that is lit. Non-null by construction — `pane` came out of this list. */
  const active = panes.find((p) => p.id === pane) ?? panes[0];
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
  /* Read through the same selector TRANSPORT renders from, rather than off
     `plan` above: the two agree by construction that way, and `runForView`
     is the one place in the app that refuses to fall back across runs. */
  const fleetSize = runForView(bundle, view)?.plan.manifests.length ?? 0;

  const filterCount =
    (filters.query.trim() ? 1 : 0) +
    (filters.minUrgency > 0 ? 1 : 0) +
    (filters.statuses.length ? 1 : 0) +
    (filters.minNoVehicle > 0 ? 1 : 0) +
    (filters.maxHazardEta !== null ? 1 : 0) +
    (filters.facilityKinds.length ? 1 : 0);

  return (
    <div className="work-band flex min-h-0 flex-1">
      <nav aria-label="Work" className="work-rail flex flex-none flex-col gap-0.5 py-1.5">
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
              title={`${p.title} — key ${i + 1}`}
              className="work-rail-btn text-[11.5px] font-medium"
            >
              <p.icon size={15} strokeWidth={1.75} className="work-rail-icon" aria-hidden />
              {/* Visually hidden rather than removed at the collapsed width —
                  see console-planes.css. This span IS the button's accessible
                  name at every width, which is why there is no aria-label
                  duplicating it and no chance of the two drifting apart. */}
              <span className="work-rail-label">{p.label}</span>
              {badge ? <Badge tone={badge} /> : null}
            </button>
          );
        })}
      </nav>

      <div className="band-rule-v" aria-hidden />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The tab strip's surviving horizontal half: the active screen's name,
            because the collapsed rail has none in words, and the contextual
            readout that keeps the other screens legible from inside this one.
            28px rather than the strip's 34 — the entries left, so the row is
            two labels and nothing else. */}
        <header className="flex h-[28px] flex-none items-center gap-3 border-hairline border-b px-3">
          <h2 className="panel-title min-w-0 shrink-0 truncate">{active.title}</h2>

          <div className="ml-auto flex min-w-0 items-center">
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

            {/* Counted off the run the screen itself renders, so the header and
                the list can never disagree about how big the fleet is — and it
                says WHICH run, because the baseline's is empty. */}
            {pane === "transport" ? (
              <span className="label-mono truncate">
                {fleetSize === 0
                  ? `No dispatch in the ${view === "baseline" ? "baseline" : "planned"} run`
                  : `${formatCount(fleetSize)} runs · ${view === "baseline" ? "baseline" : "planned"}`}
              </span>
            ) : null}

            {/* No count to print, and no placeholder invented to fill the slot.
                The screen says why. */}
            {pane === "police" ? (
              <span className="label-mono truncate" style={{ color: "var(--warn)" }}>
                No roster in any payload
              </span>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {pane === "sequence" ? (
            // The panel CLAUDE.md names as *the* product, and until now it had
            // zero callers in the running UI. Landing screen, inline, full width.
            <ReleaseSequence className="flat-surface h-full" />
          ) : pane === "inspect" ? (
            <InspectorDock variant="pane" />
          ) : pane === "transport" ? (
            <TransportPane />
          ) : pane === "police" ? (
            <PolicePane />
          ) : (
            <div className="thin-scroll h-full overflow-y-auto">
              <ControlPane />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

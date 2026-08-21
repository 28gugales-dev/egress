"use client";

import { Bus, Truck } from "lucide-react";
import { useMemo } from "react";
import { EmptyHint, runForView, SectionLabel, StatRow } from "@/components/inspector/queue-tab";
import { useBundle } from "@/lib/bundle-context";
import { cx, formatCount, formatShort, formatTick } from "@/lib/format";
import { actions, selSelection, selView, useEgress } from "@/lib/store";
import type { VehicleManifest } from "@/types/egress";

/**
 * The dispatched fleet — every pickup run in the plan, in one list.
 *
 * WHAT BACKS THIS, exactly: `run.plan.manifests`. On camp-fire-2018 that is 76
 * buses and 3 ambulances, and `VehicleManifest["kind"]` has one further member
 * — paratransit — that this scenario's solver never emits. Nothing here is
 * synthesised: a kind with no manifests simply does not appear in the summary.
 *
 * IT FOLLOWS THE VIEW, and that is the interesting half. The baseline plan
 * carries ZERO manifests — one order, no staging, and nobody sent for the
 * households that cannot drive themselves — so switching to Baseline empties
 * this screen. That emptiness is the argument, not a bug, and the empty state
 * says which run it is describing rather than falling back to the planned one.
 * Silently rendering planned manifests under a baseline label is precisely the
 * substitution CLAUDE.md forbids.
 *
 * Sorted by SLACK, tightest first. Slack is the gap between a run finishing and
 * the hazard reaching its last stop; a fleet list sorted by id is a fleet list
 * that buries the two runs with no margin at position 34 and 61.
 */

/** Below this a crew cannot absorb a re-route. Same field rule of thumb the
 *  Teams tab is written against — forked rather than exported, because both are
 *  three lines and the tab owns its own copy today. */
const SLACK_WARN = 1200;

const KIND_LABEL: Record<VehicleManifest["kind"], string> = {
  bus: "Bus",
  ambulance: "Ambulance",
  paratransit: "Paratransit",
};

/** Written out rather than suffixed: "bus" takes -es, "ambulance" takes -s and
 *  "paratransit" takes neither, and a fleet line reading "3 ambulancees" is the
 *  kind of thing an operator stops trusting the rest of the screen over. */
const KIND_PLURAL: Record<VehicleManifest["kind"], string> = {
  bus: "buses",
  ambulance: "ambulances",
  paratransit: "paratransit",
};

function seatsUsed(m: VehicleManifest): number {
  let n = 0;
  for (const s of m.stops) n += s.passengers;
  return n;
}

function ManifestRow({ manifest, selected }: { manifest: VehicleManifest; selected: boolean }) {
  const used = seatsUsed(manifest);
  const slack = manifest.slack;
  const tone =
    slack <= 0 ? "var(--hazard)" : slack < SLACK_WARN ? "var(--warn)" : "var(--foreground)";

  return (
    <button
      type="button"
      /* Selecting the vehicle is the whole handoff: the inspector dock routes
         a vehicle selection to its Teams tab, which already renders the full
         manifest — stops, medical notes, drop capacity. This screen is the
         index into that, not a second copy of it. */
      onClick={() => actions.select("vehicle", manifest.id)}
      title={`${manifest.id} — ${manifest.originLabel} → ${manifest.dropLabel}`}
      className={cx(
        "queue-row glass-inset glass-inset-hover w-full cursor-pointer px-2.5 py-2 text-left",
        selected && "bg-glass-active",
      )}
      style={{
        // Colour here is the run's own state and nothing else: a run with no
        // margin is the row an operator has to act on.
        borderLeft: `2px solid ${slack <= 0 ? "var(--hazard)" : "transparent"}`,
      }}
    >
      <span className="qr-id readout truncate text-[11px] text-subtle">{manifest.id}</span>
      <span className="qr-primary readout text-[13px] leading-[16px]" style={{ color: tone }}>
        {slack <= 0 ? "NO MARGIN" : formatShort(slack)}
      </span>
      <span className="qr-meta label-mono truncate" title={manifest.originLabel}>
        {KIND_LABEL[manifest.kind]} · {formatCount(used)}/{formatCount(manifest.seats)} seats ·{" "}
        {manifest.assignedZoneIds.join(", ")}
      </span>
      <span className="qr-qualifier label-mono shrink-0">
        drop {formatTick(manifest.dropAt, false)}
      </span>
    </button>
  );
}

export function TransportPane() {
  const bundle = useBundle();
  const view = useEgress(selView);
  const selection = useEgress(selSelection);

  const run = runForView(bundle, view);
  const manifests = useMemo(() => run?.plan.manifests ?? [], [run]);

  const rows = useMemo(
    // Copy before sorting: the manifest array belongs to the loaded run.
    () => [...manifests].sort((a, b) => a.slack - b.slack),
    [manifests],
  );

  const summary = useMemo(() => {
    const byKind = new Map<VehicleManifest["kind"], number>();
    const zones = new Set<string>();
    let seats = 0;
    let carried = 0;
    let wheelchair = 0;
    let noMargin = 0;
    for (const m of manifests) {
      byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
      seats += m.seats;
      for (const s of m.stops) {
        carried += s.passengers;
        wheelchair += s.wheelchair;
      }
      for (const z of m.assignedZoneIds) zones.add(z);
      if (m.slack <= 0) noMargin += 1;
    }
    return { byKind, zones: zones.size, seats, carried, wheelchair, noMargin };
  }, [manifests]);

  if (!run) {
    return (
      <EmptyHint
        icon={Bus}
        title="No run loaded"
        hint="Manifests come from the simulate step. Run pnpm data:simulate to populate the dispatched fleet."
      />
    );
  }

  if (manifests.length === 0) {
    return (
      <EmptyHint
        icon={Bus}
        title={`The ${view === "baseline" ? "baseline" : "planned"} run dispatches nobody`}
        hint={
          view === "baseline"
            ? "One order, no staging, and no pickup runs for the households with no vehicle. That absence is what the planned run is compared against — switch the view to Planned to see the fleet."
            : "This run carries no vehicle manifests. Nothing is substituted from the other run."
        }
      />
    );
  }

  const fleet = [...summary.byKind.entries()]
    .map(
      ([kind, n]) =>
        `${formatCount(n)} ${n === 1 ? KIND_LABEL[kind].toLowerCase() : KIND_PLURAL[kind]}`,
    )
    .join(" · ");

  return (
    <div className="thin-scroll flex h-full min-h-0 flex-col overflow-y-auto px-3 py-2.5">
      <div className="glass-inset flex-none px-2.5 py-2">
        {/* Not "Dispatched fleet" again — the band's header says that two rows
            up, along with which run it is counting. A block whose label repeats
            the heading above it is a third register saying nothing new. */}
        <SectionLabel>Fleet totals</SectionLabel>
        <div className="flex items-center gap-1.5 pb-1">
          <Bus size={13} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
          <Truck size={13} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
          <span className="truncate text-[11.5px] text-subtle">{fleet}</span>
        </div>
        <StatRow
          label="Seats carried"
          value={`${formatCount(summary.carried)} / ${formatCount(summary.seats)}`}
          title="Passengers assigned across every stop, against the fleet's published seat count."
        />
        <StatRow
          label="Wheelchair"
          value={formatCount(summary.wheelchair)}
          title="Wheelchair positions used across every stop in the plan."
        />
        <StatRow label="Zones served" value={formatCount(summary.zones)} />
        <StatRow
          label="Runs with no margin"
          value={formatCount(summary.noMargin)}
          tone={summary.noMargin > 0 ? "hazard" : undefined}
          title="Runs that reach their last stop after the hazard does. Listed first below."
        />
      </div>

      <p className="flex-none pt-2 pb-1.5 text-[10.5px] leading-snug text-faint">
        Sorted by slack — the gap between a run finishing and the fire reaching its last stop.
        Select a run to open its stops, medical notes and drop capacity in the inspector.
      </p>

      <div className="queue-rows flex min-h-0 flex-col gap-1">
        {rows.map((m) => (
          <ManifestRow
            key={m.id}
            manifest={m}
            selected={selection.kind === "vehicle" && selection.id === m.id}
          />
        ))}
      </div>
    </div>
  );
}

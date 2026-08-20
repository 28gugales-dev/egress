"use client";

import { Bus, Truck } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { FACILITY_LABEL } from "@/lib/constants";
import { formatCount, formatPercent, formatShort, formatTick } from "@/lib/format";
import { actions, selSelection, selView, useEgress } from "@/lib/store";
import type { Facility, VehicleManifest } from "@/types/egress";
import { Bar, Chip, EmptyHint, runForView, SectionLabel, StatRow } from "./queue-tab";

/** Below this the crew has no room to absorb a re-route. Matches the field
 *  rule of thumb the dispatch section of the plan is written against. */
const SLACK_WARN = 1200;
/** Full bar at one hour of slack — beyond that the meter stops being useful. */
const SLACK_SCALE = 3600;

const KIND_LABEL: Record<VehicleManifest["kind"], string> = {
  bus: "Bus",
  ambulance: "Ambulance",
  paratransit: "Paratransit",
};

function seatsUsed(m: VehicleManifest): number {
  let n = 0;
  for (const s of m.stops) n += s.passengers;
  return n;
}

function wheelchairUsed(m: VehicleManifest): number {
  let n = 0;
  for (const s of m.stops) n += s.wheelchair;
  return n;
}

function ManifestCard({
  manifest,
  drop,
  inbound,
}: {
  manifest: VehicleManifest;
  drop: Facility | null;
  inbound: number;
}) {
  const used = seatsUsed(manifest);
  const chairs = wheelchairUsed(manifest);
  const over = used > manifest.seats;
  const slack = manifest.slack;
  const tight = slack < SLACK_WARN;
  const slackTone = slack <= 0 ? "hazard" : tight ? "warn" : "ok";
  const capacityPct = drop && drop.capacity > 0 ? inbound / drop.capacity : 0;
  const Icon = manifest.kind === "bus" ? Bus : Truck;
  // Copy before sorting: the manifest belongs to the loaded run, not to us.
  const stops = [...manifest.stops].sort((a, b) => a.seq - b.seq);

  return (
    <div className="glass-inset px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
          <span className="readout truncate text-[12px] text-foreground">{manifest.id}</span>
        </div>
        <span className="label-mono shrink-0 pt-0.5">{KIND_LABEL[manifest.kind]}</span>
      </div>

      <div className="mt-1 truncate text-[11px] text-subtle" title={manifest.originLabel}>
        From {manifest.originLabel}
      </div>

      <div className="mt-2">
        <div className="flex items-baseline justify-between gap-2 pb-1">
          <span className="label-mono">Seats used</span>
          <span
            className="readout text-[12px]"
            style={{ color: over ? "var(--hazard)" : "var(--foreground)" }}
          >
            {formatCount(used)} / {formatCount(manifest.seats)}
          </span>
        </div>
        <Bar
          value={manifest.seats > 0 ? used / manifest.seats : 0}
          tone={over ? "hazard" : "plan"}
        />
        {manifest.wheelchairSlots > 0 || chairs > 0 ? (
          <div className="pt-1">
            <StatRow
              label="Wheelchair"
              value={`${formatCount(chairs)} / ${formatCount(manifest.wheelchairSlots)}`}
              tone={chairs > manifest.wheelchairSlots ? "hazard" : undefined}
            />
          </div>
        ) : null}
      </div>

      {/* Slack is the difference between a pickup run and a body count. */}
      <div className="mt-2 border-t border-hairline pt-1.5">
        <div className="flex items-baseline justify-between gap-2 pb-1">
          <span className="label-mono">Slack to hazard</span>
          <span
            className="readout text-[13px]"
            style={{
              color: slack <= 0 ? "var(--hazard)" : tight ? "var(--warn)" : "var(--ok)",
            }}
          >
            {slack <= 0 ? "NO MARGIN" : formatShort(slack)}
          </span>
        </div>
        <Bar value={Math.max(0, slack) / SLACK_SCALE} tone={slackTone} />
        {tight ? (
          <p
            className="mt-1.5 rounded-sm px-2 py-1 text-[11px] leading-snug"
            style={{
              background: slack <= 0 ? "var(--hazard-dim)" : "var(--warn-dim)",
              color: slack <= 0 ? "var(--hazard-text)" : "var(--warn-text)",
            }}
          >
            {slack <= 0
              ? "Run arrives after the hazard reaches its last stop. Re-assign or drop stops."
              : `Under 20 minutes of margin. This run cannot absorb a re-route or a second lift.`}
          </p>
        ) : null}
      </div>

      <div className="mt-2 border-t border-hairline pt-1.5">
        <SectionLabel>Stops · {formatCount(stops.length)}</SectionLabel>
        {stops.length === 0 ? (
          <p className="text-[11px] text-faint">No stops assigned.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {stops.map((s) => (
              <li key={`${s.seq}-${s.label}`} className="flex items-start gap-2">
                <span className="readout w-4 shrink-0 pt-[1px] text-[10px] text-faint">
                  {s.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[11.5px] text-foreground" title={s.label}>
                      {s.label}
                    </span>
                    <span className="readout shrink-0 text-[11px] text-plan-text">
                      {formatTick(s.arriveAt, false)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1 pt-[2px]">
                    <span className="label-mono">
                      {formatCount(s.passengers)} pax
                      {s.wheelchair > 0 ? ` · ${formatCount(s.wheelchair)} wc` : ""}
                    </span>
                    {s.medicalNotes.map((n) => (
                      <Chip key={n} tone="warn">
                        {n}
                      </Chip>
                    ))}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="mt-2 border-t border-hairline pt-1.5">
        <SectionLabel>Drop</SectionLabel>
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="min-w-0 truncate text-[11.5px] text-foreground"
            title={manifest.dropLabel}
          >
            {manifest.dropLabel}
          </span>
          <span className="readout shrink-0 text-[11px] text-plan-text">
            {formatTick(manifest.dropAt, false)}
          </span>
        </div>
        {drop ? (
          <>
            <div className="pt-1">
              <StatRow
                label="Inbound / capacity"
                value={`${formatCount(inbound)} / ${formatCount(drop.capacity)}${
                  drop.capacity > 0 ? ` · ${formatPercent(capacityPct)}` : ""
                }`}
                tone={drop.capacity > 0 && inbound > drop.capacity ? "hazard" : undefined}
                title="Inbound counts every dispatched passenger routed to this facility, across all manifests in the plan."
              />
            </div>
            {drop.capacity > 0 ? (
              <Bar
                value={capacityPct}
                tone={capacityPct > 1 ? "hazard" : capacityPct > 0.85 ? "warn" : "ok"}
              />
            ) : (
              <p className="text-[11px] text-faint">No published capacity for this facility.</p>
            )}
          </>
        ) : (
          <p className="pt-1 text-[11px] text-faint">
            Drop facility {manifest.dropFacilityId} is not in the facility layer, so its capacity is
            unknown.
          </p>
        )}
      </div>
    </div>
  );
}

export function TeamsTab() {
  const bundle = useBundle();
  const view = useEgress(selView);
  const selection = useEgress(selSelection);

  const run = runForView(bundle, view);
  const manifests = run?.plan.manifests ?? [];

  const matched = useMemo(() => {
    if (!selection.id) return [];
    if (selection.kind === "vehicle") return manifests.filter((m) => m.id === selection.id);
    if (selection.kind === "zone") {
      return manifests.filter((m) => m.assignedZoneIds.includes(selection.id as string));
    }
    return [];
  }, [manifests, selection]);

  /** Every dispatched passenger routed to a facility, across the whole plan. */
  const inboundByFacility = useMemo(() => {
    const m = new Map<string, number>();
    for (const man of manifests) {
      let n = 0;
      for (const s of man.stops) n += s.passengers;
      m.set(man.dropFacilityId, (m.get(man.dropFacilityId) ?? 0) + n);
    }
    return m;
  }, [manifests]);

  const facilityById = useMemo(() => {
    const m = new Map<string, Facility>();
    for (const f of bundle?.facilities.facilities ?? []) m.set(f.id, f);
    return m;
  }, [bundle]);

  if (selection.kind !== "zone" && selection.kind !== "vehicle") {
    return (
      <EmptyHint
        icon={Bus}
        title="No zone or vehicle selected"
        hint="Pick a zone to see the pickup runs assigned to it, or a vehicle to see its manifest."
      />
    );
  }

  if (!run) {
    return (
      <EmptyHint
        icon={Bus}
        title="No dispatch plan loaded"
        hint="Manifests come from the simulate step. Run pnpm data:simulate to populate pickup runs."
      />
    );
  }

  if (matched.length === 0) {
    return (
      <EmptyHint
        icon={Bus}
        title="No pickup run assigned"
        hint={`${selection.id} has no dispatched vehicle in this plan. Every household in it is modelled as self-evacuating.`}
      />
    );
  }

  const origin = facilityById.get(matched[0].originFacilityId);

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-mono">
          {formatCount(matched.length)} {matched.length === 1 ? "manifest" : "manifests"}
        </span>
        {origin ? <span className="label-mono">{FACILITY_LABEL[origin.kind]}</span> : null}
      </div>

      {matched.map((m) => (
        <ManifestCard
          key={m.id}
          manifest={m}
          drop={facilityById.get(m.dropFacilityId) ?? null}
          inbound={inboundByFacility.get(m.dropFacilityId) ?? 0}
        />
      ))}

      {selection.kind === "zone" ? (
        <p className="text-[10.5px] leading-snug text-faint">
          Showing every run assigned to {selection.id}. Select a vehicle on the map to isolate one
          manifest.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => actions.clearSelection()}
          className="self-start text-[11px] text-plan-text underline-offset-2 hover:underline"
        >
          Clear vehicle selection
        </button>
      )}
    </div>
  );
}

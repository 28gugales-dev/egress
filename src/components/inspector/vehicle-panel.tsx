"use client";

import { Bus, TriangleAlert, Truck } from "lucide-react";
import { useMemo } from "react";
import {
  fleetFor,
  nextStop,
  SLACK_WARN,
  VEHICLE_PHASE_LABEL,
  type VehiclePhase,
  vehiclePhaseAt,
  vehiclePositionAt,
} from "@/components/map/vehicle-layers";
import { useBundle } from "@/lib/bundle-context";
import { FACILITY_LABEL } from "@/lib/constants";
import { formatCount, formatDistance, formatShort, formatTick } from "@/lib/format";
import { actions, selSelection, selT, selView, useEgress } from "@/lib/store";
import type { EvacZone, Facility, SimulationRun, VehicleManifest, ViewMode } from "@/types/egress";

/**
 * The live detail view for one dispatched vehicle.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * `teams-tab.tsx` already renders a manifest card: seats, stops, drop capacity.
 * That is the PLAN — everything in it is true at every value of t. This panel
 * is the RUN: where the vehicle is now, what it is doing now, what it still has
 * to do, and whether the fire beats it there. The two are complementary, and
 * the parent decides whether this replaces the teams tab's card or sits above
 * it. Nothing here edits an existing inspector file.
 *
 * ── Honesty ─────────────────────────────────────────────────────────────────
 *
 * Everything time-varying on this card is MODELLED. There is no telemetry.
 * The provenance footer says so, unconditionally, and is not collapsible.
 */

const KIND_LABEL: Record<VehicleManifest["kind"], string> = {
  bus: "Bus",
  ambulance: "Ambulance",
  paratransit: "Paratransit",
};

type Tone = "plan" | "hazard" | "warn" | "ok" | "neutral";

const TONE_VAR: Record<Tone, string> = {
  plan: "var(--plan-text)",
  hazard: "var(--hazard-text)",
  warn: "var(--warn-text)",
  ok: "var(--ok)",
  neutral: "var(--foreground)",
};

/* Deliberately local rather than imported from queue-tab.tsx: that file belongs
   to another module and its exported helpers can change shape underneath this
   one. Two twelve-line primitives are cheaper than that coupling. */

function Row({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: Tone;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={title}>
      <span className="label-mono">{label}</span>
      <span className="readout text-[12.5px]" style={{ color: TONE_VAR[tone] }}>
        {value}
      </span>
    </div>
  );
}

function Bar({ value, tone = "plan" }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return (
    <div className="h-[4px] w-full overflow-hidden rounded-xs bg-glass-inset">
      <div className="h-full rounded-xs" style={{ width: `${pct}%`, background: TONE_VAR[tone] }} />
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 border-t border-hairline pt-1.5">
      <div className="label-mono pb-1.5">{label}</div>
      {children}
    </div>
  );
}

const PHASE_TONE: Record<VehiclePhase, Tone> = {
  staged: "neutral",
  to_pickup: "warn",
  loading: "warn",
  to_shelter: "plan",
  arrived: "ok",
};

/** Which run backs the current view. Never falls back across kinds: showing a
 *  baseline vehicle under a "planned" label would be silent synthesis. */
function runFor(view: ViewMode, baseline: SimulationRun | null, planned: SimulationRun | null) {
  return view === "baseline" ? baseline : planned;
}

function seatsUsed(m: VehicleManifest): number {
  let n = 0;
  for (const s of m.stops) n += s.passengers;
  return n;
}

export function VehiclePanel() {
  const bundle = useBundle();
  const view = useEgress(selView);
  const selection = useEgress(selSelection);
  // The countdowns on this card are the point, so it does subscribe to the
  // 30fps playhead. The dock header above it deliberately does not.
  const t = useEgress(selT);

  const run = runFor(view, bundle?.baseline ?? null, bundle?.planned ?? null);

  const fleet = useMemo(
    () => fleetFor(run?.plan ?? null, bundle?.zones ?? null, bundle?.network ?? null),
    [run, bundle],
  );

  const route =
    selection.kind === "vehicle" && selection.id ? (fleet.byId.get(selection.id) ?? null) : null;

  /** Sibling runs dispatched to the same zones, so this manifest's share of the
   *  zone's demand is stated as a share rather than implied to be the whole. */
  const siblings = useMemo(() => {
    if (!route) return 0;
    const mine = new Set(route.manifest.assignedZoneIds);
    let n = 0;
    for (const m of run?.plan.manifests ?? []) {
      if (m.assignedZoneIds.some((z) => mine.has(z))) n++;
    }
    return n;
  }, [route, run]);

  const zones = useMemo(() => {
    if (!route || !bundle) return [] as EvacZone[];
    const want = new Set(route.manifest.assignedZoneIds);
    return bundle.zones.zones.filter((z) => want.has(z.id));
  }, [route, bundle]);

  const facilityById = useMemo(() => {
    const m = new Map<string, Facility>();
    for (const f of bundle?.facilities.facilities ?? []) m.set(f.id, f);
    return m;
  }, [bundle]);

  if (selection.kind !== "vehicle") {
    return (
      <Empty
        title="No vehicle selected"
        hint="Click a moving bus or ambulance on the map to open its run."
      />
    );
  }

  if (!run) {
    return (
      <Empty
        title="No dispatch plan loaded"
        hint="Manifests come from the simulate step. Run pnpm data:simulate to populate pickup runs."
      />
    );
  }

  if (!route) {
    return (
      <Empty
        title={`${selection.id ?? "That vehicle"} is not in this run`}
        hint={
          view === "baseline"
            ? "The baseline replays what happened, and no buses were dispatched. Switch to the planned run."
            : "This manifest carries no usable route geometry, so it cannot be placed on the map."
        }
      />
    );
  }

  const m = route.manifest;
  const phase = vehiclePhaseAt(route, t);
  const fix = vehiclePositionAt(route, t);
  const next = nextStop(route, t);
  const Icon = m.kind === "ambulance" ? Truck : Bus;
  const people = seatsUsed(m);
  const progress = route.totalM > 0 ? fix.distance / route.totalM : 0;
  const toDrop = route.endAt - t;

  const dropSlack = m.slack;
  const dropTone: Tone = dropSlack < 0 ? "hazard" : dropSlack < SLACK_WARN ? "warn" : "ok";
  const pickTone: Tone = !Number.isFinite(route.pickupSlack)
    ? "neutral"
    : route.pickupSlack < 0
      ? "hazard"
      : route.pickupSlack < SLACK_WARN
        ? "warn"
        : "ok";

  const origin = facilityById.get(m.originFacilityId) ?? null;
  const drop = facilityById.get(m.dropFacilityId) ?? null;
  const lastStop = route.stops[route.stops.length - 1];

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5">
      <div className="glass-inset px-2.5 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Icon size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
            <span className="readout truncate text-[12px] text-foreground">{m.id}</span>
          </div>
          <span
            className="label-mono shrink-0 pt-0.5"
            style={{ color: TONE_VAR[route.atRisk ? "hazard" : PHASE_TONE[phase]] }}
          >
            {VEHICLE_PHASE_LABEL[phase]}
          </span>
        </div>

        <div className="mt-1 truncate text-[11px] text-subtle" title={m.originLabel}>
          {KIND_LABEL[m.kind]} out of {m.originLabel}
          {origin ? ` · ${FACILITY_LABEL[origin.kind]}` : ""}
        </div>

        {/* ── Where it is now ────────────────────────────────────────────── */}
        <Section label="Now">
          <div className="flex items-baseline justify-between gap-2 pb-1">
            <span className="label-mono">Along route</span>
            <span className="readout text-[12.5px] text-foreground">
              {formatDistance(fix.distance)} / {formatDistance(route.totalM)}
            </span>
          </div>
          <Bar value={progress} tone={route.atRisk ? "hazard" : PHASE_TONE[phase]} />
          <div className="pt-1">
            <Row
              label="Next stop"
              value={next ? formatTick(next.arriveAt, false) : "none — running to drop"}
              tone={next && next.slack < 0 ? "hazard" : "neutral"}
            />
            {next ? (
              <div className="truncate pb-1 text-[11px] text-subtle" title={next.stop.label}>
                {next.stop.label}
              </div>
            ) : null}
            <Row
              label="Reaches drop in"
              value={toDrop > 0 ? formatShort(toDrop) : "arrived"}
              tone={toDrop > 0 ? "plan" : "ok"}
            />
          </div>
        </Section>

        {/* ── Slack. The number this whole layer exists to expose. ───────── */}
        <Section label="Against the hazard">
          <Row
            label="Hazard ETA at zone"
            value={route.hazardEta < 0 ? "unknown" : formatTick(route.hazardEta, false)}
            tone="hazard"
          />
          <Row
            label="Margin at last pickup"
            value={
              !Number.isFinite(route.pickupSlack)
                ? "unknown"
                : route.pickupSlack < 0
                  ? `${formatShort(-route.pickupSlack)} LATE`
                  : formatShort(route.pickupSlack)
            }
            tone={pickTone}
          />
          <Row
            label="Margin at drop"
            value={dropSlack < 0 ? `${formatShort(-dropSlack)} LATE` : formatShort(dropSlack)}
            tone={dropTone}
          />
          {route.atRisk ? (
            <p
              className="mt-1.5 flex gap-1.5 rounded-sm px-2 py-1.5 text-[11px] leading-snug"
              style={{ background: "var(--hazard-dim)", color: "var(--hazard-text)" }}
            >
              <TriangleAlert size={13} strokeWidth={2} className="mt-[1px] shrink-0" />
              <span>
                {Number.isFinite(route.pickupSlack) && route.pickupSlack < 0 && lastStop
                  ? `This run cannot reach ${lastStop.stop.label} before the fire. It arrives
                     ${formatShort(-route.pickupSlack)} after the hazard is modelled to get there.
                     The ${formatCount(people)} people on this manifest have no vehicle of their own,
                     so nothing else moves them. Re-assign a closer depot, or drop stops.`
                  : `The drop lands ${formatShort(-dropSlack)} after the hazard reaches
                     ${zones[0]?.label ?? "the assigned zone"}. Re-assign or shorten the run.`}
              </span>
            </p>
          ) : dropSlack < SLACK_WARN ? (
            <p
              className="mt-1.5 rounded-sm px-2 py-1 text-[11px] leading-snug"
              style={{ background: "var(--warn-dim)", color: "var(--warn-text)" }}
            >
              Under {formatShort(SLACK_WARN)} of margin. This run cannot absorb a re-route or a
              second lift.
            </p>
          ) : null}
        </Section>

        {/* ── Who is aboard ─────────────────────────────────────────────── */}
        <Section label="Manifest">
          <Row
            label="Seats"
            value={`${formatCount(people)} / ${formatCount(m.seats)}`}
            tone={people > m.seats ? "hazard" : "neutral"}
          />
          {m.wheelchairSlots > 0 ? (
            <Row label="Wheelchair slots" value={formatCount(m.wheelchairSlots)} />
          ) : null}
          <Row label="Stops" value={formatCount(m.stops.length)} />
          {zones.map((z) => (
            <div key={z.id} className="pt-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[11.5px] text-foreground" title={z.label}>
                  {z.label}
                </span>
                <span className="readout shrink-0 text-[11px] text-faint">{z.id}</span>
              </div>
              <div className="text-[10.5px] leading-snug text-faint">
                {formatCount(z.noVehicleHouseholds)} no-vehicle households in the zone ·{" "}
                {formatCount(siblings)} {siblings === 1 ? "run" : "runs"} dispatched to it
              </div>
            </div>
          ))}
          <ol className="mt-1.5 flex flex-col gap-1">
            {route.stops.map((w) => (
              <li key={`${w.stop.seq}-${w.stop.label}`} className="flex items-start gap-2">
                <span className="readout w-4 shrink-0 pt-[1px] text-[10px] text-faint">
                  {w.stop.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[11.5px] text-foreground" title={w.stop.label}>
                      {w.stop.label}
                    </span>
                    <span
                      className="readout shrink-0 text-[11px]"
                      style={{ color: TONE_VAR[w.slack < 0 ? "hazard" : "plan"] }}
                    >
                      {formatTick(w.arriveAt, false)}
                    </span>
                  </span>
                  <span className="label-mono block pt-[2px]">
                    {formatCount(w.stop.passengers)} pax
                    {w.stop.wheelchair > 0 ? ` · ${formatCount(w.stop.wheelchair)} wc` : ""}
                    {w.departAt > w.arriveAt
                      ? ` · ${formatShort(w.departAt - w.arriveAt)} dwell`
                      : ""}
                  </span>
                  {w.stop.medicalNotes.length > 0 ? (
                    <span className="block text-[10.5px] leading-snug text-warn-text">
                      {w.stop.medicalNotes.join(" · ")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </Section>

        {/* ── Where it came from and where it is going ──────────────────── */}
        <Section label="Origin & drop">
          <Row label="Rolls at" value={formatTick(route.departAt, false)} />
          <div className="flex items-baseline justify-between gap-2 py-[3px]">
            <span className="min-w-0 truncate text-[11.5px] text-foreground" title={m.dropLabel}>
              {m.dropLabel}
            </span>
            <span className="readout shrink-0 text-[11px] text-plan-text">
              {formatTick(route.endAt, false)}
            </span>
          </div>
          {drop ? (
            <Row
              label="Drop capacity"
              value={drop.capacity > 0 ? formatCount(drop.capacity) : "not published"}
            />
          ) : (
            <p className="text-[11px] text-faint">
              Drop facility {m.dropFacilityId} is not in the facility layer, so its capacity is
              unknown.
            </p>
          )}
          <Row label="Route length" value={formatDistance(route.totalM)} />
        </Section>

        {/* ── The roads ────────────────────────────────────────────────── */}
        <Section label={`Route · ${formatCount(route.roads.length)} named roads`}>
          {route.roads.length === 0 ? (
            <p className="text-[11px] text-faint">
              No segment of this route matched a named road in the network extract.
            </p>
          ) : (
            <ol className="flex flex-col gap-[3px]">
              {route.roads.map((leg) => (
                <li
                  key={`${leg.seq}-${leg.name}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="min-w-0 truncate text-[11.5px] text-foreground" title={leg.name}>
                    <span className="readout pr-1.5 text-[10px] text-faint">{leg.seq + 1}</span>
                    {leg.name}
                  </span>
                  <span className="readout shrink-0 text-[11px] text-faint">
                    {formatDistance(leg.metres)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* ── Provenance. Not collapsible, not conditional. ─────────────── */}
        <div className="mt-2 border-t border-hairline pt-1.5">
          <p className="text-[10.5px] leading-snug text-faint">
            Position is <strong className="font-semibold text-subtle">MODELLED</strong>, not
            observed — no AVL or GPS feed exists for this fleet. The puck is interpolated between
            the timestamps the deterministic solver wrote onto this manifest, driving the free-flow
            shortest path over the OpenStreetMap extract. Stops are snapped to the nearest road
            node, so a marker can sit a short way off its muster point.
            {m.kind === "ambulance"
              ? " Ambulance dwell is folded into the outgoing leg by the pipeline, so no loading window is shown."
              : ""}
          </p>
          {route.offNetworkM > 0 ? (
            <p className="mt-1 text-[10.5px] leading-snug text-warn-text">
              <strong className="font-semibold">
                {formatDistance(route.offNetworkM)} of this route
              </strong>{" "}
              lies on no edge of the road network — the plan's polyline jumps between points the
              graph never joined, and it is drawn uncorrected rather than smoothed. Those stretches
              carry no road name and the vehicle crosses them as a straight line. Cause and fix are
              named in the console warning.
            </p>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={() => actions.clearSelection()}
        className="mt-2 self-start text-[11px] text-plan-text underline-offset-2 hover:underline"
      >
        Clear vehicle selection
      </button>
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-7 py-10 text-center">
      <Bus size={15} strokeWidth={1.75} className="text-faint" />
      <div className="text-[12px] font-medium text-subtle">{title}</div>
      <div className="text-[11px] leading-snug text-faint">{hint}</div>
    </div>
  );
}

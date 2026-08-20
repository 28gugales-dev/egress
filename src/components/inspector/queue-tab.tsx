"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ChevronRight, Play } from "lucide-react";
import { useMemo } from "react";
import { flyTo } from "@/components/map/map-shell";
import { useBundle } from "@/lib/bundle-context";
import { ZONE_STATUS_LABEL, ZONE_STATUS_VAR } from "@/lib/constants";
import type { ScenarioBundle } from "@/lib/data";
import { bindingWave, visibleZones, zoneStatusAt } from "@/lib/derive";
import {
  cx,
  formatCount,
  formatPercent,
  formatShort,
  formatTick,
  URGENCY_VAR,
  urgencyBand,
} from "@/lib/format";
import { actions, selFilters, selT, selView, useEgress } from "@/lib/store";
import type {
  EvacZone,
  ReleaseWave,
  SimulationRun,
  Tick,
  ViewMode,
  ZoneStatus,
} from "@/types/egress";

/**
 * The queue is the operational heart of the dock, and it is also where the
 * inspector's shared primitives live. They cannot live in inspector-dock.tsx:
 * the dock imports every tab, so a tab importing back from the dock would make
 * the module graph cyclic. This file imports no sibling tab, so it is the safe
 * leaf to hang them off.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared inspector primitives
// ─────────────────────────────────────────────────────────────────────────────

export type Tone = "plan" | "hazard" | "warn" | "ok" | "neutral";

export const TONE_VAR: Record<Tone, string> = {
  plan: "var(--plan)",
  hazard: "var(--hazard)",
  warn: "var(--warn)",
  ok: "var(--ok)",
  neutral: "var(--faint)",
};

/** Quiet centred hint. Every tab renders one of these rather than nothing. */
export function EmptyHint({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-7 py-10 text-center">
      <Icon size={15} strokeWidth={1.75} className="text-faint" />
      <div className="text-[12px] font-medium text-subtle">{title}</div>
      <div className="text-[11px] leading-snug text-faint">{hint}</div>
    </div>
  );
}

/** Horizontal fill bar. `value` is a 0..1 fraction; overflow past 1 is clipped
 *  but the caller is expected to have already flagged it in the readout. */
export function Bar({ value, tone = "plan" }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return (
    <div className="h-[4px] w-full overflow-hidden rounded-xs bg-glass-inset">
      <div
        className="h-full rounded-xs transition-[width] duration-200 ease-out"
        style={{ width: `${pct}%`, background: TONE_VAR[tone] }}
      />
    </div>
  );
}

/** label-mono on the left, readout on the right. The dock's workhorse row. */
export function StatRow({
  label,
  value,
  tone,
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
      <span className="readout text-[12.5px]" style={tone ? { color: TONE_VAR[tone] } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-xs border border-hairline px-[5px] py-[1px] text-[9.5px] font-medium tracking-wide"
      style={{ color: TONE_VAR[tone] }}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="label-mono pb-1.5">{children}</div>;
}

/**
 * Which run backs the current view.
 *
 * Deliberately never falls back across kinds: rendering baseline numbers under
 * a "planned" label would be silent synthesis, and an untraceable number is
 * worse than a missing one.
 */
export function runForView(bundle: ScenarioBundle | null, view: ViewMode): SimulationRun | null {
  if (!bundle) return null;
  return view === "baseline" ? bundle.baseline : bundle.planned;
}

/** Select a zone and ask the map to fly to it. `flyTo` emits the shared
 *  `egress:flyto` event; MapShell owns the listener and the camera. */
export function focusZone(zone: EvacZone): void {
  actions.select("zone", zone.id);
  flyTo({ center: zone.centroid, zoom: 13 });
}

/** Seconds of hazard headroom left at the playhead, floored at zero. */
export function timeToHazard(zone: EvacZone, t: Tick): Tick {
  return Math.max(0, zone.hazardEta - t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────────────

/** Threshold past which adding another zone to the wave queues the corridor. */
const LOAD_WARN = 0.85;

function QueueRow({ zone, status, t }: { zone: EvacZone; status: ZoneStatus; t: Tick }) {
  const remaining = timeToHazard(zone, t);
  const overrun = remaining <= 0;
  const band = urgencyBand(remaining);

  /**
   * A zone can be overrun by the hazard AND have cleared its households. Both
   * facts are true, but printed at equal weight they read as a contradiction,
   * so the row commits to one primary state and demotes the other to a
   * qualifier. Cleared and cut off are terminal — there is no decision left in
   * the row, so the countdown stops being the headline.
   */
  const terminal = status === "cleared" || status === "cutoff";
  const primary = terminal
    ? ZONE_STATUS_LABEL[status].toUpperCase()
    : overrun
      ? "OVERRUN"
      : formatShort(remaining);
  // Terminal rows quote the zone's absolute hazard time rather than a
  // countdown: the countdown is no longer the thing being acted on, and a
  // relative reading rounds to "in 0m" on the seconds either side of arrival.
  const qualifier = terminal
    ? `hazard ${formatTick(zone.hazardEta, false)}`
    : ZONE_STATUS_LABEL[status];

  return (
    <button
      type="button"
      onClick={() => focusZone(zone)}
      className={cx(
        "queue-row glass-inset glass-inset-hover w-full cursor-pointer px-2.5 py-2 text-left",
        // A cleared zone is out. Pulsing it keeps pulling the eye to a row that
        // no longer needs an order.
        band === 3 && status !== "cleared" && "pulse-critical",
      )}
      style={{ borderLeft: `2px solid ${ZONE_STATUS_VAR[status]}` }}
    >
      {/* The countdown is the number being acted on, so it takes the size and
          the weight; the zone id is how you refer to it afterwards, and steps
          back a rank to say so. Column ORDER is set in CSS, not here: at dock
          width these four wrap onto two lines, and once the list is wide enough
          they land as one 30px tabular row. */}
      <span className="qr-id readout truncate text-[11px] text-subtle">{zone.id}</span>
      <span
        className="qr-primary readout text-[13.5px] leading-[16px]"
        style={{ color: terminal ? ZONE_STATUS_VAR[status] : URGENCY_VAR[band] }}
      >
        {primary}
      </span>
      <span className="qr-meta label-mono truncate">
        {formatCount(zone.households)} HH · {formatCount(zone.noVehicleHouseholds)} no-veh
      </span>
      {/* Left border already carries the status hue; a coloured qualifier
          would compete with the primary readout for the same glance. */}
      <span className="qr-qualifier label-mono shrink-0">{qualifier}</span>
    </button>
  );
}

function LoadMeter({ wave }: { wave: ReleaseWave | null }) {
  if (!wave) {
    return (
      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>Egress load</SectionLabel>
        <p className="text-[11px] leading-snug text-faint">
          No release plan on disk. Run <span className="readout">pnpm data:simulate</span> to load
          corridor loading.
        </p>
      </div>
    );
  }

  const load = wave.egressLoad;
  const hot = load > LOAD_WARN;
  const headroom = Math.max(0, 1 - load);

  return (
    <div className="glass-inset px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Egress load · binding</SectionLabel>
        <span
          className="readout text-[13px]"
          style={{ color: hot ? "var(--hazard)" : "var(--plan)" }}
        >
          {formatPercent(load)}
        </span>
      </div>
      <Bar value={load} tone={hot ? "hazard" : load > 0.65 ? "warn" : "plan"} />
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-subtle">{wave.routeLabel}</span>
        <span className="label-mono">Wave {wave.wave}</span>
      </div>

      {hot ? (
        // The whole product argument in one sentence: a nav app cannot say this,
        // because it never models the corridor as a shared, finite resource.
        <div
          className="mt-2 flex items-start gap-2 rounded-sm bg-hazard-dim px-2 py-1.5"
          style={{ border: "1px solid var(--hazard)" }}
        >
          <AlertTriangle
            size={13}
            strokeWidth={1.75}
            className="mt-[2px] shrink-0 text-hazard-text"
          />
          <p className="text-[11.5px] font-medium leading-snug text-hazard-text">
            {formatPercent(load)} of capacity — do not add a zone to this wave.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-snug text-faint">
          {formatPercent(headroom)} headroom on {wave.routeLabel}. One more zone may fit; check its
          household count against the corridor before you order it.
        </p>
      )}
    </div>
  );
}

function ReleaseFooter({ run, t }: { run: SimulationRun | null; t: Tick }) {
  const next = useMemo(() => {
    const waves = run?.plan.waves ?? [];
    return waves.find((w) => w.departAt > t) ?? null;
  }, [run, t]);

  if (!next) {
    return (
      <button
        type="button"
        disabled
        className="w-full cursor-not-allowed rounded-md border border-hairline bg-glass-inset px-3 py-2 text-[12px] font-medium text-faint"
      >
        {run ? "All waves released" : "No release plan loaded"}
      </button>
    );
  }

  const named = next.zoneIds.slice(0, 2).join(", ");
  const extra = next.zoneIds.length - 2;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          // No plan-mutation contract exists, so "release" advances the playhead
          // to the wave's own depart time — the honest demo action. It no longer
          // flies the camera at zone[0] of twenty-eight: that framed empty
          // forest with the town, the fire and 45 other zones off screen.
          actions.setT(next.departAt);
        }}
        className="glass-inset glass-inset-hover flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
      >
        <Play size={13} strokeWidth={1.75} className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1">
          {/* The label carries its own wave number. Without it this button sat
              8px under a meter warning about a DIFFERENT wave at 191%, and the
              two read as one statement. */}
          <span className="block text-[12px] font-medium leading-tight text-foreground">
            Advance to wave {next.wave} depart · {formatTick(next.departAt, false)}
          </span>
          <span className="block truncate font-mono text-[9.5px] leading-tight tracking-wide text-faint">
            {named}
            {extra > 0 ? ` +${extra}` : ""}
          </span>
        </span>
        <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
      </button>
      <p className="px-3 pt-1 text-[10.5px] leading-snug text-faint">
        Moves the playhead only. The run on disk is precomputed; nothing here re-solves it.
      </p>
    </div>
  );
}

export function QueueTab() {
  const bundle = useBundle();
  const view = useEgress(selView);
  const filters = useEgress(selFilters);
  const t = useEgress(selT);

  const run = runForView(bundle, view);

  const zones = useMemo(() => {
    if (!bundle) return [] as EvacZone[];
    // Copy before sorting: the derive selector may hand back a memoised array.
    return [...visibleZones(bundle.zones, filters, run, t)].sort(
      (a, b) => a.hazardEta - b.hazardEta,
    );
  }, [bundle, run, filters, t]);

  const statuses = useMemo(() => {
    const m = new Map<string, ZoneStatus>();
    for (const z of zones) m.set(z.id, zoneStatusAt(run, t, z.id));
    return m;
  }, [zones, run, t]);

  const binding = useMemo(() => bindingWave(run?.plan ?? null), [run]);

  // Denominator for the filter line, from the UNFILTERED layer: "12 of 46" is
  // the only phrasing that tells an operator a filter is hiding something.
  const totalZones = bundle?.zones.zones.length ?? 0;

  const totals = useMemo(() => {
    let hh = 0;
    let nv = 0;
    for (const z of zones) {
      hh += z.households;
      nv += z.noVehicleHouseholds;
    }
    return { hh, nv };
  }, [zones]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-2">
        <span className="label-mono">
          {formatCount(zones.length)}
          {totalZones > zones.length ? ` of ${formatCount(totalZones)}` : ""} zones ·{" "}
          {formatCount(totals.hh)} HH
        </span>
        <span className="label-mono">{formatCount(totals.nv)} no-veh</span>
      </div>

      {/* Tight gap: with the wells no longer outlined, these read as a list of
          rows. A card-sized gap would put them back to being separate cards. */}
      <div className="queue-rows thin-scroll flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-3 pb-3">
        {zones.length === 0 ? (
          <div className="glass-inset px-2.5 py-3 text-[11px] leading-snug text-faint">
            No zones match the active filters. Clear them in the Control pane to see the full queue.
          </div>
        ) : (
          zones.map((z) => (
            <QueueRow key={z.id} zone={z} status={statuses.get(z.id) ?? "held"} t={t} />
          ))
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2.5">
        <LoadMeter wave={binding} />
        <ReleaseFooter run={run} t={t} />
      </div>
    </div>
  );
}

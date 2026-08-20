"use client";

import { Ban, Flame, MapPin, Megaphone, Route, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useBundle } from "@/lib/bundle-context";
import { ZONE_STATUS_LABEL, ZONE_STATUS_VAR } from "@/lib/constants";
import {
  frameAt,
  hazardFrameAt,
  waveForZone,
  zoneClearance,
  zoneEgress,
  zoneStatusAt,
} from "@/lib/derive";
import {
  cx,
  formatCount,
  formatPercent,
  formatShort,
  formatTick,
  URGENCY_LABEL,
  URGENCY_VAR,
  urgencyBand,
} from "@/lib/format";
import { actions, selSelection, selT, selView, useEgress } from "@/lib/store";
import type { ReleaseWave, ZoneStatus } from "@/types/egress";
import { Alarm } from "./panel-kit";
import {
  Bar,
  EmptyHint,
  focusZone,
  runForView,
  SectionLabel,
  StatRow,
  timeToHazard,
} from "./queue-tab";

/** Local operator acknowledgement. Never touches the precomputed plan — the
 *  numbers on screen stay traceable to the run on disk. */
type Mark = "released" | "held" | null;

function WaveBlock({ wave }: { wave: ReleaseWave | null }) {
  if (!wave) {
    return (
      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>Release wave</SectionLabel>
        <p className="text-[11px] leading-snug text-faint">
          This zone is not in a release wave. Either no plan is loaded, or the solver left it
          unstaged.
        </p>
      </div>
    );
  }

  const hot = wave.egressLoad > 0.85;

  return (
    <div className="glass-inset px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Release wave</SectionLabel>
        {wave.binding ? (
          <span className="label-mono" style={{ color: "var(--hazard)" }}>
            Binding
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="readout text-[17px] text-foreground">W{wave.wave}</span>
        <span className="readout text-[13px] text-plan-text">
          {formatTick(wave.departAt, false)}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-subtle">{wave.routeLabel}</div>

      <div className="mt-2">
        <div className="flex items-baseline justify-between gap-2 pb-1">
          <span className="label-mono">Egress capacity used</span>
          <span
            className="readout text-[12px]"
            style={{ color: hot ? "var(--hazard)" : "var(--plan)" }}
          >
            {formatPercent(wave.egressLoad)}
          </span>
        </div>
        <Bar
          value={wave.egressLoad}
          tone={hot ? "hazard" : wave.egressLoad > 0.65 ? "warn" : "plan"}
        />
      </div>

      <div className="mt-2 border-t border-hairline pt-1.5">
        <StatRow label="Wave households" value={formatCount(wave.households)} />
        <StatRow label="Wave no-vehicle" value={formatCount(wave.noVehicleHouseholds)} />
        <StatRow label="Zones in wave" value={formatCount(wave.zoneIds.length)} />
      </div>

      {wave.rationale ? (
        <p className="mt-2 rounded-sm bg-plan-dim px-2 py-1.5 text-[11px] leading-snug text-subtle">
          {wave.rationale}
        </p>
      ) : null}
    </div>
  );
}

export function RouteTab() {
  const bundle = useBundle();
  const view = useEgress(selView);
  const selection = useEgress(selSelection);
  const t = useEgress(selT);
  // A mark belongs to the zone it was made on, not to the panel, so it carries
  // its zone id and self-expires on selection change without an effect.
  const [marked, setMarked] = useState<{ zoneId: string | null; value: Mark }>({
    zoneId: null,
    value: null,
  });

  const zoneId = selection.kind === "zone" ? selection.id : null;
  const mark = marked.zoneId === zoneId ? marked.value : null;
  const setMark = (value: Mark) => setMarked({ zoneId, value });

  const run = runForView(bundle, view);
  const zone = useMemo(
    () => (zoneId ? (bundle?.zones.zones.find((z) => z.id === zoneId) ?? null) : null),
    [bundle, zoneId],
  );

  const wave = useMemo(() => (zone ? waveForZone(run?.plan ?? null, zone.id) : null), [run, zone]);

  // Whether there is still a road out is a fact about this zone, not a detour
  // into another panel — it belongs on the tab a zone click actually opens.
  const egress = useMemo(() => {
    if (!zone || !bundle) return null;
    return zoneEgress(zone, hazardFrameAt(bundle.hazard, t), run ? frameAt(run, t) : null);
  }, [zone, bundle, run, t]);

  const clearance = useMemo(() => (zone ? zoneClearance(run, zone.id, t) : null), [run, zone, t]);

  if (!zone) {
    return (
      <EmptyHint
        icon={MapPin}
        title="No zone selected"
        hint="Pick a zone on the map or in the queue to see its release wave, corridor and hazard margin."
      />
    );
  }

  const status: ZoneStatus = zoneStatusAt(run, t, zone.id);
  const remaining = timeToHazard(zone, t);
  const band = urgencyBand(remaining);
  // The bar drains as the playhead advances: full at T+0, empty at burnover.
  const margin = zone.hazardEta > 0 ? remaining / zone.hazardEta : 0;

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="readout text-[13px] text-foreground">{zone.id}</div>
          <div className="truncate text-[11px] text-subtle" title={zone.label}>
            {zone.label}
          </div>
        </div>
        <span className="label-mono shrink-0 pt-0.5" style={{ color: ZONE_STATUS_VAR[status] }}>
          {ZONE_STATUS_LABEL[status]}
        </span>
      </div>

      {egress?.routeless ? (
        <Alarm icon={ShieldAlert}>
          NO ROUTABLE EGRESS. This zone has no primary route in the graph. A release order moves
          nobody — it needs a dispatched lift or a shelter-in-place decision.
        </Alarm>
      ) : egress?.cutoff ? (
        <Alarm icon={Flame}>
          CUT OFF — all {formatCount(egress.segments)} segments of {zone.primaryRouteLabel} are
          inside the hazard footprint at {formatTick(t, false)}.
        </Alarm>
      ) : null}

      {/* Time to hazard — the number every other number on this tab is racing. */}
      <div className="glass-inset px-2.5 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Time to hazard</SectionLabel>
          <span className="label-mono" style={{ color: URGENCY_VAR[band] }}>
            {URGENCY_LABEL[band]}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 pb-1.5">
          <span className="readout text-[22px]" style={{ color: URGENCY_VAR[band] }}>
            {remaining <= 0 ? "OVERRUN" : formatShort(remaining)}
          </span>
          <span className="label-mono">ETA {formatTick(zone.hazardEta, false)}</span>
        </div>
        <Bar value={margin} tone="hazard" />
      </div>

      <div className="glass-inset px-2.5 py-2">
        <div className="flex items-center gap-1.5 pb-1">
          <Route size={13} strokeWidth={1.75} className="text-faint" />
          <span className="truncate text-[11.5px] font-medium text-foreground">
            {zone.primaryRouteLabel}
          </span>
        </div>
        <StatRow label="Households" value={formatCount(zone.households)} />
        <StatRow label="Vehicles" value={formatCount(zone.vehicles)} />
        <StatRow label="No-vehicle HH" value={formatCount(zone.noVehicleHouseholds)} tone="warn" />
        <StatRow
          label="Segments open"
          value={
            egress?.routeless
              ? "—"
              : `${formatCount(egress?.open ?? 0)} / ${formatCount(egress?.segments ?? zone.primaryRouteEdgeIds.length)}`
          }
          tone={egress?.cutoff ? "hazard" : (egress?.closed ?? 0) > 0 ? "warn" : undefined}
          title="Segments of this zone's primary route the hazard has not closed at the playhead."
        />
        <StatRow
          label="Modelled clearance"
          value={clearance?.clearedAt != null ? formatTick(clearance.clearedAt, false) : "—"}
          tone={
            clearance?.clearedAt != null && clearance.clearedAt > zone.hazardEta
              ? "hazard"
              : clearance?.clearedAt != null
                ? "ok"
                : undefined
          }
          title={
            !run
              ? "No run loaded, so this zone has no modelled clearance."
              : clearance?.unfinished
                ? "The run window ends with households still inside — the clearance is longer than the window, not absent."
                : "First frame at which the run reports nobody left in this zone."
          }
        />
      </div>

      <WaveBlock wave={wave} />

      <div className="mt-auto flex flex-col gap-1.5 pt-1">
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setMark("released");
              if (wave) actions.setT(wave.departAt);
              focusZone(zone);
            }}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11.5px] font-semibold text-white transition-[filter] duration-[120ms] hover:brightness-110"
            style={{ background: "var(--hazard)", border: "1px solid var(--hazard)" }}
          >
            <Megaphone size={13} strokeWidth={1.75} />
            Issue release order
          </button>
          <button
            type="button"
            onClick={() => setMark("held")}
            className={cx(
              "flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline-strong px-2.5 py-2 text-[11.5px] font-medium text-subtle transition-colors duration-[120ms] hover:bg-glass-hover",
              mark === "held" && "bg-glass-active",
            )}
          >
            <Ban size={13} strokeWidth={1.75} />
            Hold zone
          </button>
        </div>
        <p className="label-mono leading-relaxed">
          {mark === "released"
            ? `Order marked issued · local only, plan revision ${run?.plan.revision ?? 0} unchanged`
            : mark === "held"
              ? "Zone marked held · local only, plan unchanged"
              : "Marks are local acknowledgements. They never alter the precomputed run."}
        </p>
      </div>
    </div>
  );
}

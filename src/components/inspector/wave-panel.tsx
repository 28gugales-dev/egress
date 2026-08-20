"use client";

import { AlertTriangle, Layers } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { waveByNumber } from "@/lib/derive";
import {
  formatCount,
  formatPercent,
  formatShort,
  formatTick,
  formatWallClock,
  URGENCY_VAR,
  urgencyBand,
} from "@/lib/format";
import { actions } from "@/lib/store";
import type { Tick, ViewMode } from "@/types/egress";
import { Alarm, Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Bar, Chip, EmptyHint, runForView, SectionLabel } from "./queue-tab";

/** Past this the wave is queueing on its own corridor rather than flowing. */
const LOAD_WARN = 0.85;

/** One release wave: the unit an incident commander actually issues. */
export function WavePanel({ waveId, view, t }: { waveId: string; view: ViewMode; t: Tick }) {
  const bundle = useBundle();
  const run = runForView(bundle, view);

  const wave = useMemo(() => waveByNumber(run?.plan ?? null, Number(waveId)), [run, waveId]);

  const zones = useMemo(() => {
    if (!bundle || !wave) return [];
    const byId = new Map(bundle.zones.zones.map((z) => [z.id, z]));
    return wave.zoneIds.map((id) => byId.get(id) ?? null).filter((z) => z !== null);
  }, [bundle, wave]);

  if (!bundle || !run || !wave) {
    return (
      <EmptyHint
        icon={Layers}
        title="Wave not in this plan"
        hint={
          run
            ? `The ${run.kind} plan has no wave ${waveId}. The baseline releases everyone at once and may carry only one.`
            : "No run is loaded, so there is no release sequence to inspect."
        }
      />
    );
  }

  const hot = wave.egressLoad > LOAD_WARN;
  const untilDepart = wave.departAt - t;
  const margin = wave.hazardEta - wave.departAt;
  const band = urgencyBand(Math.max(0, wave.hazardEta - t));
  const listedHouseholds = zones.reduce((n, z) => n + z.households, 0);

  return (
    <PanelBody>
      <PanelHeader
        kind={`Release wave · ${run.kind} plan`}
        id={`W${wave.wave}`}
        name={wave.routeLabel}
        icon={Layers}
        right={
          wave.binding ? (
            <Chip tone="hazard" title="This wave is what pins total clearance time.">
              BINDING
            </Chip>
          ) : undefined
        }
      />

      {/* A wave over capacity is the console's whole thesis in one number. */}
      {wave.egressLoad > 1 ? (
        <Alarm icon={AlertTriangle}>
          {formatPercent(wave.egressLoad)} of corridor capacity — this wave is oversubscribed as
          planned. The overflow becomes queue, and queue on a burning corridor is exposure.
        </Alarm>
      ) : null}

      <Block
        label="Depart"
        right={
          <span className="readout text-[13px] text-plan-text">
            {formatTick(wave.departAt, false)}
          </span>
        }
      >
        <Field
          label="Wall clock"
          value={formatWallClock(bundle.meta.eventDate, wave.departAt, bundle.meta.startHourLocal)}
        />
        <Field
          label="From playhead"
          value={untilDepart === 0 ? "now" : formatShort(Math.abs(untilDepart))}
          unit={untilDepart > 0 ? "away" : untilDepart < 0 ? "ago" : undefined}
        />
        <Field
          label="Earliest hazard in wave"
          value={formatTick(wave.hazardEta, false)}
          tone={band >= 2 ? "hazard" : undefined}
        />
        <Field
          label="Margin at departure"
          value={formatShort(Math.abs(margin))}
          unit={margin >= 0 ? "before hazard" : "AFTER hazard"}
          tone={margin < 0 ? "hazard" : margin < 1800 ? "warn" : "ok"}
        />
        <button
          type="button"
          onClick={() => actions.setT(wave.departAt)}
          className="mt-1.5 w-full cursor-pointer rounded-md border border-hairline-strong px-2 py-1.5 text-[11.5px] font-medium text-subtle transition-colors duration-[120ms] hover:bg-glass-hover"
        >
          Move playhead to {formatTick(wave.departAt, false)}
        </button>
      </Block>

      <Block
        label="Egress capacity used"
        right={
          <span
            className="readout text-[13px]"
            style={{ color: hot ? "var(--hazard)" : "var(--plan)" }}
          >
            {formatPercent(wave.egressLoad)}
          </span>
        }
      >
        <Bar
          value={wave.egressLoad}
          tone={hot ? "hazard" : wave.egressLoad > 0.65 ? "warn" : "plan"}
        />
        <div className="mt-1.5">
          <Field label="Corridor" value={wave.routeLabel} />
          <Field
            label="Headroom"
            value={wave.egressLoad >= 1 ? null : formatPercent(1 - wave.egressLoad)}
            title="What is left on the binding edge of this corridor. Absent when the wave is already over capacity."
          />
        </div>
      </Block>

      <Block label="Load in this wave">
        <Field label="Households ordered" value={formatCount(wave.households)} />
        <Field
          label="No-vehicle HH"
          value={formatCount(wave.noVehicleHouseholds)}
          tone={wave.noVehicleHouseholds > 0 ? "warn" : undefined}
          title="These households need a dispatched lift. A release order does not move them."
        />
        <Field label="Zones" value={formatCount(wave.zoneIds.length)} />
        {listedHouseholds !== wave.households && zones.length > 0 ? (
          <p className="mt-1 text-[11px] leading-snug text-faint">
            The zone layer sums to {formatCount(listedHouseholds)} households across these zones,
            against the wave's own {formatCount(wave.households)}. The wave figure is what the
            solver released under the compliance parameter.
          </p>
        ) : null}
      </Block>

      {wave.rationale ? (
        <div className="rounded-sm bg-plan-dim px-2 py-1.5">
          <SectionLabel>Why here</SectionLabel>
          <p className="text-[11px] leading-snug text-subtle">{wave.rationale}</p>
        </div>
      ) : null}

      <div>
        <SectionLabel>Zones in this wave · {formatCount(zones.length)}</SectionLabel>
        {zones.length === 0 ? (
          <p className="text-[11px] leading-snug text-faint">
            The wave names {formatCount(wave.zoneIds.length)} zones, none of which are in the
            current zone layer. The plan and the zone layer are out of step.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {zones.map((z) => {
              const remaining = Math.max(0, z.hazardEta - t);
              return (
                <LinkRow
                  key={z.id}
                  kind="zone"
                  id={z.id}
                  center={z.centroid}
                  primary={z.id}
                  secondary={`${formatCount(z.households)} HH · ${formatCount(z.noVehicleHouseholds)} no-veh`}
                  right={
                    <span
                      className="readout text-[11px]"
                      style={{ color: URGENCY_VAR[urgencyBand(remaining)] }}
                    >
                      {remaining <= 0 ? "OVERRUN" : formatShort(remaining)}
                    </span>
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      <Sources
        lines={[
          {
            label: "Release sequence",
            value: `${run.kind} run, plan revision ${run.plan.revision}, generated ${run.plan.generatedAt}. Waves come from the deterministic time-expanded capacity flow, not from a model that can hallucinate.`,
            kind: "modelled",
          },
          {
            label: "Hazard ETA",
            value: bundle.hazard.source,
            kind: "observed",
          },
        ]}
      />
    </PanelBody>
  );
}

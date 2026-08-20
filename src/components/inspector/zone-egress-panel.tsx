"use client";

import { Flame, MapPin, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { ZONE_STATUS_LABEL, ZONE_STATUS_VAR } from "@/lib/constants";
import {
  closedEdgeSet,
  edgeById,
  frameAt,
  hazardFrameAt,
  waveForZone,
  zoneClearance,
  zoneEgress,
  zoneStatusAt,
} from "@/lib/derive";
import {
  formatCount,
  formatPercent,
  formatShort,
  formatTick,
  URGENCY_LABEL,
  URGENCY_VAR,
  urgencyBand,
} from "@/lib/format";
import type { RoadEdge, Tick, ViewMode } from "@/types/egress";
import { Alarm, Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Bar, Chip, EmptyHint, runForView, SectionLabel } from "./queue-tab";

/** How many segments of a long route to name before the list stops helping. */
const SEGMENT_LIMIT = 5;

interface Segment {
  edge: RoadEdge;
  load: number;
  closed: boolean;
}

/**
 * The zone as an egress problem rather than as a release decision.
 *
 * The Route tab answers "when does this zone go". This one answers the question
 * underneath it — whether there is still a road out at all, which segment of it
 * is binding, and how long the solver thinks the zone takes to empty.
 */
export function ZoneEgressPanel({ zoneId, view, t }: { zoneId: string; view: ViewMode; t: Tick }) {
  const bundle = useBundle();
  const run = runForView(bundle, view);

  const zone = useMemo(
    () => bundle?.zones.zones.find((z) => z.id === zoneId) ?? null,
    [bundle, zoneId],
  );

  const runFrame = run ? frameAt(run, t) : null;
  const hazardFrame = bundle ? hazardFrameAt(bundle.hazard, t) : null;

  const egress = useMemo(
    () => (zone ? zoneEgress(zone, hazardFrame, runFrame) : null),
    [zone, hazardFrame, runFrame],
  );

  /** Route segments worth naming: everything closed, then the busiest open ones. */
  const segments = useMemo((): Segment[] => {
    if (!bundle || !zone) return [];
    const closed = hazardFrame ? closedEdgeSet(hazardFrame) : null;
    const rows: Segment[] = [];
    for (const id of zone.primaryRouteEdgeIds) {
      const edge = edgeById(bundle.network, id);
      if (!edge) continue;
      rows.push({ edge, load: runFrame?.edgeLoad[id] ?? 0, closed: closed?.has(id) ?? false });
    }
    rows.sort((a, b) => {
      if (a.closed !== b.closed) return a.closed ? -1 : 1;
      return b.load - a.load;
    });
    return rows;
  }, [bundle, zone, hazardFrame, runFrame]);

  const clearance = useMemo(() => zoneClearance(run, zoneId, t), [run, zoneId, t]);
  const wave = useMemo(() => (zone ? waveForZone(run?.plan ?? null, zone.id) : null), [run, zone]);

  if (!bundle || !zone) {
    return (
      <EmptyHint
        icon={MapPin}
        title="Zone not in this scenario"
        hint={`${zoneId} is not present in zones.json. Rebuild with pnpm data:zones if the scenario changed.`}
      />
    );
  }

  const status = zoneStatusAt(run, t, zone.id);
  const toHazard = Math.max(0, zone.hazardEta - t);
  const band = urgencyBand(toHazard);
  const openFraction = egress && egress.segments > 0 ? egress.open / egress.segments : 0;
  const drained =
    clearance && clearance.initial > 0 ? 1 - clearance.remaining / clearance.initial : null;

  return (
    <PanelBody>
      <PanelHeader
        kind="Evacuation zone"
        id={zone.id}
        name={zone.label}
        icon={MapPin}
        right={
          <span className="label-mono" style={{ color: ZONE_STATUS_VAR[status] }}>
            {ZONE_STATUS_LABEL[status]}
          </span>
        }
      />

      {/* A zone with nowhere to go is the most important thing on this map. */}
      {egress?.routeless ? (
        <Alarm icon={ShieldAlert}>
          NO ROUTABLE EGRESS. This zone was published with no primary route at all — the graph
          reaches no sink from it. Everyone inside needs a dispatched lift or a shelter-in-place
          decision, and no release order will move them.
        </Alarm>
      ) : egress?.cutoff ? (
        <Alarm icon={Flame}>
          CUT OFF at {formatTick(t, false)} — all {formatCount(egress.segments)} segments of this
          zone's route are inside the hazard footprint. Anyone still inside cannot drive out on the
          planned corridor.
        </Alarm>
      ) : null}

      <Block
        label="Routable egress"
        right={
          <span
            className="readout text-[13px]"
            style={{
              color: egress?.cutoff || egress?.routeless ? "var(--hazard)" : "var(--plan)",
            }}
          >
            {egress?.routeless
              ? "NONE"
              : `${formatCount(egress?.open ?? 0)} / ${formatCount(egress?.segments ?? 0)}`}
          </span>
        }
      >
        <Bar value={openFraction} tone={egress?.cutoff ? "hazard" : "plan"} />
        <div className="mt-1.5">
          <Field label="Corridor" value={zone.primaryRouteLabel} />
          <Field
            label="Segments open"
            value={egress?.routeless ? null : formatCount(egress?.open ?? 0)}
          />
          <Field
            label="Segments closed by hazard"
            value={egress?.routeless ? null : formatCount(egress?.closed ?? 0)}
            tone={(egress?.closed ?? 0) > 0 ? "hazard" : undefined}
          />
          <Field
            label="Worst load on route"
            value={egress && egress.worstLoad >= 0 && run ? formatPercent(egress.worstLoad) : null}
            tone={
              egress && egress.worstLoad > 0.85
                ? "hazard"
                : egress && egress.worstLoad > 0.65
                  ? "warn"
                  : undefined
            }
            title="Highest load fraction on any still-open segment of this zone's route, at the playhead."
          />
        </div>
      </Block>

      <Block
        label="Time to hazard"
        right={
          <span className="label-mono" style={{ color: URGENCY_VAR[band] }}>
            {URGENCY_LABEL[band]}
          </span>
        }
      >
        <div className="flex items-baseline justify-between gap-2 pb-1.5">
          <span className="readout text-[20px]" style={{ color: URGENCY_VAR[band] }}>
            {toHazard <= 0 ? "OVERRUN" : formatShort(toHazard)}
          </span>
          <span className="label-mono">ETA {formatTick(zone.hazardEta, false)}</span>
        </div>
        <Bar value={zone.hazardEta > 0 ? toHazard / zone.hazardEta : 0} tone="hazard" />
      </Block>

      <Block
        label="Modelled clearance"
        right={
          <span
            className="readout text-[13px]"
            style={{ color: clearance?.clearedAt != null ? "var(--ok)" : "var(--faint)" }}
          >
            {clearance?.clearedAt != null ? formatTick(clearance.clearedAt, false) : "—"}
          </span>
        }
      >
        {drained !== null ? <Bar value={drained} tone="ok" /> : null}
        <div className={drained !== null ? "mt-1.5" : undefined}>
          <Field
            label="Households at start"
            value={clearance && clearance.initial >= 0 ? formatCount(clearance.initial) : null}
          />
          <Field
            label="Still inside now"
            value={clearance ? formatCount(clearance.remaining) : null}
            tone={clearance && clearance.remaining > 0 ? "warn" : undefined}
          />
          <Field
            label="Clear of hazard by"
            value={
              clearance?.clearedAt != null
                ? clearance.clearedAt <= zone.hazardEta
                  ? `${formatShort(zone.hazardEta - clearance.clearedAt)} margin`
                  : `${formatShort(clearance.clearedAt - zone.hazardEta)} LATE`
                : null
            }
            tone={
              clearance?.clearedAt != null && clearance.clearedAt > zone.hazardEta
                ? "hazard"
                : clearance?.clearedAt != null
                  ? "ok"
                  : undefined
            }
          />
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          {!run
            ? "No run is loaded, so this zone has no modelled clearance."
            : !clearance
              ? "This run never reports occupancy for this zone, so its clearance is unknown rather than instant."
              : clearance.unfinished
                ? `The run window ends at ${formatTick(bundle.meta.duration, false)} with households still inside. The clearance time is longer than the window, not absent.`
                : "First frame at which the run reports nobody left in the zone."}
        </p>
      </Block>

      <Block label="Population at stake">
        <Field label="Population" value={formatCount(zone.population)} />
        <Field label="Households" value={formatCount(zone.households)} />
        <Field
          label="No-vehicle HH"
          value={formatCount(zone.noVehicleHouseholds)}
          tone={zone.noVehicleHouseholds > 0 ? "warn" : undefined}
        />
        <Field label="Vehicles" value={formatCount(zone.vehicles)} />
        <Field label="Mobile homes" value={formatCount(zone.mobileHomes)} />
        <Field
          label="County structures"
          value={zone.officialStructures != null ? formatCount(zone.officialStructures) : null}
          title="The county's own structure count, where the zone came from a published official layer."
        />
      </Block>

      {wave ? (
        <div>
          <SectionLabel>Release wave</SectionLabel>
          <LinkRow
            kind="wave"
            id={String(wave.wave)}
            primary={`Wave ${wave.wave} · ${formatTick(wave.departAt, false)}`}
            secondary={`${wave.routeLabel} · ${formatCount(wave.zoneIds.length)} zones`}
            right={
              <Chip tone={wave.egressLoad > 0.85 ? "hazard" : "plan"}>
                {formatPercent(wave.egressLoad)}
              </Chip>
            }
          />
        </div>
      ) : null}

      {segments.length > 0 ? (
        <div>
          <SectionLabel>
            Route segments · {formatCount(segments.length)} of{" "}
            {formatCount(zone.primaryRouteEdgeIds.length)} in graph
          </SectionLabel>
          <div className="flex flex-col gap-1">
            {segments.slice(0, SEGMENT_LIMIT).map((s) => (
              <LinkRow
                key={s.edge.id}
                kind="edge"
                id={s.edge.id}
                primary={s.edge.name ?? s.edge.id}
                secondary={`${formatCount(s.edge.capacity)} veh/hr · ${formatCount(s.edge.lanes)} lanes`}
                right={
                  <span
                    className="readout text-[11px]"
                    style={{
                      color: s.closed
                        ? "var(--hazard)"
                        : s.load > 0.85
                          ? "var(--hazard)"
                          : s.load > 0.65
                            ? "var(--warn)"
                            : "var(--faint)",
                    }}
                  >
                    {s.closed ? "CLOSED" : run ? formatPercent(s.load) : "—"}
                  </span>
                }
              />
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-faint">
            Closed segments first, then the busiest. The rest of the route is quieter than these.
          </p>
        </div>
      ) : null}

      <Sources
        lines={[
          {
            label: "Zone geometry and counts",
            value: `zones.json, generated ${bundle.zones.generatedAt}. Households and vehicles are ACS estimates apportioned to the zone polygon.`,
            kind: "modelled",
          },
          {
            label: "Hazard ETA and closures",
            value: hazardFrame
              ? `Hazard frame at ${formatTick(hazardFrame.t, false)}, ${hazardFrame.provenance}. ${bundle.hazard.source}`
              : "No hazard track loaded.",
            kind: hazardFrame?.provenance === "observed" ? "observed" : "interpolated",
          },
          {
            label: "Clearance and load",
            value: run
              ? `${run.kind} run over ${formatCount(run.frames.length)} frames, plan revision ${run.plan.revision}, generated ${run.generatedAt}`
              : "No run loaded.",
            kind: "modelled",
          },
        ]}
      />
    </PanelBody>
  );
}

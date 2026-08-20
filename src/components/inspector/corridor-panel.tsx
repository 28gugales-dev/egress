"use client";

import { Flame, Route } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { LANE_CAPACITY } from "@/lib/constants";
import {
  closedEdgeSet,
  contraflowFor,
  edgeById,
  frameAt,
  hazardFrameAt,
  zonesUsingEdge,
} from "@/lib/derive";
import {
  formatCount,
  formatDistance,
  formatPercent,
  formatShort,
  formatTick,
  URGENCY_VAR,
  urgencyBand,
} from "@/lib/format";
import type { RoadClass, Tick, ViewMode } from "@/types/egress";
import { Alarm, Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Bar, Chip, EmptyHint, runForView, SectionLabel } from "./queue-tab";

const ROAD_CLASS_LABEL: Record<RoadClass, string> = {
  motorway: "Motorway",
  trunk: "Trunk",
  primary: "Primary",
  secondary: "Secondary",
  tertiary: "Tertiary",
  residential: "Residential",
  unclassified: "Unclassified",
  service: "Service",
};

/** Past this the corridor is queueing rather than flowing. Same threshold the
 *  queue tab's load meter uses, so the two panels cannot disagree. */
const LOAD_WARN = 0.85;

export function CorridorPanel({ edgeId, view, t }: { edgeId: string; view: ViewMode; t: Tick }) {
  const bundle = useBundle();
  const run = runForView(bundle, view);

  const edge = edgeById(bundle?.network ?? null, edgeId);

  const frame = run ? frameAt(run, t) : null;
  const hazardFrame = bundle ? hazardFrameAt(bundle.hazard, t) : null;

  const zones = useMemo(
    () => (bundle && edge ? zonesUsingEdge(bundle.zones, edge.id) : []),
    [bundle, edge],
  );
  const contraflow = useMemo(
    () => (edge ? contraflowFor(run?.plan ?? null, edge.id) : null),
    [run, edge],
  );

  if (!bundle) {
    return (
      <EmptyHint
        icon={Route}
        title="No network loaded"
        hint="Road geometry comes from network.json. Run pnpm data:network to populate it."
      />
    );
  }

  if (!edge) {
    return (
      <EmptyHint
        icon={Route}
        title="Segment not in this network"
        hint={`${edgeId} is not present in network.json for this scenario. It may belong to a run generated against an older graph.`}
      />
    );
  }

  const closed = hazardFrame ? closedEdgeSet(hazardFrame).has(edge.id) : false;
  const load = frame?.edgeLoad[edge.id];
  const hasLoad = load !== undefined;
  const hot = hasLoad && load > LOAD_WARN;
  const perLane = LANE_CAPACITY[edge.roadClass];

  const cfActive = contraflow ? t >= contraflow.activateAt && t < contraflow.releaseAt : false;
  // Contraflow capacities are published for the ORDER, which spans many edges.
  // Quoting them against one segment would overstate what this segment does.
  const cfGain = contraflow ? contraflow.capacityAfter - contraflow.capacityBefore : 0;

  const households = zones.reduce((n, z) => n + z.households, 0);
  const soonest = zones.reduce(
    (best, z) => (best === null || z.hazardEta < best ? z.hazardEta : best),
    null as number | null,
  );

  return (
    <PanelBody>
      <PanelHeader
        kind="Corridor segment"
        id={edge.id}
        name={edge.name ?? "Unnamed way"}
        icon={Route}
        right={<Chip tone="neutral">{ROAD_CLASS_LABEL[edge.roadClass]}</Chip>}
      />

      {closed ? (
        <Alarm icon={Flame}>
          Impassable at {formatTick(t, false)} — the hazard footprint has closed this segment. Any
          zone routed over it is being sent into the fire.
        </Alarm>
      ) : null}

      {/* Load is the whole argument: a corridor is a shared, finite resource,
          and this is the number a navigation app never computes. */}
      <Block
        label="Load at playhead"
        right={
          <span
            className="readout text-[13px]"
            style={{
              color: !hasLoad
                ? "var(--faint)"
                : hot
                  ? "var(--hazard)"
                  : load > 0.65
                    ? "var(--warn)"
                    : "var(--plan)",
            }}
          >
            {hasLoad ? formatPercent(load) : "—"}
          </span>
        }
      >
        <Bar
          value={hasLoad ? load : 0}
          tone={hot ? "hazard" : hasLoad && load > 0.65 ? "warn" : "plan"}
        />
        <div className="mt-1.5">
          <Field
            label="Capacity"
            value={formatCount(edge.capacity)}
            unit="veh/hr"
            title="Directional capacity: lanes x per-lane capacity for this road class."
          />
          <Field
            label="Flowing now"
            value={hasLoad ? formatCount(load * edge.capacity) : null}
            unit="veh/hr"
            title="Load fraction multiplied by directional capacity. Derived here, not carried in the run."
          />
          <Field label="Lanes" value={formatCount(edge.lanes)} />
          <Field label="Per lane" value={formatCount(perLane)} unit="veh/hr" />
        </div>
        {!hasLoad ? (
          <p className="mt-1.5 text-[11px] leading-snug text-faint">
            {run
              ? "The run reports no load on this segment at this frame. Sparse by design — absent means empty, not unknown."
              : "No simulation run is loaded, so this segment has no modelled load."}
          </p>
        ) : hot ? (
          <p className="mt-1.5 text-[11px] leading-snug text-hazard-text">
            Over {formatPercent(LOAD_WARN)} of capacity. Adding a zone to this corridor lengthens
            the queue rather than moving anyone faster.
          </p>
        ) : null}
      </Block>

      <Block label="Standing queue">
        <Field
          label="On this segment"
          value={null}
          unit="m"
          title="Per-edge queue length is not carried in RunFrame. Only a run-wide peak is."
        />
        <Field
          label="Run-wide peak, this frame"
          value={frame ? formatCount(frame.peakQueueLength) : null}
          unit="m"
        />
        <Field
          label="Run-wide peak, whole run"
          value={run ? formatCount(run.summary.peakQueueLength) : null}
          unit="m"
        />
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          The run records the longest queue on <em>any</em> edge, not per segment. The em-dash above
          is that gap, not a zero.
        </p>
      </Block>

      <Block
        label="Contraflow"
        right={
          <Chip tone={cfActive ? "plan" : "neutral"}>
            {cfActive
              ? "ACTIVE"
              : contraflow
                ? "ORDERED"
                : edge.contraflowEligible
                  ? "ELIGIBLE"
                  : "NOT ELIGIBLE"}
          </Chip>
        }
      >
        {contraflow ? (
          <>
            <div className="truncate pb-1 text-[11px] text-subtle" title={contraflow.label}>
              {contraflow.label}
            </div>
            <Field label="Activate" value={formatTick(contraflow.activateAt, false)} />
            <Field label="Release" value={formatTick(contraflow.releaseAt, false)} />
            <Field
              label="Corridor before"
              value={formatCount(contraflow.capacityBefore)}
              unit="veh/hr"
            />
            <Field
              label="Corridor after"
              value={formatCount(contraflow.capacityAfter)}
              unit="veh/hr"
              tone={cfGain > 0 ? "plan" : undefined}
            />
            <Field label="Segments in order" value={formatCount(contraflow.edgeIds.length)} />
            <p className="mt-1.5 text-[11px] leading-snug text-faint">
              Those two capacities are for the whole order, across{" "}
              {formatCount(contraflow.edgeIds.length)} segments — not for this segment alone.
            </p>
          </>
        ) : (
          <p className="text-[11px] leading-snug text-faint">
            {edge.contraflowEligible
              ? "Reversible in principle — the road class allows it — but this plan issues no order over it."
              : "Reversing this class of road gains nothing and strands driveways, so the planner will not order it."}
          </p>
        )}
      </Block>

      <Block label="Geometry">
        <Field label="Length" value={formatDistance(edge.length)} />
        <Field label="Free-flow speed" value={formatCount(edge.speed)} unit="km/h" />
        <Field label="One way" value={edge.oneway ? "Yes" : "No"} />
        <Field label="Shape points" value={formatCount(edge.geometry.length)} />
      </Block>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Zones routed over this segment · {formatCount(zones.length)}</SectionLabel>
          {zones.length > 0 ? (
            <span className="label-mono">{formatCount(households)} HH</span>
          ) : null}
        </div>
        {zones.length === 0 ? (
          <p className="text-[11px] leading-snug text-faint">
            No zone's published primary route runs over this segment. It may still carry shadow
            traffic, which the run models but does not attribute to a zone.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {zones.map((z) => {
              const band = urgencyBand(Math.max(0, z.hazardEta - t));
              return (
                <LinkRow
                  key={z.id}
                  kind="zone"
                  id={z.id}
                  center={z.centroid}
                  primary={z.id}
                  secondary={`${formatCount(z.households)} HH · ${z.primaryRouteLabel}`}
                  right={
                    <span className="readout text-[11px]" style={{ color: URGENCY_VAR[band] }}>
                      {z.hazardEta - t <= 0 ? "OVERRUN" : formatShort(z.hazardEta - t)}
                    </span>
                  }
                />
              );
            })}
          </div>
        )}
        {soonest !== null ? (
          <p className="mt-1.5 text-[11px] leading-snug text-faint">
            Earliest hazard arrival across those zones is {formatTick(soonest, false)}. That is the
            deadline this segment is working against.
          </p>
        ) : null}
      </div>

      <Sources
        lines={[
          {
            label: "Geometry, lanes, class",
            value: bundle.network.source,
            kind: "observed",
          },
          {
            label: "Capacity",
            value: `${formatCount(edge.lanes)} lanes x ${formatCount(perLane)} veh/hr/lane for ${ROAD_CLASS_LABEL[edge.roadClass].toLowerCase()}. Per-lane figures are Highway Capacity Manual values discounted for evacuation conditions — defensible, not precise.`,
            kind: "authored",
          },
          {
            label: "Load and queue",
            value: run
              ? `${run.kind} run, plan revision ${run.plan.revision}, generated ${run.generatedAt}`
              : "No run loaded.",
            kind: "modelled",
          },
          {
            label: "Closure",
            value: hazardFrame
              ? `Hazard frame at ${formatTick(hazardFrame.t, false)} (${hazardFrame.provenance}) closes ${formatCount(hazardFrame.closedEdgeIds.length)} edges.`
              : "No hazard track loaded.",
            kind: hazardFrame?.provenance === "observed" ? "observed" : "interpolated",
          },
        ]}
      />
    </PanelBody>
  );
}

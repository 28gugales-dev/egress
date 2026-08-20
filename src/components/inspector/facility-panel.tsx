"use client";

import { Building2, Flame, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { DISPATCH_ORIGINS, FACILITY_LABEL } from "@/lib/constants";
import { facilityExposure, pointInRings } from "@/lib/derive";
import { formatCount, formatPercent, formatShort, formatTick } from "@/lib/format";
import type { Tick, ViewMode } from "@/types/egress";
import { Alarm, Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Bar, Chip, EmptyHint, runForView, SectionLabel } from "./queue-tab";

/** Kinds that receive evacuees rather than launch assets. */
const DESTINATION_KINDS = new Set(["shelter", "hospital"]);

export function FacilityPanel({
  facilityId,
  view,
  t,
}: {
  facilityId: string;
  view: ViewMode;
  t: Tick;
}) {
  const bundle = useBundle();
  const run = runForView(bundle, view);

  const facility = useMemo(
    () => bundle?.facilities.facilities.find((f) => f.id === facilityId) ?? null,
    [bundle, facilityId],
  );

  const exposure = useMemo(
    () => (facility ? facilityExposure(facility, bundle?.hazard ?? null) : null),
    [facility, bundle],
  );

  /** The evacuation zone whose polygon contains this facility, if any. */
  const containing = useMemo(() => {
    if (!bundle || !facility) return null;
    return bundle.zones.zones.find((z) => pointInRings(facility.position, z.geometry)) ?? null;
  }, [bundle, facility]);

  const dispatch = useMemo(() => {
    const manifests = run?.plan.manifests ?? [];
    if (!facility) return { origin: [], inboundPax: 0, inboundRuns: 0 };
    const origin = manifests.filter((m) => m.originFacilityId === facility.id);
    let inboundPax = 0;
    let inboundRuns = 0;
    for (const m of manifests) {
      if (m.dropFacilityId !== facility.id) continue;
      inboundRuns++;
      for (const s of m.stops) inboundPax += s.passengers;
    }
    return { origin, inboundPax, inboundRuns };
  }, [run, facility]);

  if (!bundle) {
    return (
      <EmptyHint
        icon={Building2}
        title="No facility layer loaded"
        hint="Facilities come from HIFLD and OpenStreetMap. Run pnpm data:facilities to populate them."
      />
    );
  }

  if (!facility) {
    return (
      <EmptyHint
        icon={Building2}
        title="Facility not in this scenario"
        hint={`${facilityId} is not present in facilities.json for ${bundle.meta.name}.`}
      />
    );
  }

  const isOrigin = DISPATCH_ORIGINS.includes(facility.kind);
  const isDestination = DESTINATION_KINDS.has(facility.kind);
  const assets = facility.assets.bus + facility.assets.ambulance + facility.assets.engine;
  const hasCapacity = facility.capacity > 0;
  const capacityPct = hasCapacity ? dispatch.inboundPax / facility.capacity : 0;

  const atRisk = exposure?.atRisk ?? null;
  const remaining = atRisk === null ? null : atRisk - t;
  const overrun = remaining !== null && remaining <= 0;

  // The source string is printed verbatim below; several of these carry their
  // own disclaimer and paraphrasing one would be exactly the trap CLAUDE.md
  // names. This flag only decides whether to say it twice, loudly.
  const disclaimed = facility.source.toLowerCase().startsWith("derived:");

  return (
    <PanelBody>
      <PanelHeader
        kind={FACILITY_LABEL[facility.kind]}
        id={facility.id}
        name={facility.name}
        icon={Building2}
        right={
          <Chip tone={isOrigin ? "plan" : isDestination ? "ok" : "neutral"}>
            {isOrigin ? "DISPATCH ORIGIN" : isDestination ? "DESTINATION" : "EXPOSURE ONLY"}
          </Chip>
        }
      />

      {/* A shelter inside the footprint is the finding this panel exists for. */}
      {atRisk !== null ? (
        <Alarm icon={Flame} tone={overrun ? "hazard" : "warn"}>
          {overrun
            ? `Inside the hazard footprint since ${formatTick(atRisk, false)}. `
            : `The hazard footprint reaches this site at ${formatTick(atRisk, false)} — ${formatShort(remaining ?? 0)} from the playhead. `}
          {isDestination
            ? "Do not route evacuees here without re-checking the perimeter."
            : "Assets staged here need a relocation order."}
        </Alarm>
      ) : null}

      {disclaimed ? (
        <Alarm icon={TriangleAlert} tone="warn">
          This site is congregate-venue stock we identified, not a designated shelter the county
          published. Treat the capacity below as building capacity, not an activated shelter.
        </Alarm>
      ) : null}

      <Block
        label="Hazard exposure"
        right={
          <span
            className="readout text-[13px]"
            style={{
              color: atRisk === null ? "var(--faint)" : overrun ? "var(--hazard)" : "var(--warn)",
            }}
          >
            {atRisk === null ? "CLEAR" : overrun ? "OVERRUN" : formatShort(remaining ?? 0)}
          </span>
        }
      >
        <Field
          label="Footprint arrives"
          value={atRisk === null ? null : formatTick(atRisk, false)}
        />
        <Field
          label="Test basis"
          value={
            exposure?.basis === "payload"
              ? "Pipeline stamp"
              : exposure?.basis === "derived"
                ? "Point in perimeter"
                : exposure?.basis === "clear"
                  ? "Tested, never inside"
                  : null
          }
          title="How the arrival time above was established."
        />
        <Field
          label="Position"
          value={`${facility.position[1].toFixed(4)}, ${facility.position[0].toFixed(4)}`}
        />
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          {exposure?.basis === "clear"
            ? "No hazard frame in this scenario contains this point. Smoke, ember cast and access loss are not modelled — a facility outside the perimeter is not automatically usable."
            : exposure?.basis === "derived"
              ? "The pipeline published no at-risk time for this facility, so the point was tested against the perimeter rings here, in the browser, on selection."
              : exposure?.basis === "unknown"
                ? "No hazard track is loaded, so exposure could not be tested."
                : "Quoted from the facility payload's own at-risk stamp."}
        </p>
      </Block>

      <Block label="Capacity and assets">
        <Field
          label="Shelter capacity"
          value={hasCapacity ? formatCount(facility.capacity) : null}
          unit={hasCapacity ? "people" : undefined}
          title={
            hasCapacity
              ? "Published shelter capacity."
              : "Not a sheltering facility, or no capacity is published. Zero here would be a claim we cannot make."
          }
        />
        <Field
          label="Buses"
          value={facility.assets.bus > 0 ? formatCount(facility.assets.bus) : null}
        />
        <Field
          label="Ambulances"
          value={facility.assets.ambulance > 0 ? formatCount(facility.assets.ambulance) : null}
        />
        <Field
          label="Engines"
          value={facility.assets.engine > 0 ? formatCount(facility.assets.engine) : null}
        />
        {assets === 0 ? (
          <p className="mt-1 text-[11px] leading-snug text-faint">
            No assets are attributed to this site. HIFLD publishes no fleet roster, so an em-dash
            here means unrecorded, not empty.
          </p>
        ) : null}
      </Block>

      <Block
        label="Dispatch"
        right={
          hasCapacity && dispatch.inboundPax > 0 ? (
            <span
              className="readout text-[13px]"
              style={{ color: capacityPct > 1 ? "var(--hazard)" : "var(--plan)" }}
            >
              {formatPercent(capacityPct)}
            </span>
          ) : undefined
        }
      >
        <Field label="Runs originating here" value={formatCount(dispatch.origin.length)} />
        <Field label="Runs dropping here" value={formatCount(dispatch.inboundRuns)} />
        <Field
          label="Inbound passengers"
          value={dispatch.inboundRuns > 0 ? formatCount(dispatch.inboundPax) : null}
          tone={hasCapacity && dispatch.inboundPax > facility.capacity ? "hazard" : undefined}
        />
        {hasCapacity && dispatch.inboundPax > 0 ? (
          <div className="pt-1">
            <Bar
              value={capacityPct}
              tone={capacityPct > 1 ? "hazard" : capacityPct > 0.85 ? "warn" : "ok"}
            />
          </div>
        ) : null}
        {dispatch.origin.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1">
            <SectionLabel>Manifests from this site</SectionLabel>
            {dispatch.origin.slice(0, 6).map((m) => (
              <LinkRow
                key={m.id}
                kind="vehicle"
                id={m.id}
                primary={m.id}
                secondary={`${m.kind} · ${formatCount(m.stops.length)} stops · drops ${m.dropLabel}`}
              />
            ))}
            {dispatch.origin.length > 6 ? (
              <span className="label-mono">
                +{formatCount(dispatch.origin.length - 6)} more on the Teams tab
              </span>
            ) : null}
          </div>
        ) : null}
        {!run ? (
          <p className="mt-1.5 text-[11px] leading-snug text-faint">
            No run is loaded, so no dispatch is attributed to this site.
          </p>
        ) : null}
      </Block>

      {containing ? (
        <div>
          <SectionLabel>Inside evacuation zone</SectionLabel>
          <LinkRow
            kind="zone"
            id={containing.id}
            center={containing.centroid}
            primary={containing.id}
            secondary={`${formatCount(containing.households)} HH · ${containing.primaryRouteLabel}`}
          />
        </div>
      ) : null}

      <Sources
        lines={[
          { label: "Facility record", value: facility.source, kind: "observed" },
          {
            label: "Hazard arrival",
            value:
              exposure?.basis === "payload"
                ? "Stamped by the facilities pipeline."
                : exposure?.basis === "unknown"
                  ? "No hazard track loaded."
                  : `Point-in-polygon against ${formatCount(bundle.hazard.frames.length)} perimeter frames, computed in this browser.${
                      exposure?.frameProvenance === "interpolated"
                        ? " The matching frame is interpolated between observations, so the time is approximate."
                        : ""
                    }`,
            kind: exposure?.basis === "payload" ? "modelled" : "derived",
          },
          {
            label: "Dispatch",
            value: run
              ? `${run.kind} run, plan revision ${run.plan.revision}, generated ${run.generatedAt}`
              : "No run loaded.",
            kind: "modelled",
          },
        ]}
        note="Capacity and asset counts are what the upstream registry published, not a live status board. Nothing here is confirmed staffed or open."
      />
    </PanelBody>
  );
}

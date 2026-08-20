"use client";

import { Flame } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { hazardFrameAt, lastAtOrBefore, pointInRings } from "@/lib/derive";
import { formatCount, formatShort, formatTick, formatWallClock } from "@/lib/format";
import type { Tick } from "@/types/egress";
import { Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Chip, EmptyHint, SectionLabel } from "./queue-tab";

/** Compass point for a meteorological bearing. 16-point, the resolution a
 *  field report actually uses. */
const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * The hazard footprint at one instant.
 *
 * The most important row here is provenance: 96 of the Camp Fire's 97 frames
 * sit between two satellite passes. The perimeter on screen is a defensible
 * interpolation, and this panel says so rather than letting a smooth animation
 * imply a measurement every five minutes.
 */
export function HazardPanel({ frameT, t }: { frameT: string; t: Tick }) {
  const bundle = useBundle();

  // The id names a frame, but the operator reads the panel against the
  // playhead. An explicit id wins; "current" tracks the scrubber.
  const at = frameT === "current" || frameT === "" ? t : Number(frameT);

  const frame = bundle ? hazardFrameAt(bundle.hazard, at) : null;

  const wind = useMemo(() => {
    const samples = bundle?.hazard.wind ?? [];
    if (samples.length === 0) return null;
    return samples[lastAtOrBefore(samples, at)];
  }, [bundle, at]);

  /** Last frame at or before this one that was actually observed. */
  const lastObserved = useMemo(() => {
    const frames = bundle?.hazard.frames ?? [];
    for (let i = lastAtOrBefore(frames, at); i >= 0; i--) {
      if (frames[i].provenance === "observed") return frames[i];
    }
    return null;
  }, [bundle, at]);

  const inside = useMemo(() => {
    if (!bundle || !frame) return { zones: [], facilities: 0 };
    const zones = bundle.zones.zones.filter((z) => pointInRings(z.centroid, frame.rings));
    const facilities = bundle.facilities.facilities.filter((f) =>
      pointInRings(f.position, frame.rings),
    ).length;
    return { zones, facilities };
  }, [bundle, frame]);

  if (!bundle || !frame) {
    return (
      <EmptyHint
        icon={Flame}
        title="No hazard track loaded"
        hint="Perimeter frames come from hazard.json. Run pnpm data:hazard to populate them."
      />
    );
  }

  const vertices = frame.rings.reduce((n, r) => n + r.length, 0);
  const observedGap = lastObserved ? frame.t - lastObserved.t : null;

  return (
    <PanelBody>
      <PanelHeader
        kind={`Hazard frame · ${bundle.meta.hazardKind}`}
        id={formatTick(frame.t, false)}
        name={formatWallClock(bundle.meta.eventDate, frame.t, bundle.meta.startHourLocal)}
        icon={Flame}
        right={
          <Chip
            tone={frame.provenance === "observed" ? "plan" : "warn"}
            title={
              frame.provenance === "observed"
                ? "This perimeter is a published NIFC observation."
                : "This perimeter is interpolated between two published observations. Nothing measured this instant."
            }
          >
            {frame.provenance.toUpperCase()}
          </Chip>
        }
      />

      <Block label="Footprint">
        <Field label="Fire fronts" value={formatCount(frame.rings.length)} />
        <Field label="Perimeter vertices" value={formatCount(vertices)} />
        <Field
          label="Road segments closed"
          value={formatCount(frame.closedEdgeIds.length)}
          tone={frame.closedEdgeIds.length > 0 ? "hazard" : undefined}
          title="Edges this frame renders impassable. Every zone routed over one of them loses that segment."
        />
        <Field
          label="Hotspot detections"
          value={
            frame.hotspots && frame.hotspots.length > 0 ? formatCount(frame.hotspots.length) : null
          }
          title="Satellite thermal anomalies at this timestep, when the FIRMS pull returned any."
        />
        <Field
          label="Burnover horizon"
          value={formatTick(bundle.meta.burnoverAt, false)}
          title="When the hazard overruns the last occupied egress route. Authored per scenario."
        />
      </Block>

      <Block
        label="Wind"
        right={
          wind ? (
            <span className="readout text-[13px] text-foreground">{wind.speed.toFixed(1)} m/s</span>
          ) : undefined
        }
      >
        <Field
          label="From"
          value={wind ? `${compass(wind.direction)} · ${Math.round(wind.direction)}°` : null}
          title="Meteorological convention: the direction the wind comes FROM."
        />
        <Field label="Speed" value={wind ? wind.speed.toFixed(1) : null} unit="m/s" />
        <Field
          label="Gust"
          value={wind?.gust !== undefined ? wind.gust.toFixed(1) : null}
          unit="m/s"
        />
        <Field label="Sample at" value={wind ? formatTick(wind.t, false) : null} />
        {!wind ? (
          <p className="mt-1 text-[11px] leading-snug text-faint">
            No wind sample covers this tick.
          </p>
        ) : null}
      </Block>

      <Block label="Provenance of this instant">
        <Field
          label="Last observed perimeter"
          value={lastObserved ? formatTick(lastObserved.t, false) : null}
        />
        <Field
          label="Interpolated across"
          value={observedGap && observedGap > 0 ? formatShort(observedGap) : null}
          tone={observedGap !== null && observedGap > 3600 ? "warn" : undefined}
          title="How far this frame sits from the last real observation."
        />
        <Field label="Frames in track" value={formatCount(bundle.hazard.frames.length)} />
        <p className="mt-1.5 text-[11px] leading-snug text-faint">
          {frame.provenance === "observed"
            ? "This frame is a published perimeter, not a fill between two."
            : "The animation is smooth; the source is not. Between observations the perimeter is a defensible interpolation, and the arrival times derived from it inherit that."}
        </p>
      </Block>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Zone centroids inside footprint</SectionLabel>
          <span className="label-mono">{formatCount(inside.facilities)} facilities</span>
        </div>
        {inside.zones.length === 0 ? (
          <p className="text-[11px] leading-snug text-faint">
            No zone centroid is inside this frame. A zone can still be partly burning with its
            centroid outside — a centroid test is coarse, and this row says so rather than
            pretending to be an area calculation.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {inside.zones.slice(0, 8).map((z) => (
              <LinkRow
                key={z.id}
                kind="zone"
                id={z.id}
                center={z.centroid}
                primary={z.id}
                secondary={`${formatCount(z.households)} HH · ${z.primaryRouteLabel}`}
              />
            ))}
            {inside.zones.length > 8 ? (
              <span className="label-mono">+{formatCount(inside.zones.length - 8)} more</span>
            ) : null}
          </div>
        )}
      </div>

      <Sources
        lines={[
          {
            label: "Perimeter",
            value: bundle.hazard.source,
            kind: frame.provenance === "observed" ? "observed" : "interpolated",
          },
          {
            label: "Containment tests",
            value:
              "Zone centroids and facility points tested against this frame's rings in the browser, on selection.",
            kind: "derived",
          },
          {
            label: "Burnover horizon",
            value: `${formatTick(bundle.meta.burnoverAt, false)} is a per-scenario constant in src/lib/constants.ts, chosen against the event record — not a fetched figure.`,
            kind: "authored",
          },
        ]}
      />
    </PanelBody>
  );
}

/** Small header affordance the dock uses to hand the operator the hazard frame,
 *  which the map cannot: the perimeter fill is deliberately not pickable, since
 *  by late in a run it covers most of the map and would swallow every other
 *  hover and click on it. */
export const HAZARD_SELECTION_ID = "current";

"use client";

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CloudFog,
  Flame,
  History,
  Mountain,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react";
import { useMemo } from "react";
import { useContextBundle } from "@/components/map/context-layers";
import { useBundle } from "@/lib/bundle-context";
import { lastAtOrBefore } from "@/lib/derive";
import { formatCount, formatDistance, formatPercent, formatTick } from "@/lib/format";
import { selScenarioId, useEgress } from "@/lib/store";
import type { ContextBundle, ContextLayerEntry, ContextLayerId } from "@/types/context-layers";
import type { Tick } from "@/types/egress";
import { Block, Field, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Chip, EmptyHint } from "./queue-tab";

/**
 * Third-party observations about the world the evacuation happened in.
 *
 * These layers never move the solver. Every one of them is somebody else's
 * measurement, so this panel leads with the value, then the units, then who
 * published it and when — attribution is not a footnote here, it is the point.
 *
 * Selection ids are `<kind>:<featureKey>`, minted by pick-select.ts and
 * resolved back against the loaded context bundle here. Features whose upstream
 * gives no id (a slope cell, a smoke polygon) are keyed on something stable in
 * their own payload rather than on an array index, which a re-fetch could move.
 */

type ContextKind =
  | "air"
  | "detection"
  | "smoke"
  | "transmission"
  | "svi"
  | "advisory"
  | "burn"
  | "slope";

const LAYER_OF: Record<ContextKind, ContextLayerId> = {
  air: "airQuality",
  detection: "fireIntensity",
  smoke: "smoke",
  transmission: "transmission",
  svi: "socialVulnerability",
  advisory: "fireWeather",
  burn: "burnScars",
  slope: "slope",
};

const ICON_OF: Record<ContextKind, LucideIcon> = {
  air: Activity,
  detection: Flame,
  smoke: CloudFog,
  transmission: Zap,
  svi: Users,
  advisory: TriangleAlert,
  burn: History,
  slope: Mountain,
};

const KIND_LABEL: Record<ContextKind, string> = {
  air: "Air quality monitor",
  detection: "Satellite fire detection",
  smoke: "Smoke plume",
  transmission: "Transmission line",
  svi: "Social vulnerability tract",
  advisory: "Fire weather product",
  burn: "Historical burn scar",
  slope: "Terrain cell",
};

function isContextKind(v: string): v is ContextKind {
  return v in LAYER_OF;
}

/** SVI theme ranks are percentiles. A suppressed tract is null, never 0. */
function rank(v: number | null | undefined): string | null {
  if (v === null || v === undefined || v < 0) return null;
  return formatPercent(v, 0);
}

export function ContextPanel({ selectionId, t }: { selectionId: string; t: Tick }) {
  const scenarioId = useEgress(selScenarioId);
  const context = useContextBundle(scenarioId);
  const bundle = useBundle();

  const split = selectionId.indexOf(":");
  const kindRaw = split < 0 ? "" : selectionId.slice(0, split);
  const key = split < 0 ? "" : selectionId.slice(split + 1);
  const kind = isContextKind(kindRaw) ? kindRaw : null;

  const entry: ContextLayerEntry | null = useMemo(() => {
    if (!context || !kind) return null;
    return context.manifest.layers.find((l) => l.id === LAYER_OF[kind]) ?? null;
  }, [context, kind]);

  if (!kind) {
    return (
      <EmptyHint
        icon={Activity}
        title="Unrecognised context feature"
        hint={`"${selectionId}" is not a context selection this build knows how to resolve.`}
      />
    );
  }

  if (!context) {
    return (
      <EmptyHint
        icon={ICON_OF[kind]}
        title="No context layers loaded"
        hint="Context payloads live under public/data/<scenario>/context/. Run pnpm data:context to fetch them."
      />
    );
  }

  const body = renderFeature(kind, key, context, t);

  if (!body) {
    return (
      <EmptyHint
        icon={ICON_OF[kind]}
        title={`${KIND_LABEL[kind]} not found`}
        hint={`The layer is loaded but carries no feature keyed "${key}". The payload may have been refetched since this selection was made.`}
      />
    );
  }

  return (
    <PanelBody>
      <PanelHeader
        kind={KIND_LABEL[kind]}
        id={body.id}
        name={body.name}
        icon={ICON_OF[kind]}
        right={
          <Chip
            tone="neutral"
            title={
              entry?.provenance === "observed"
                ? "Measured by an instrument or published by the agency of record."
                : "Computed by us from a published input."
            }
          >
            {(entry?.provenance ?? "unknown").toUpperCase()}
          </Chip>
        }
      />

      {body.content}

      {entry ? (
        <Block label="Layer">
          <Field label="Records" value={formatCount(entry.recordCount)} />
          <Field label="Changes with time" value={entry.timeVarying ? "Yes" : "No"} />
          <Field label="Payload" value={entry.file ?? null} />
          <Field
            label="Size"
            value={entry.bytes > 0 ? formatCount(Math.round(entry.bytes / 1024)) : null}
            unit="KB"
          />
        </Block>
      ) : null}

      <Sources
        lines={[
          {
            label: entry?.label ?? KIND_LABEL[kind],
            value: entry
              ? `${entry.source} — ${entry.sourceUrl}`
              : "Layer not listed in the context manifest.",
            kind: entry?.provenance === "modelled" ? "modelled" : "observed",
          },
          {
            label: "Fetched",
            value: context.manifest.generatedAt,
            kind: "observed",
          },
          ...(bundle
            ? [
                {
                  label: "Scenario clock",
                  value: `T+0 is ${bundle.meta.eventDate} ${String(bundle.meta.startHourLocal ?? 6).padStart(2, "0")}:00 local. Every tick on this panel is measured from there.`,
                  kind: "authored" as const,
                },
              ]
            : []),
        ]}
        note={entry?.note}
      />
    </PanelBody>
  );
}

interface Rendered {
  id: string;
  name?: string;
  content: React.ReactNode;
}

function renderFeature(
  kind: ContextKind,
  key: string,
  context: ContextBundle,
  t: Tick,
): Rendered | null {
  switch (kind) {
    case "air": {
      const payload = context.airQuality;
      const idx = payload?.stations.findIndex((s) => s.id === key) ?? -1;
      const station = idx >= 0 ? payload?.stations[idx] : null;
      if (!payload || !station || idx < 0) return null;
      const frame =
        payload.frames.length > 0 ? payload.frames[lastAtOrBefore(payload.frames, t)] : null;
      const value = frame ? frame.values[idx] : null;
      return {
        id: station.id,
        name: station.name,
        content: (
          <>
            <Block
              label={`PM2.5 at playhead · ${payload.units}`}
              right={
                <span
                  className="readout text-[17px]"
                  style={{ color: value === null ? "var(--faint)" : "var(--foreground)" }}
                >
                  {value === null ? "—" : value.toFixed(1)}
                </span>
              }
            >
              <Field label="Reading at" value={frame ? formatTick(frame.t, false) : null} />
              <Field
                label="Peak in window"
                value={station.peak === null ? null : station.peak.toFixed(1)}
                unit={payload.units}
              />
              <Field
                label="Reporting"
                value={station.reporting ? "Yes" : "No"}
                tone={station.reporting ? undefined : "warn"}
              />
              <Field label="Agency" value={station.agency} />
              <Field label="From scenario centre" value={formatDistance(station.distanceM)} />
              <p className="mt-1.5 text-[11px] leading-snug text-faint">
                {station.reporting
                  ? "Hourly means, held between observations rather than interpolated — a value invented between two hourly means is not a reading any instrument produced."
                  : "This monitor published nothing across the whole window. A silent monitor inside a burn footprint is a finding, not a gap to smooth over."}
              </p>
            </Block>
          </>
        ),
      };
    }
    case "detection": {
      const payload = context.fireIntensity;
      const d = payload?.detections.find((x) => detectionKey(x.position, x.t) === key) ?? null;
      if (!payload || !d) return null;
      return {
        id: `${d.sensor} · ${formatTick(d.t, false)}`,
        name: d.acquiredUtc,
        content: (
          <Block
            label="Fire radiative power"
            right={
              <span className="readout text-[17px] text-foreground">{formatCount(d.frp)} MW</span>
            }
          >
            <Field label="Brightness" value={d.brightness.toFixed(1)} unit="K" />
            <Field label="Confidence" value={d.confidence} />
            <Field label="Sensor" value={d.sensor} />
            <Field label="Overpass" value={d.acquiredUtc} />
            <Field
              label="FRP range in payload"
              value={`${formatCount(payload.frpRange[0])}–${formatCount(payload.frpRange[1])}`}
              unit="MW"
            />
            <p className="mt-1.5 text-[11px] leading-snug text-faint">
              FRP is instantaneous at the overpass moment only. It says how hot this pixel was when
              the satellite looked, not how hot it stayed.
            </p>
          </Block>
        ),
      };
    }
    case "smoke": {
      const payload = context.smoke;
      const p = payload?.plumes.find((x) => `${x.density}:${x.startT}` === key) ?? null;
      if (!payload || !p) return null;
      const active = t >= p.startT && t <= p.endT;
      return {
        id: `${p.density} plume`,
        name: p.satellite,
        content: (
          <Block
            label="Analysis window"
            right={
              <Chip tone={active ? "warn" : "neutral"}>
                {active ? "IN FORCE" : "NOT AT PLAYHEAD"}
              </Chip>
            }
          >
            <Field label="Density" value={p.density} />
            <Field label="Starts" value={formatTick(p.startT, false)} />
            <Field label="Ends" value={formatTick(p.endT, false)} />
            <Field label="Satellite" value={p.satellite} />
            <Field label="Rings" value={formatCount(p.rings.length)} />
            <p className="mt-1.5 text-[11px] leading-snug text-faint">
              An analyst drew this polygon over one satellite pass. It is a qualitative density
              class, not a concentration, and it has no vertical extent.
            </p>
          </Block>
        ),
      };
    }
    case "transmission": {
      const payload = context.transmission;
      const line = payload?.lines.find((x) => x.id === key) ?? null;
      if (!payload || !line) return null;
      return {
        id: line.id,
        name: `${line.from} → ${line.to}`,
        content: (
          <Block
            label="Line"
            right={
              <span className="readout text-[15px] text-foreground">
                {line.voltageKv === null ? "—" : `${formatCount(line.voltageKv)} kV`}
              </span>
            }
          >
            <Field label="Owner" value={line.owner} />
            <Field label="Voltage class" value={line.voltClass} />
            <Field label="Status" value={line.status} />
            <Field label="From" value={line.from} />
            <Field label="To" value={line.to} />
            <Field label="Path points" value={formatCount(line.path.length)} />
            {line.voltageKv === null ? (
              <p className="mt-1.5 text-[11px] leading-snug text-faint">
                The upstream publishes no nominal voltage for this line. The em-dash is that gap —
                the source encodes it as a sentinel, and printing the sentinel as a number would be
                a fabricated reading.
              </p>
            ) : null}
          </Block>
        ),
      };
    }
    case "svi": {
      const payload = context.socialVulnerability;
      const tract = payload?.tracts.find((x) => x.geoid === key) ?? null;
      if (!payload || !tract) return null;
      return {
        id: tract.geoid,
        name: tract.name,
        content: (
          <>
            <Block
              label="Overall percentile rank"
              right={
                <span
                  className="readout text-[17px]"
                  style={{ color: tract.overall === null ? "var(--faint)" : "var(--foreground)" }}
                >
                  {rank(tract.overall) ?? "—"}
                </span>
              }
            >
              <Field label="Socioeconomic" value={rank(tract.socioeconomic)} />
              <Field label="Household composition" value={rank(tract.householdComposition)} />
              <Field label="Minority and language" value={rank(tract.minorityLanguage)} />
              <Field label="Housing and transport" value={rank(tract.housingTransport)} />
              <p className="mt-1.5 text-[11px] leading-snug text-faint">
                Percentile ranks against all US tracts, higher meaning more vulnerable. A suppressed
                theme shows an em-dash: the source encodes it as -999, and a suppressed tract is
                unknown, not invulnerable.
              </p>
            </Block>
            <Block label="Counts">
              <Field label="Population" value={formatCount(tract.population)} />
              <Field
                label="No-vehicle households"
                value={tract.noVehicle === null ? null : formatCount(tract.noVehicle)}
                tone={tract.noVehicle ? "warn" : undefined}
                title="Independent of the ACS layer this console plans against. Two sources counting the same thing."
              />
              <Field
                label="Tract join rate"
                value={formatPercent(payload.joinRate)}
                title="Tracts whose CSV row matched a geometry. A silent partial join is what this figure exists to expose."
              />
            </Block>
          </>
        ),
      };
    }
    case "advisory": {
      const payload = context.fireWeather;
      const all = payload ? [...payload.archive, ...payload.live] : [];
      const a = all.find((x) => x.id === key) ?? null;
      if (!payload || !a) return null;
      const inForce = t >= a.startT && t <= a.endT;
      return {
        id: a.event,
        name: `${a.office} · ${a.productId}`,
        content: (
          <Block
            label="Validity"
            right={
              <Chip tone={inForce ? "warn" : "neutral"}>
                {inForce ? "IN FORCE AT PLAYHEAD" : a.live ? "LIVE, OUTSIDE WINDOW" : "ARCHIVE"}
              </Chip>
            }
          >
            <Field label="Phenomena / significance" value={`${a.phenomena} · ${a.significance}`} />
            <Field label="Issued" value={a.issuedUtc} />
            <Field label="Expires" value={a.expiresUtc} />
            <Field
              label="Starts"
              value={formatTick(a.startT, false)}
              title="Negative is normal — a fire-weather warning precedes the fire."
            />
            <Field label="Ends" value={formatTick(a.endT, false)} />
            <Field label="UGC zones" value={formatCount(a.zones.length)} />
            <Field label="Drawable footprint" value={a.rings ? "Yes" : null} />
            {!a.rings ? (
              <p className="mt-1.5 text-[11px] leading-snug text-faint">
                No footprint. The UGC zones this product referenced have since been retired, and the
                weather API returns nothing for them. The advisory is real and timestamped; only its
                geometry is unavailable.
              </p>
            ) : null}
          </Block>
        ),
      };
    }
    case "burn": {
      const payload = context.burnScars;
      const scar = payload?.scars.find((x) => x.id === key) ?? null;
      if (!payload || !scar) return null;
      return {
        id: scar.name,
        name: `${scar.year}`,
        content: (
          <Block
            label="Previous fire"
            right={
              <span className="readout text-[15px] text-foreground">
                {formatCount(scar.acres)} ac
              </span>
            }
          >
            <Field label="Year" value={formatCount(scar.year)} />
            <Field label="Rings" value={formatCount(scar.rings.length)} />
            <Field
              label="Payload year range"
              value={`${formatCount(payload.yearRange[0])}–${formatCount(payload.yearRange[1])}`}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-faint">
              A previous burn changes available fuel, which changes how a new fire moves through the
              same ground. This layer is context for that judgement; the solver does not read it.
            </p>
          </Block>
        ),
      };
    }
    case "slope": {
      const payload = context.slope;
      const cell = payload?.cells.find((x) => cellKey(x.position) === key) ?? null;
      if (!payload || !cell) return null;
      return {
        id: `${cell.position[1].toFixed(4)}, ${cell.position[0].toFixed(4)}`,
        content: (
          <Block
            label="Terrain"
            right={
              <span className="readout text-[17px] text-foreground">{cell.slope.toFixed(1)}°</span>
            }
          >
            <Field label="Elevation" value={formatCount(cell.elevation)} unit="m" />
            <Field
              label="Aspect"
              value={`${Math.round(cell.aspect)}°`}
              title="Downslope azimuth, clockwise from north."
            />
            <Field
              label="Slope spread factor"
              value={cell.spreadFactor.toFixed(2)}
              unit="x"
              title="Rothermel: how much faster a head fire runs upslope here than on the flat, all else equal."
            />
            <Field label="Steepest cell in grid" value={payload.maxSlope.toFixed(1)} unit="°" />
            <Field
              label="Grid"
              value={`${formatCount(payload.cols)} x ${formatCount(payload.rows)}`}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-faint">
              Elevation is measured; slope, aspect and the spread factor are computed from it. The
              spread factor is a rule of thumb about fire behaviour, not a prediction of this fire.
            </p>
          </Block>
        ),
      };
    }
    default:
      return null;
  }
}

/** Keys minted here and in pick-select.ts must agree exactly. Both live in
 *  this module's world, so the mint is exported rather than duplicated. */
export function detectionKey(position: [number, number], t: Tick): string {
  return `${position[0]},${position[1]},${t}`;
}

export function cellKey(position: [number, number]): string {
  return `${position[0]},${position[1]}`;
}

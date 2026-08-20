"use client";

import { Flame, Home, Squircle } from "lucide-react";
import { useMemo } from "react";
import { useDetailState } from "@/components/map/detail-layers";
import { useBundle } from "@/lib/bundle-context";
import { formatCount, formatShort, formatTick } from "@/lib/format";
import { selScenarioId, useEgress } from "@/lib/store";
import type { FootprintSource, StructureDamage, StructurePresence } from "@/types/detail-layers";
import type { Tick } from "@/types/egress";
import { Alarm, Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Chip, EmptyHint, SectionLabel } from "./queue-tab";

const DAMAGE_LABEL: Record<StructureDamage, string> = {
  destroyed: "Destroyed",
  major: "Major damage",
  minor: "Minor damage",
  affected: "Affected",
  none: "No damage",
  inaccessible: "Inaccessible to inspector",
};

const PRESENCE_NOTE: Record<StructurePresence, string> = {
  inspected:
    "A damage inspector stood at this address after the event, so the structure demonstrably existed at T+0.",
  imagery:
    "Something is standing here in post-event imagery. It may be a rebuild — this layer cannot tell you it was here at T+0.",
};

const FOOTPRINT_NOTE: Record<FootprintSource, string> = {
  imagery: "Real machine-learned outline traced from satellite imagery.",
  "derived-from-point":
    "Not a real outline. A square of median local footprint area, drawn around an inspection point because the structure no longer exists to trace.",
};

function useDetail() {
  const scenarioId = useEgress(selScenarioId);
  return useDetailState(scenarioId);
}

/** One decennial census block — the finest population count in the console. */
export function BlockPanel({ blockId, t }: { blockId: string; t: Tick }) {
  const bundle = useBundle();
  const { detail } = useDetail();
  const payload = detail?.blocks ?? null;

  const block = useMemo(
    () => payload?.blocks.find((b) => b.id === blockId) ?? null,
    [payload, blockId],
  );

  const zone = useMemo(
    () => (bundle && block?.z ? (bundle.zones.zones.find((z) => z.id === block.z) ?? null) : null),
    [bundle, block],
  );

  if (!payload || !block) {
    return (
      <EmptyHint
        icon={Squircle}
        title="Block not loaded"
        hint={
          payload
            ? `${blockId} is not in blocks.json for this scenario.`
            : "The block layer loads when the map zooms past its gate. Zoom in, or run pnpm data:blocks."
        }
      />
    );
  }

  const reached = block.h !== null && block.h <= t;

  return (
    <PanelBody>
      <PanelHeader
        kind={`Census block · ${formatCount(payload.vintage)}`}
        id={block.id}
        name={`${formatCount(block.pop)} people · ${formatCount(block.hu)} housing units`}
        icon={Squircle}
      />

      {reached ? (
        <Alarm icon={Flame}>
          Inside the hazard footprint since {formatTick(block.h as Tick, false)}.
        </Alarm>
      ) : null}

      <Block label="Counts">
        <Field
          label="Population"
          value={formatCount(block.pop)}
          title="Decennial P1 total population. A count, not a survey estimate — no margin of error."
        />
        <Field label="Housing units" value={formatCount(block.hu)} />
        <Field
          label="Hazard arrival"
          value={block.h === null ? null : formatTick(block.h, false)}
          tone={reached ? "hazard" : undefined}
        />
        <Field
          label="Margin at playhead"
          value={block.h === null || reached ? null : formatShort(block.h - t)}
        />
      </Block>

      {block.pop === 0 ? (
        <p className="text-[11px] leading-snug text-faint">
          A zero here is a real decennial count of nobody living in this block, not missing data.
        </p>
      ) : null}

      <div>
        <SectionLabel>Evacuation zone</SectionLabel>
        {zone ? (
          <LinkRow
            kind="zone"
            id={zone.id}
            center={zone.centroid}
            primary={zone.id}
            secondary={`${formatCount(zone.households)} HH · ${zone.primaryRouteLabel}`}
          />
        ) : (
          <p className="text-[11px] leading-snug text-faint">
            This block falls outside every evacuation zone polygon.
          </p>
        )}
      </div>

      <Sources
        lines={[
          { label: "Counts and geometry", value: payload.source, kind: "observed" },
          {
            label: "Vintage",
            value: `${formatCount(payload.vintage)} decennial census — the last one before the event. A later vintage would count a town that had already burned.`,
            kind: "authored",
          },
          {
            label: "Hazard arrival",
            value: "Block centroid tested against the hazard perimeter frames in the pipeline.",
            kind: "modelled",
          },
        ]}
        note={payload.note}
      />
    </PanelBody>
  );
}

/** One structure. The point of this panel is what we can and cannot claim
 *  about it existing on the morning of the event. */
export function BuildingPanel({ buildingKey, t }: { buildingKey: string; t: Tick }) {
  const bundle = useBundle();
  const { detail } = useDetail();
  const payload = detail?.buildings ?? null;

  const building = useMemo(
    () => payload?.buildings.find((b) => `${b.c[0]},${b.c[1]}` === buildingKey) ?? null,
    [payload, buildingKey],
  );

  const zone = useMemo(
    () =>
      bundle && building?.z ? (bundle.zones.zones.find((z) => z.id === building.z) ?? null) : null,
    [bundle, building],
  );

  if (!payload || !building) {
    return (
      <EmptyHint
        icon={Home}
        title="Structure not loaded"
        hint={
          payload
            ? "That structure is not in buildings.json for this scenario."
            : "The structure layer loads when the map zooms past its gate. Zoom in, or run pnpm data:buildings."
        }
      />
    );
  }

  const reached = building.h !== null && building.h <= t;

  return (
    <PanelBody>
      <PanelHeader
        kind="Structure"
        id={`${building.c[1].toFixed(5)}, ${building.c[0].toFixed(5)}`}
        name={building.s ?? undefined}
        icon={Home}
        right={
          <Chip tone={building.p === "inspected" ? "plan" : "neutral"}>
            {building.p === "inspected" ? "INSPECTED" : "IMAGERY ONLY"}
          </Chip>
        }
      />

      {reached ? (
        <Alarm icon={Flame}>
          Inside the hazard footprint from {formatTick(building.h as Tick, false)}.
        </Alarm>
      ) : null}

      <Block label="Record">
        <Field
          label="Outcome"
          value={building.d ? DAMAGE_LABEL[building.d] : null}
          tone={building.d === "destroyed" ? "hazard" : undefined}
          title="CAL FIRE damage inspection result. Absent when no inspector reached this structure."
        />
        <Field label="Class" value={building.s ?? null} />
        <Field label="Footprint area" value={formatCount(building.a)} unit="m²" />
        <Field
          label="Hazard arrival"
          value={building.h === null ? null : formatTick(building.h, false)}
          tone={reached ? "hazard" : undefined}
        />
        <Field
          label="Margin at playhead"
          value={building.h === null || reached ? null : formatShort(building.h - t)}
        />
      </Block>

      <Block label="What this outline is">
        <p className="text-[11px] leading-snug text-subtle">{FOOTPRINT_NOTE[building.f]}</p>
        <p className="mt-1.5 border-t border-hairline pt-1.5 text-[11px] leading-snug text-subtle">
          {PRESENCE_NOTE[building.p]}
        </p>
      </Block>

      <div>
        <SectionLabel>Evacuation zone</SectionLabel>
        {zone ? (
          <LinkRow
            kind="zone"
            id={zone.id}
            center={zone.centroid}
            primary={zone.id}
            secondary={`${formatCount(zone.households)} HH · ${zone.primaryRouteLabel}`}
          />
        ) : (
          <p className="text-[11px] leading-snug text-faint">
            This structure falls outside every evacuation zone polygon.
          </p>
        )}
      </div>

      <Sources
        lines={[
          ...payload.sources.map((s) => ({
            label: s.role,
            value: `${s.name} · ${formatCount(s.count)} records · ${s.url}`,
            kind: "observed" as const,
          })),
          {
            label: "Imagery vintage",
            value: `${payload.imageryVintage}. The imagery behind the footprints is older still, and for a scenario replaying a past event this is the number that matters.`,
            kind: "observed",
          },
        ]}
        note={payload.note}
      />
    </PanelBody>
  );
}

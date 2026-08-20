"use client";

import { Grid2x2, Users } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { pointInRings } from "@/lib/derive";
import { formatCount, formatPercent } from "@/lib/format";
import { Block, Field, LinkRow, PanelBody, PanelHeader, Sources } from "./panel-kit";
import { Chip, EmptyHint, SectionLabel } from "./queue-tab";

/** ACS language codes seen in this region. An unknown code prints raw — never
 *  invent a language for a code we do not recognise. */
const LANGUAGE_NAME: Record<string, string> = {
  en: "English",
  es: "Spanish",
  tl: "Tagalog",
  zh: "Chinese",
  vi: "Vietnamese",
  hmn: "Hmong",
  pa: "Punjabi",
  ko: "Korean",
  ru: "Russian",
  ar: "Arabic",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  hi: "Hindi",
  fa: "Persian",
  ur: "Urdu",
  th: "Thai",
  lo: "Lao",
  km: "Khmer",
};

function share(part: number, whole: number): string | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return formatPercent(part / whole);
}

/** One ACS block group — the unit every demographic figure in this console is
 *  actually measured on, before anything apportions it to a zone. */
export function CellPanel({ cellId }: { cellId: string }) {
  const bundle = useBundle();

  const cell = useMemo(
    () => bundle?.population.cells.find((c) => c.id === cellId) ?? null,
    [bundle, cellId],
  );

  const zones = useMemo(() => {
    if (!bundle || !cell) return [];
    // Two links, and they can disagree: the zone builder lists block groups it
    // claimed, while the centroid test says where this polygon's middle falls.
    const listed = bundle.zones.zones.filter((z) => z.blockGroupIds.includes(cell.id));
    if (listed.length > 0) return listed;
    const containing = bundle.zones.zones.find((z) => pointInRings(cell.centroid, z.geometry));
    return containing ? [containing] : [];
  }, [bundle, cell]);

  if (!bundle || !cell) {
    return (
      <EmptyHint
        icon={Users}
        title="Block group not in this scenario"
        hint={`${cellId} is not present in population.json. Rebuild with pnpm data:population if the bounding box changed.`}
      />
    );
  }

  const perHousehold = cell.households > 0 ? cell.vehiclesAvailable / cell.households : null;

  return (
    <PanelBody>
      <PanelHeader
        kind="ACS block group"
        id={cell.id}
        name={`${formatCount(cell.population)} people · ${formatCount(cell.households)} households`}
        icon={Grid2x2}
      />

      <Block
        label="Transit dependence"
        right={
          <span
            className="readout text-[13px]"
            style={{ color: cell.noVehicleHouseholds > 0 ? "var(--warn)" : "var(--faint)" }}
          >
            {formatCount(cell.noVehicleHouseholds)}
          </span>
        }
      >
        <Field
          label="No-vehicle HH"
          value={`${formatCount(cell.noVehicleHouseholds)}${
            share(cell.noVehicleHouseholds, cell.households)
              ? ` · ${share(cell.noVehicleHouseholds, cell.households)}`
              : ""
          }`}
          tone={cell.noVehicleHouseholds > 0 ? "warn" : undefined}
          title="Households reporting zero vehicles available. A route plan alone does not reach them."
        />
        <Field label="Vehicles available" value={formatCount(cell.vehiclesAvailable)} />
        <Field
          label="Vehicles per HH"
          value={perHousehold === null ? null : perHousehold.toFixed(2)}
        />
        {cell.noVehicleHouseholds === 0 ? (
          <p className="mt-1 text-[11px] leading-snug text-faint">
            The survey reports no zero-vehicle households here. That is a measured zero with a
            margin of error around it, not a guarantee that everyone can drive.
          </p>
        ) : null}
      </Block>

      <Block label="Who is here">
        <Field
          label="Population"
          value={formatCount(cell.population)}
          title="ACS B01003 total population."
        />
        <Field
          label="Age 65+"
          value={`${formatCount(cell.age65Plus)}${share(cell.age65Plus, cell.population) ? ` · ${share(cell.age65Plus, cell.population)}` : ""}`}
        />
        <Field
          label="With disability"
          value={`${formatCount(cell.withDisability)}${share(cell.withDisability, cell.population) ? ` · ${share(cell.withDisability, cell.population)}` : ""}`}
          title="Tract-level estimate apportioned by this block group's share of tract population."
        />
        <Field
          label="Limited-English HH"
          value={`${formatCount(cell.limitedEnglishHouseholds)}${
            share(cell.limitedEnglishHouseholds, cell.households)
              ? ` · ${share(cell.limitedEnglishHouseholds, cell.households)}`
              : ""
          }`}
          title="Households where no adult speaks English very well. Drives which languages the alert has to carry."
        />
        <Field
          label="Mobile homes"
          value={`${formatCount(cell.mobileHomes)}${share(cell.mobileHomes, cell.households) ? ` · ${share(cell.mobileHomes, cell.households)}` : ""}`}
        />
      </Block>

      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>Languages present</SectionLabel>
        {cell.languages.length === 0 ? (
          <p className="text-[11px] leading-snug text-faint">
            No language detail for this block group.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {cell.languages.map((l) => (
              <Chip key={l} tone="plan" title={LANGUAGE_NAME[l] ?? l}>
                {l.toUpperCase()}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionLabel>Evacuation zone</SectionLabel>
        {zones.length === 0 ? (
          <p className="text-[11px] leading-snug text-faint">
            No zone claims this block group. Its population is counted in the scenario totals but is
            not in any release wave.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {zones.map((z) => (
              <LinkRow
                key={z.id}
                kind="zone"
                id={z.id}
                center={z.centroid}
                primary={z.id}
                secondary={`${formatCount(z.households)} HH · ${z.primaryRouteLabel}`}
              />
            ))}
          </div>
        )}
      </div>

      <Sources
        lines={[{ label: "Estimates", value: bundle.population.source, kind: "observed" }]}
        note="ACS figures are five-year survey estimates with margins of error, deliberately taken from the vintage before the event. They are not a roster of who was home. Door-knock lists must come from the county."
      />
    </PanelBody>
  );
}

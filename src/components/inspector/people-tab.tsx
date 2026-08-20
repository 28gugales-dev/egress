"use client";

import { Users } from "lucide-react";
import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { formatCount, formatPercent } from "@/lib/format";
import { selSelection, useEgress } from "@/lib/store";
import { Chip, EmptyHint, SectionLabel, StatRow } from "./queue-tab";

/** ISO 639-1 (plus `hmn`) names for the codes ACS reports in this region.
 *  Unknown codes fall through to the raw code — never invent a language. */
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

function share(part: number, whole: number): string {
  if (!Number.isFinite(whole) || whole <= 0) return "—";
  return formatPercent(part / whole);
}

export function PeopleTab() {
  const bundle = useBundle();
  const selection = useEgress(selSelection);

  const zoneId = selection.kind === "zone" ? selection.id : null;
  const zone = useMemo(
    () => (zoneId ? (bundle?.zones.zones.find((z) => z.id === zoneId) ?? null) : null),
    [bundle, zoneId],
  );

  const acs = useMemo(() => {
    if (!bundle || !zone) return null;
    const ids = new Set(zone.blockGroupIds);
    const cells = bundle.population.cells.filter((c) => ids.has(c.id));
    if (cells.length === 0)
      return {
        cells: 0,
        age65Plus: 0,
        withDisability: 0,
        limitedEnglishHouseholds: 0,
        languages: [] as string[],
      };
    const languages: string[] = [];
    let age65Plus = 0;
    let withDisability = 0;
    let limitedEnglishHouseholds = 0;
    for (const c of cells) {
      age65Plus += c.age65Plus;
      withDisability += c.withDisability;
      limitedEnglishHouseholds += c.limitedEnglishHouseholds;
      for (const l of c.languages) if (!languages.includes(l)) languages.push(l);
    }
    return { cells: cells.length, age65Plus, withDisability, limitedEnglishHouseholds, languages };
  }, [bundle, zone]);

  if (!zone || !acs) {
    return (
      <EmptyHint
        icon={Users}
        title="No zone selected"
        hint="Pick a zone to see who is inside it — no-vehicle households, older residents, disability, language, and mobile homes."
      />
    );
  }

  const official = zone.officialStructures;
  // Present-but-zero is real in this dataset, so the check is on null, never
  // on truthiness: the disagreement is the point of this panel.
  const hasOfficial = official != null;
  const delta = hasOfficial ? zone.households - official : 0;

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
      <div className="min-w-0">
        <div className="readout text-[13px] text-foreground">{zone.id}</div>
        <div className="truncate text-[11px] text-subtle" title={zone.label}>
          {zone.label}
        </div>
      </div>

      {/* Two counts of the same place, from two independent sources. Showing the
          gap is more persuasive than picking one and sounding certain. */}
      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>Household count · cross-check</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="readout text-[18px] text-foreground">
              {formatCount(zone.households)}
            </div>
            <div className="label-mono leading-tight">ACS households</div>
            <div className="label-mono leading-tight">2013–2017 est.</div>
          </div>
          <div>
            <div className="readout text-[18px] text-foreground">
              {hasOfficial ? formatCount(official) : "—"}
            </div>
            <div className="label-mono leading-tight">County structures</div>
            <div className="label-mono leading-tight">
              {hasOfficial ? "official layer" : "not published"}
            </div>
          </div>
        </div>
        <p className="mt-2 border-t border-hairline pt-1.5 text-[11px] leading-snug text-faint">
          {hasOfficial
            ? `These disagree by ${formatCount(Math.abs(delta))}. They count different things — occupied households versus mapped structures — and neither is a roster. Plan against the larger figure.`
            : "No official structure count is published for this zone, so the ACS estimate stands alone."}
        </p>
      </div>

      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>Population {formatCount(zone.population)}</SectionLabel>
        <StatRow
          label="No-vehicle HH"
          value={`${formatCount(zone.noVehicleHouseholds)} · ${share(zone.noVehicleHouseholds, zone.households)}`}
          tone="warn"
          title="Households reporting zero vehicles available — the people a route plan alone does not reach."
        />
        <StatRow
          label="Age 65+"
          value={`${formatCount(acs.age65Plus)} · ${share(acs.age65Plus, zone.population)}`}
        />
        <StatRow
          label="With disability"
          value={`${formatCount(acs.withDisability)} · ${share(acs.withDisability, zone.population)}`}
        />
        <StatRow
          label="Limited-English HH"
          value={`${formatCount(acs.limitedEnglishHouseholds)} · ${share(acs.limitedEnglishHouseholds, zone.households)}`}
        />
        <StatRow
          label="Mobile homes"
          value={`${formatCount(zone.mobileHomes)} · ${share(zone.mobileHomes, zone.households)}`}
        />
      </div>

      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>Languages present</SectionLabel>
        {acs.languages.length === 0 ? (
          <p className="text-[11px] leading-snug text-faint">
            No language detail for this zone. Alert copy defaults to English and Spanish.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {acs.languages.map((l) => (
              <Chip key={l} tone="plan" title={LANGUAGE_NAME[l] ?? l}>
                {l.toUpperCase()}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10.5px] leading-snug text-faint">
        {acs.cells === 0
          ? "No ACS block group falls inside this zone, so the demographic rows above are zero rather than measured. "
          : `Derived from ${formatCount(acs.cells)} ACS block ${acs.cells === 1 ? "group" : "groups"}, 2013–2017 — the deliberate pre-fire vintage. `}
        These are survey estimates with margins of error, not a roster of who is home. Door-knock
        lists must come from the county.
      </p>
    </div>
  );
}

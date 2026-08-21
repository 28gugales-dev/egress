"use client";

import { Siren } from "lucide-react";
import { useMemo } from "react";
import { Chip, SectionLabel, StatRow } from "@/components/inspector/queue-tab";
import { useBundle } from "@/lib/bundle-context";
import { formatCount } from "@/lib/format";
import { selView, useEgress } from "@/lib/store";

/**
 * Police and response assets — the screen that says what is NOT here.
 *
 * The rail's other four entries render a payload. This one renders the absence
 * of one, on purpose and in full, because the alternative was a screen of
 * plausible patrol units that no source ever published. CLAUDE.md's first
 * non-negotiable is that a number nobody can trace is worse than a missing
 * number, and an evacuation console that invents a police roster has spent the
 * only thing it has.
 *
 * So the entry exists — an operator looking for police info finds the answer
 * rather than wondering whether they missed a tab — and the answer is the three
 * facts in order: what is missing, what a real fetch would take, and the one
 * response inventory that IS observed, so the reader can see the difference
 * between the two kinds of statement on one screen.
 *
 * Everything factual below is read live. The engine and ambulance counts come
 * from `facilities.json` at render time, the closure count from `hazard.json`,
 * the dispatched ambulances from the plan. Nothing is hard-coded, so a scenario
 * that DOES carry police stations will show them the moment one is fetched.
 *
 * The full specification of what police dispatch would model — staging, routing
 * to a closure point rather than to a facility, and the provenance rules that
 * would have to hold first — is in scripts/dispatch-response-assets.ts, which
 * is a proposal no loader reads.
 */

export function PolicePane() {
  const bundle = useBundle();
  const view = useEgress(selView);

  const inventory = useMemo(() => {
    const facilities = bundle?.facilities.facilities ?? [];
    let engines = 0;
    let stationsWithEngines = 0;
    let parkedAmbulances = 0;
    const kinds = new Set<string>();
    const sources = new Set<string>();
    for (const f of facilities) {
      kinds.add(f.kind);
      const e = f.assets?.engine ?? 0;
      if (e > 0) {
        engines += e;
        stationsWithEngines += 1;
        if (f.source) sources.add(f.source);
      }
      parkedAmbulances += f.assets?.ambulance ?? 0;
    }
    return {
      engines,
      stationsWithEngines,
      parkedAmbulances,
      kinds: kinds.size,
      facilities: facilities.length,
      sources: [...sources],
    };
  }, [bundle]);

  /* Every segment the hazard renders impassable across the whole replay. This
     is the work a patrol unit would be dispatched to: an unstaffed closure is
     a cone, and drivers route around a cone. */
  const closures = useMemo(() => Object.keys(bundle?.hazard.closedFrom ?? {}).length, [bundle]);

  const run = (view === "baseline" ? bundle?.baseline : bundle?.planned) ?? null;
  const dispatchedAmbulances = useMemo(
    () => (run?.plan.manifests ?? []).filter((m) => m.kind === "ambulance").length,
    [run],
  );

  return (
    <div className="thin-scroll flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 py-2.5">
      <div className="glass-inset px-2.5 py-2">
        <div className="flex items-center gap-2 pb-1">
          <Siren size={14} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
          <span className="text-[12px] font-medium text-foreground">
            No police roster in this scenario
          </span>
          <span className="ml-auto shrink-0">
            <Chip tone="warn">NO SOURCE</Chip>
          </span>
        </div>
        <p className="text-[11.5px] leading-snug text-subtle">
          No payload this console loads carries a police station, a patrol unit or a staffed
          closure. The gap starts in the contract: <span className="readout">FacilityKind</span> has
          no police member, so there is nowhere for one to land even if it were fetched. This
          scenario loads {formatCount(inventory.facilities)} facilities across{" "}
          {formatCount(inventory.kinds)} kinds, and none of them is a law-enforcement site. The
          screen is empty because the data is, and nothing is generated to fill it.
        </p>
      </div>

      <div className="glass-inset px-2.5 py-2">
        <SectionLabel>What patrol units would be dispatched to</SectionLabel>
        <StatRow
          label="Segments closed in replay"
          value={formatCount(closures)}
          title="Road segments the hazard renders impassable at some point in this replay, from hazard.json."
        />
        <StatRow label="Closures staffed" value="—" title="No roster, so none of them." />
        <p className="pt-1.5 text-[11px] leading-snug text-faint">
          Every closure above is an assertion that nobody drives that road. Unstaffed, it is a cone.
          Staffing is the difference between a modelled closure and an enforced one, and the plan
          cannot say which it means today.
        </p>
      </div>

      <div className="glass-inset px-2.5 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Response inventory that is observed</SectionLabel>
          <Chip tone="ok">SOURCED</Chip>
        </div>
        <StatRow
          label="Fire engines"
          value={formatCount(inventory.engines)}
          title="Read from facilities.json Facility.assets.engine. Parked station inventory — no engine is routed by this model."
        />
        <StatRow
          label="Stations carrying them"
          value={formatCount(inventory.stationsWithEngines)}
        />
        <StatRow
          label="Ambulances at stations"
          value={formatCount(inventory.parkedAmbulances)}
          title="Station inventory, not the dispatched fleet."
        />
        <StatRow
          label="Ambulances dispatched"
          value={formatCount(dispatchedAmbulances)}
          title="Vehicle manifests of kind 'ambulance' in the run you are looking at. These do move."
        />
        <p className="pt-1.5 text-[11px] leading-snug text-faint">
          Engines are drawn on the map as parked inventory because that is what the data supports.
          They are not routed: an engine drives INTO the closure while the public drives out, and
          that head-on conflict is a capacity cost this model does not charge itself for yet.
        </p>
        {inventory.sources.length > 0 ? (
          <p className="label-mono pt-1.5">Source · {inventory.sources.join(" · ")}</p>
        ) : null}
      </div>

      <div className="glass-inset px-2.5 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Rotary-wing</SectionLabel>
          <Chip tone="warn">NO SOURCE</Chip>
        </div>
        <p className="text-[11px] leading-snug text-faint">
          No helipad or air-ambulance record exists in any payload either. Aviation is also the one
          asset class that would not use the road graph at all, so it is a separate routing mode
          rather than a second icon on the same one.
        </p>
      </div>

      <p className="text-[10.5px] leading-snug text-faint">
        The fleet table, mission model and provenance rules that would have to hold before any of
        this reached the map are specified in{" "}
        <span className="readout">scripts/dispatch-response-assets.ts</span> — a proposal no loader
        in src/lib/data.ts reads. The missing sources are Overpass{" "}
        <span className="readout">amenity=police</span> and the HIFLD Local Law Enforcement
        Locations layer, on the same keyless hosts fetch-facilities.ts already uses.
      </p>
    </div>
  );
}

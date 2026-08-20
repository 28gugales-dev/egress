"use client";

import { Search, X } from "lucide-react";
import type { CSSProperties } from "react";
import { FACILITY_LABEL, ZONE_STATUS_LABEL, ZONE_STATUS_VAR } from "@/lib/constants";
import { cx, URGENCY_LABEL } from "@/lib/format";
import { actions, selFilters, selLayers, useEgress } from "@/lib/store";
import type { FacilityKind, MapFilters, Tick, ZoneStatus } from "@/types/egress";

const STATUSES: ZoneStatus[] = ["held", "ordered", "flowing", "cleared", "cutoff"];
const KINDS = Object.keys(FACILITY_LABEL) as FacilityKind[];
const URGENCIES: MapFilters["minUrgency"][] = [0, 1, 2, 3];
const ETAS: { label: string; value: Tick | null }[] = [
  { label: "Any", value: null },
  { label: "30m", value: 1800 },
  { label: "1h", value: 3600 },
  { label: "2h", value: 7200 },
];

const MAX_NO_VEHICLE = 200;

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Chip({
  on,
  label,
  color = "var(--plan)",
  onClick,
}: {
  on: boolean;
  label: string;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "rounded-xs border px-1.5 py-[2px] text-[10px] font-medium transition-colors",
        !on && "border-hairline bg-glass-inset text-faint hover:bg-glass-hover hover:text-subtle",
      )}
      style={on ? { color, borderColor: color, background: "var(--glass-active)" } : undefined}
    >
      {label}
    </button>
  );
}

/**
 * Turning the last kind off is a request to see no facilities at all, which the
 * filter array cannot express — empty already means "all". So the last one out
 * turns the facilities LAYER off, and the first click back on turns it on again
 * with just that kind. One control, and no state it cannot represent.
 */
function setFacilityKind(k: FacilityKind, layerOn: boolean, shown: FacilityKind[]): void {
  if (!layerOn) {
    actions.setLayer("facilities", true);
    actions.setFilter("facilityKinds", [k]);
    return;
  }
  const next = toggle(shown, k);
  if (next.length === 0) {
    actions.setLayer("facilities", false);
    actions.setFilter("facilityKinds", []);
    return;
  }
  // Canonicalise: every kind selected IS the unfiltered state, and storing it
  // as such keeps the active-filter count in the rail header honest.
  actions.setFilter("facilityKinds", next.length === KINDS.length ? [] : next);
}

export function FiltersSection() {
  const f = useEgress(selFilters);
  const facilitiesOn = useEgress(selLayers).facilities;
  const shownKinds = f.facilityKinds.length === 0 ? KINDS : f.facilityKinds;
  const active =
    (f.query.trim() ? 1 : 0) +
    (f.minUrgency > 0 ? 1 : 0) +
    (f.statuses.length ? 1 : 0) +
    (f.minNoVehicle > 0 ? 1 : 0) +
    (f.maxHazardEta !== null ? 1 : 0) +
    (f.facilityKinds.length ? 1 : 0);

  return (
    <section className="px-3 pt-[18px] pb-1">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="label-mono">Filters</span>
          {active > 0 ? (
            <span className="readout rounded-xs bg-plan-dim px-1 text-[9.5px] text-plan-text">
              {active}
            </span>
          ) : null}
        </div>
        {active > 0 ? (
          <button
            type="button"
            onClick={actions.resetFilters}
            className="flex items-center gap-1 rounded-xs px-1 py-0.5 text-[10px] text-faint transition-colors hover:bg-glass-hover hover:text-subtle"
          >
            <X size={13} strokeWidth={1.75} />
            Clear
          </button>
        ) : null}
      </div>

      <div className="glass-inset relative mb-2.5 flex items-center">
        <Search size={13} strokeWidth={1.75} className="ml-2 flex-none text-faint" />
        <input
          value={f.query}
          onChange={(e) => actions.setFilter("query", e.target.value)}
          placeholder="Zone or road"
          aria-label="Search zones and roads"
          className="w-full bg-transparent px-1.5 py-1.5 text-[11.5px] text-foreground outline-none placeholder:text-faint"
        />
      </div>

      <div className="label-mono mb-1">Min urgency</div>
      <div className="seg mb-2.5">
        {URGENCIES.map((u) => (
          <button
            key={u}
            type="button"
            data-on={f.minUrgency === u}
            onClick={() => actions.setFilter("minUrgency", u)}
          >
            {u === 0 ? "All" : URGENCY_LABEL[u]}
          </button>
        ))}
      </div>

      <div className="label-mono mb-1">Status</div>
      <div className="mb-2.5 flex flex-wrap gap-1">
        {STATUSES.map((s) => (
          <Chip
            key={s}
            on={f.statuses.includes(s)}
            label={ZONE_STATUS_LABEL[s]}
            color={ZONE_STATUS_VAR[s]}
            onClick={() => actions.setFilter("statuses", toggle(f.statuses, s))}
          />
        ))}
      </div>

      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="label-mono">Min no-vehicle hh</span>
        <span className="readout text-[11px] text-foreground">
          {f.minNoVehicle}
          {f.minNoVehicle === MAX_NO_VEHICLE ? "+" : ""}
        </span>
      </div>
      <input
        type="range"
        className="rng mb-2.5"
        min={0}
        max={MAX_NO_VEHICLE}
        step={5}
        value={f.minNoVehicle}
        aria-label="Minimum no-vehicle households"
        onChange={(e) => actions.setFilter("minNoVehicle", Number(e.target.value))}
        style={{ "--pct": `${(f.minNoVehicle / MAX_NO_VEHICLE) * 100}%` } as CSSProperties}
      />

      <div className="label-mono mb-1">Hazard ETA under</div>
      <div className="seg mb-2.5">
        {ETAS.map((e) => (
          <button
            key={e.label}
            type="button"
            data-on={f.maxHazardEta === e.value}
            onClick={() => actions.setFilter("maxHazardEta", e.value)}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="label-mono mb-1">Facilities</div>
      {/* An empty facilityKinds means SHOW ALL downstream, so chips drawn from
          the raw array read as nine dark, unselected buttons over a map that is
          already showing all nine kinds. Every click then either did nothing
          visible (adding the ninth kind back) or hid eight kinds at once with
          no warning, and the control read as broken. Chips reflect what is on
          the map instead: all-lit when nothing is filtered, and a click turns
          one OFF. */}
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <Chip
            key={k}
            on={facilitiesOn && shownKinds.includes(k)}
            label={FACILITY_LABEL[k]}
            onClick={() => setFacilityKind(k, facilitiesOn, shownKinds)}
          />
        ))}
      </div>
    </section>
  );
}

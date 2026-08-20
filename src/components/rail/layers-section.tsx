"use client";

import { CONGESTION_RAMP, HAZARD_RGB, PLAN_RGB, WARN_RGB, ZONE_STATUS_RGB } from "@/lib/constants";
import { actions, selLayers, useEgress } from "@/lib/store";
import type { LayerVisibility } from "@/types/egress";

type Rgb = [number, number, number];

const rgb = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/** Ramps and categorical sets get a banded swatch — a single chip would lie
 *  about what the layer actually encodes on the map. */
const bands = (cs: Rgb[]) => {
  const step = 100 / cs.length;
  const stops = cs.map((c, i) => `${rgb(c)} ${i * step}% ${(i + 1) * step}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
};

const ZONE_BANDS = bands([
  ZONE_STATUS_RGB.held,
  ZONE_STATUS_RGB.ordered,
  ZONE_STATUS_RGB.flowing,
  ZONE_STATUS_RGB.cleared,
  ZONE_STATUS_RGB.cutoff,
]);

/** Swatches use the real encoding colours so the rail doubles as the legend. */
const LAYERS: { key: keyof LayerVisibility; label: string; swatch: string }[] = [
  { key: "hazard", label: "Hazard perimeter", swatch: rgb(HAZARD_RGB) },
  { key: "flow", label: "Vehicle flow", swatch: rgb(PLAN_RGB) },
  { key: "congestion", label: "Congestion", swatch: bands(CONGESTION_RAMP) },
  { key: "zones", label: "Evac zones", swatch: ZONE_BANDS },
  { key: "noVehicle", label: "No-vehicle households", swatch: rgb(WARN_RGB) },
  { key: "facilities", label: "Facilities", swatch: "var(--subtle)" },
  { key: "busArcs", label: "Bus dispatch arcs", swatch: rgb(PLAN_RGB) },
  { key: "roadblocks", label: "Road closures", swatch: rgb(HAZARD_RGB) },
  { key: "population", label: "Population density", swatch: "var(--faint)" },
  { key: "terrain", label: "Terrain relief", swatch: "var(--hairline-strong)" },
];

export function LayersSection() {
  const layers = useEgress(selLayers);

  return (
    <section className="px-3 pt-[18px] pb-1">
      <div className="label-mono mb-2">Layers</div>

      {LAYERS.map((layer) => {
        const on = layers[layer.key];
        return (
          <div key={layer.key} className="mb-1.5 flex items-center gap-2 last:mb-0">
            <span
              aria-hidden
              className="h-2.5 w-2.5 flex-none rounded-xs border border-hairline"
              style={{ background: layer.swatch, opacity: on ? 1 : 0.35 }}
            />
            <span className="flex-1 truncate text-[11.5px] text-subtle">{layer.label}</span>
            <button
              type="button"
              className="sw"
              data-on={on}
              aria-pressed={on}
              aria-label={layer.label}
              onClick={() => actions.toggleLayer(layer.key)}
            />
          </div>
        );
      })}
    </section>
  );
}

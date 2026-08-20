"use client";

import { actions, selBasemap, useEgress } from "@/lib/store";
import type { BasemapId } from "@/types/egress";

const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: "satellite", label: "Satellite" },
  { id: "dark", label: "Dark" },
  { id: "terrain", label: "Terrain" },
];

export function BasemapSection() {
  const basemap = useEgress(selBasemap);

  return (
    <section className="px-3 pt-[18px] pb-1">
      <div className="label-mono mb-2">Basemap</div>
      <div className="seg">
        {BASEMAPS.map((b) => (
          <button
            key={b.id}
            type="button"
            data-on={basemap === b.id}
            onClick={() => actions.setBasemap(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </section>
  );
}

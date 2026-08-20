"use client";

import type { PickingInfo } from "@deck.gl/core";
import type { DetailBlock, DetailBuilding } from "@/types/detail-layers";
import type { Selection } from "@/types/egress";

/**
 * Turning a map pick into a selection, for everything `deckClick` does not
 * already claim.
 *
 * deck-layers.tsx owns `deckClick`, which handles the four kinds the store has
 * always modelled — zone, edge, facility, vehicle. Everything else drawn on the
 * map is pickable and, until this module, opened nothing: population cells,
 * contraflow orders, all eight context layers, and the block and structure
 * detail layers. A click that opens nothing reads as a broken instrument.
 *
 * The layer files are owned elsewhere, so this composes rather than edits:
 *
 *     onClick: (info) => deckClick(info) || pickSelect(info)
 *
 * Order matters. `deckClick` runs first and keeps its existing behaviour
 * exactly; this only ever sees picks it declined.
 *
 * Dispatch is on the datum tag where there is one (`_k` for the core stack,
 * `_ck` for context) and on the layer id where there is not — the detail layers
 * carry no discriminator on purpose, because a tag and a back-pointer on twenty
 * thousand structures would cost megabytes.
 */

/** Emitted so any module can drive a selection without importing the store's
 *  action surface — the same window-event bus the shell already uses for
 *  `egress:flyto` and the scenario picker. */
export const EGRESS_SELECT_EVENT = "egress:select";

export interface SelectDetail {
  kind: Selection["kind"];
  id: string | null;
}

export function selectEntity(kind: Selection["kind"], id: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SelectDetail>(EGRESS_SELECT_EVENT, { detail: { kind, id } }),
  );
}

/** Context feature keys. Minted here, resolved in context-panel.tsx — a stable
 *  key from the payload itself, never an array index a refetch could move. */
function contextId(datum: Record<string, unknown>): string | null {
  const ck = datum._ck as string | undefined;
  switch (ck) {
    case "air":
      return `air:${(datum.station as { id: string }).id}`;
    case "detection": {
      const d = datum.detection as { position: [number, number]; t: number };
      return `detection:${d.position[0]},${d.position[1]},${d.t}`;
    }
    case "smoke": {
      const p = datum.plume as { density: string; startT: number };
      return `smoke:${p.density}:${p.startT}`;
    }
    case "transmission":
      return `transmission:${(datum.line as { id: string }).id}`;
    case "svi":
      return `svi:${(datum.tract as { geoid: string }).geoid}`;
    case "advisory":
      return `advisory:${(datum.advisory as { id: string }).id}`;
    case "burn":
      return `burn:${(datum.scar as { id: string }).id}`;
    case "slope": {
      const c = datum.cell as { position: [number, number] };
      return `slope:${c.position[0]},${c.position[1]}`;
    }
    default:
      return null;
  }
}

/**
 * Returns true when the pick was consumed, matching deck's contract and
 * `deckClick`'s. A pick this module does not recognise is left alone — the map
 * shell clears selection on a bare-basemap click, and clearing here as well
 * would write the selection twice for one gesture.
 */
export function pickSelect(info: PickingInfo): boolean {
  const datum = info.object as Record<string, unknown> | undefined;
  if (!datum) return false;

  if (typeof datum._ck === "string") {
    const id = contextId(datum);
    if (!id) return false;
    selectEntity("context", id);
    return true;
  }

  switch (datum._k) {
    case "cell":
      selectEntity("cell", (datum.cell as { id: string }).id);
      return true;
    case "contraflow": {
      // A contraflow order has no id of its own, and the operator who clicked a
      // reversed carriageway wants the road. The corridor panel shows the order
      // it belongs to, so nothing is lost by resolving to the first segment.
      const order = datum.order as { edgeIds: string[] };
      if (order.edgeIds.length === 0) return false;
      selectEntity("edge", order.edgeIds[0]);
      return true;
    }
    default:
      break;
  }

  const layerId = info.layer?.id ?? "";
  if (layerId.endsWith("detail-blocks")) {
    selectEntity("block", (datum as unknown as DetailBlock).id);
    return true;
  }
  if (layerId.endsWith("detail-buildings")) {
    const b = datum as unknown as DetailBuilding;
    selectEntity("building", `${b.c[0]},${b.c[1]}`);
    return true;
  }

  return false;
}

"use client";

import { Flame, MousePointerClick } from "lucide-react";
import { actions, selSelection, selT, selView, useEgress } from "@/lib/store";
import { CellPanel } from "./cell-panel";
import { ContextPanel } from "./context-panel";
import { CorridorPanel } from "./corridor-panel";
import { BlockPanel, BuildingPanel } from "./detail-panels";
import { FacilityPanel } from "./facility-panel";
import { HazardPanel } from "./hazard-panel";
import { EmptyHint } from "./queue-tab";
import { VehiclePanel } from "./vehicle-panel";
import { WavePanel } from "./wave-panel";
import { ZoneEgressPanel } from "./zone-egress-panel";

/**
 * The universal entity panel.
 *
 * Queue, Route, People and Teams are four views of a ZONE. Everything else on
 * the map — a corridor segment, a facility, a census block, a satellite
 * detection, a release wave, the perimeter itself — has no home among them, and
 * this tab is that home. The dock switches here on its own whenever the
 * operator picks something the other four cannot render, so no click ever lands
 * on a panel that ignores it.
 */
export function DetailTab() {
  const selection = useEgress(selSelection);
  const view = useEgress(selView);
  const t = useEgress(selT);

  const id = selection.id;

  if (!id) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyHint
          icon={MousePointerClick}
          title="Nothing selected"
          hint="Click anything on the map — a zone, a road, a facility, a census block, an air monitor — and everything known about it lands here."
        />
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => actions.select("hazard", "current")}
            className="glass-inset glass-inset-hover flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
          >
            <Flame size={13} strokeWidth={1.75} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block text-[11.5px] font-medium text-foreground">
                Inspect hazard frame
              </span>
              <span className="label-mono block">
                The perimeter fill is not clickable on purpose
              </span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  switch (selection.kind) {
    case "zone":
      return <ZoneEgressPanel zoneId={id} view={view} t={t} />;
    case "edge":
      return <CorridorPanel edgeId={id} view={view} t={t} />;
    case "facility":
      return <FacilityPanel facilityId={id} view={view} t={t} />;
    case "cell":
      return <CellPanel cellId={id} />;
    case "block":
      return <BlockPanel blockId={id} t={t} />;
    case "building":
      return <BuildingPanel buildingKey={id} t={t} />;
    case "context":
      return <ContextPanel selectionId={id} t={t} />;
    case "wave":
      return <WavePanel waveId={id} view={view} t={t} />;
    case "hazard":
      return <HazardPanel frameT={id} t={t} />;
    case "vehicle":
      /* Owned by another agent. It reads selection, view and t from the store
         itself, so the dock only has to give it the tab. */
      return <VehiclePanel />;
    default:
      return (
        <EmptyHint
          icon={MousePointerClick}
          title="Nothing selected"
          hint="Click anything on the map to inspect it."
        />
      );
  }
}

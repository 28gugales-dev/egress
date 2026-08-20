"use client";

import {
  Globe,
  Layers,
  ListFilter,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
  ToggleRight,
} from "lucide-react";
import { ContextLayerToggles } from "@/components/map/context-layers";
import { AssumptionsSection } from "@/components/rail/assumptions-section";
import { BasemapSection } from "@/components/rail/basemap-section";
import { FiltersSection } from "@/components/rail/filters-section";
import { LayersSection } from "@/components/rail/layers-section";
import { LeversSection } from "@/components/rail/levers-section";
import { ScenarioSection } from "@/components/rail/scenario-section";
import { cx } from "@/lib/format";
import { actions, selFilters, selRailCollapsed, useEgress } from "@/lib/store";

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const STRIP = [
  { label: "Plan", Icon: MapIcon },
  { label: "Assumptions", Icon: SlidersHorizontal },
  { label: "Levers", Icon: ToggleRight },
  { label: "Layers", Icon: Layers },
  { label: "Filters", Icon: ListFilter },
  { label: "Basemap", Icon: Globe },
];

/**
 * The rail's one horizontal rule, and it earns its place: above it are the
 * things that change what the model computes, below it are the things that
 * change only what the map draws. A rule between every section said nothing,
 * because a separator that appears everywhere separates nothing.
 */
function Divider() {
  return <div className="mx-3 my-1 h-px bg-hairline" aria-hidden />;
}

/** Collapsed strip. Any icon reopens the rail — at 44px there is no room to
 *  operate a control, so the whole strip is one large affordance. */
function CollapsedRail({
  filtersActive,
  className,
}: {
  filtersActive: boolean;
  className?: string;
}) {
  return (
    <aside
      className={cx(
        "glass-rail flex h-full w-11 flex-none flex-col items-center gap-1 py-2.5",
        className,
      )}
    >
      <button
        type="button"
        onClick={actions.toggleRail}
        aria-label="Expand control rail"
        className="rounded-sm p-1.5 text-subtle transition-colors hover:bg-glass-hover hover:text-foreground"
      >
        <PanelLeftOpen {...ICON} />
      </button>
      <div className="my-1 h-px w-5 bg-hairline" aria-hidden />
      {STRIP.map(({ label, Icon }) => (
        <button
          key={label}
          type="button"
          title={label}
          aria-label={`Expand control rail: ${label}`}
          onClick={actions.toggleRail}
          className="relative rounded-sm p-1.5 text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
        >
          <Icon {...ICON} />
          {label === "Filters" && filtersActive ? (
            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-plan" aria-hidden />
          ) : null}
        </button>
      ))}
    </aside>
  );
}

/** `className` exists for one reason: the rail is mounted floating over the
 *  live map, and only its mount point knows which glass depth that calls for. */
export function ControlRail({ className }: { className?: string } = {}) {
  const collapsed = useEgress(selRailCollapsed);
  const filters = useEgress(selFilters);
  const filtersActive =
    filters.query.trim() !== "" ||
    filters.minUrgency > 0 ||
    filters.statuses.length > 0 ||
    filters.minNoVehicle > 0 ||
    filters.maxHazardEta !== null ||
    filters.facilityKinds.length > 0;

  if (collapsed) return <CollapsedRail filtersActive={filtersActive} className={className} />;

  return (
    <aside
      className={cx(
        "glass-rail flex h-full w-[236px] flex-none flex-col overflow-hidden",
        className,
      )}
    >
      <header className="flex flex-none items-center justify-between border-hairline border-b px-3 py-2.5">
        <span className="label-mono">Control</span>
        <button
          type="button"
          onClick={actions.toggleRail}
          aria-label="Collapse control rail"
          className="-mr-1 rounded-sm p-1 text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
        >
          <PanelLeftClose {...ICON} />
        </button>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <ScenarioSection />
        <AssumptionsSection />
        <LeversSection />
        <Divider />
        <LayersSection />
        <ContextLayerToggles />
        <FiltersSection />
        <BasemapSection />
        {/* Nothing follows, so the last section needs its own bottom air or it
            sits flush against the rail's edge. */}
        <div className="h-3" aria-hidden />
      </div>
    </aside>
  );
}

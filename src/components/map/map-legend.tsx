"use client";

import type { ReactNode } from "react";
import {
  CONGESTION_RAMP,
  HAZARD_RGB,
  PLAN_RGB,
  WARN_RGB,
  ZONE_STATUS_LABEL,
  ZONE_STATUS_RGB,
} from "@/lib/constants";
import { cx } from "@/lib/format";
import { selColorBy, selLayers, useEgress } from "@/lib/store";
import type { MapColorBy, ZoneStatus } from "@/types/egress";

/**
 * Map legend.
 *
 * Rule the whole deck follows: if something on the map is coloured, it is
 * carrying information, and the legend has to say what. So this reflects the
 * layers that are actually on — never a fixed key that lies about a layer the
 * operator switched off.
 */

const STATUS_ORDER: ZoneStatus[] = ["held", "ordered", "flowing", "cleared", "cutoff"];

function css(rgb: readonly [number, number, number], alpha = 1): string {
  return alpha === 1
    ? `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`
    : `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${alpha})`;
}

function rampCss(stops: readonly (readonly [number, number, number])[]): string {
  const parts = stops.map((s, i) => `${css(s)} ${(i / (stops.length - 1)) * 100}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

function Dot({
  rgb,
  hollow = false,
}: {
  rgb: readonly [number, number, number];
  hollow?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="mt-[3px] size-[9px] flex-none rounded-full"
      style={
        hollow
          ? { border: `1.5px solid ${css(rgb)}`, background: css(rgb, 0.22) }
          : { background: css(rgb) }
      }
    />
  );
}

function Bar({
  rgb,
  dashed = false,
}: {
  rgb: readonly [number, number, number];
  dashed?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="mt-[5px] h-[3px] w-[9px] flex-none rounded-full"
      style={
        dashed
          ? {
              backgroundImage: `repeating-linear-gradient(90deg, ${css(rgb)} 0 3px, transparent 3px 5px)`,
            }
          : { background: css(rgb) }
      }
    />
  );
}

/** Sub-swatch for encodings that share one row — keeps the panel from growing
 *  a line per facility kind. */
function Chip({
  rgb,
  hollow = false,
  children,
}: {
  rgb: readonly [number, number, number];
  hollow?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1 text-[10px] text-faint">
      <span
        aria-hidden
        className="size-[7px] flex-none rounded-full"
        style={
          hollow
            ? { border: `1.5px solid ${css(rgb)}`, background: css(rgb, 0.22) }
            : { background: css(rgb) }
        }
      />
      {children}
    </span>
  );
}

function Row({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[11px] leading-[15px] text-subtle">
      {swatch}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

const COLOR_BY_NOTE: Record<MapColorBy, string> = {
  status: "Zone status",
  urgency: "Time to hazard",
  load: "Egress route load",
  vulnerability: "No-vehicle / mobile-home share",
};

export interface MapLegendProps {
  className?: string;
  /**
   * Contraflow has no LayerVisibility key — it draws whenever an order is live.
   * The map shell passes this so the legend can explain the marking when it is
   * actually on screen, and stay quiet when it is not.
   */
  contraflowActive?: boolean;
}

export function MapLegend({ className, contraflowActive = false }: MapLegendProps) {
  const layers = useEgress(selLayers);
  const colorBy = useEgress(selColorBy);

  // `terrain` changes geometry, not colour, so it has nothing to key.
  const anything =
    layers.hazard ||
    layers.zones ||
    layers.congestion ||
    layers.flow ||
    layers.busArcs ||
    layers.facilities ||
    layers.noVehicle ||
    layers.population ||
    contraflowActive;

  if (!anything) return null;

  return (
    <div
      className={cx(
        // Capped and scrollable: the row set grows with whatever the operator
        // switches on, and a legend that runs off the viewport is worse than
        // one that scrolls.
        // lg-surface: the legend is a flyout over the map, not a panel, so it
        // takes the same light refractive ground as the key and the picker.
        "glass lg-surface thin-scroll pointer-events-auto max-h-[min(56vh,340px)] w-[206px] select-none overflow-y-auto px-2.5 pt-2 pb-2.5",
        className,
      )}
    >
      <div className="label-mono mb-1.5">Legend</div>
      <div className="flex flex-col gap-[6px]">
        {layers.hazard && <Row swatch={<Dot rgb={HAZARD_RGB} hollow />}>Fire perimeter</Row>}

        {layers.zones && (
          <div className="flex flex-col gap-1">
            <Row swatch={<Dot rgb={ZONE_STATUS_RGB.flowing} />}>
              Zones — <span className="text-faint">{COLOR_BY_NOTE[colorBy]}</span>
            </Row>
            {colorBy === "status" ? (
              <div className="ml-[17px] flex flex-wrap gap-x-2 gap-y-[3px]">
                {STATUS_ORDER.map((s) => (
                  <span key={s} className="flex items-center gap-1 text-[10px] text-faint">
                    <span
                      aria-hidden
                      className="size-[7px] flex-none rounded-[2px]"
                      style={{ background: css(ZONE_STATUS_RGB[s]) }}
                    />
                    {ZONE_STATUS_LABEL[s]}
                  </span>
                ))}
              </div>
            ) : (
              <div className="ml-[17px]">
                <span
                  aria-hidden
                  className="block h-[4px] w-full rounded-full"
                  style={{
                    background:
                      colorBy === "load"
                        ? rampCss(CONGESTION_RAMP)
                        : `linear-gradient(90deg, ${css(ZONE_STATUS_RGB.held)}, ${css(WARN_RGB)}, ${css(HAZARD_RGB)})`,
                  }}
                />
                <div className="mt-[2px] flex justify-between text-[9.5px] text-faint">
                  <span>{colorBy === "urgency" ? "hours" : "low"}</span>
                  <span>{colorBy === "urgency" ? "minutes" : "high"}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {layers.congestion && (
          <div className="flex flex-col gap-1">
            <Row swatch={<Bar rgb={CONGESTION_RAMP[3]} />}>Road load</Row>
            <div className="ml-[17px]">
              <span
                aria-hidden
                className="block h-[4px] w-full rounded-full"
                style={{ background: rampCss(CONGESTION_RAMP) }}
              />
              <div className="mt-[2px] flex justify-between text-[9.5px] text-faint">
                <span>free</span>
                <span>at capacity</span>
              </div>
            </div>
          </div>
        )}

        {layers.flow && <Row swatch={<Bar rgb={ZONE_STATUS_RGB.flowing} />}>Vehicle trips</Row>}

        {contraflowActive && (
          <Row swatch={<Bar rgb={PLAN_RGB} dashed />}>Contraflow — reversed</Row>
        )}

        {layers.busArcs && <Row swatch={<Bar rgb={WARN_RGB} />}>Dispatched pickup</Row>}
        {/* Two rows, because the closure and the fact that a run needed that
            road are different pieces of information and the map draws them as
            two marks. Collapsing them here would hide the one that matters. */}
        {layers.roadblocks && <Row swatch={<Bar rgb={HAZARD_RGB} />}>Road closed</Row>}
        {layers.roadblocks && (
          <Row swatch={<Bar rgb={PLAN_RGB} />}>Closure on a dispatch route</Row>
        )}

        {layers.facilities && (
          <div className="flex flex-col gap-1">
            <Row swatch={<Dot rgb={PLAN_RGB} />}>Facilities</Row>
            <div className="ml-[17px] flex flex-wrap gap-x-2 gap-y-[3px]">
              <Chip rgb={PLAN_RGB}>Dispatch</Chip>
              <Chip rgb={ZONE_STATUS_RGB.cleared}>Shelter</Chip>
              <Chip rgb={WARN_RGB} hollow>
                Mobile home
              </Chip>
              <Chip rgb={HAZARD_RGB}>In hazard</Chip>
            </div>
          </div>
        )}

        {layers.noVehicle && (
          <Row swatch={<Dot rgb={WARN_RGB} hollow />}>No-vehicle households</Row>
        )}

        {layers.population && <Row swatch={<Dot rgb={ZONE_STATUS_RGB.held} />}>Population</Row>}
      </div>
    </div>
  );
}

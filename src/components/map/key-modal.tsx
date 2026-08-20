"use client";

import { KeyRound, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { CONTEXT_LEGEND } from "@/components/map/context-layers";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { CONGESTION_RAMP, HAZARD_RGB, PLAN_RGB, WARN_RGB, ZONE_STATUS_RGB } from "@/lib/constants";
import { cx } from "@/lib/format";
import { selLayers, useEgress } from "@/lib/store";
import type { ContextLayerId } from "@/types/context-layers";
import type { LayerVisibility } from "@/types/egress";

/**
 * The key.
 *
 * Deliberately a reference card, not documentation. An operator opens it to
 * answer one question — "what is that colour" — and closes it. So: one line per
 * encoding, the gloss short enough to read without stopping, grouped the way
 * the console is read rather than the way the layers are implemented.
 *
 * Rows for layers that are switched off are dimmed rather than hidden. The
 * legend chip reflects what is on screen; this reflects what the console CAN
 * say, and an operator hunting for an encoding they remember should find it
 * where they left it instead of watching it disappear.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Swatches
// ─────────────────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];

const css = (c: Rgb, a = 1) =>
  a === 1 ? `rgb(${c[0]} ${c[1]} ${c[2]})` : `rgb(${c[0]} ${c[1]} ${c[2]} / ${a})`;

function rampCss(stops: readonly Rgb[]): string {
  return `linear-gradient(90deg, ${stops
    .map((c, i) => `${css(c)} ${(i / (stops.length - 1)) * 100}%`)
    .join(", ")})`;
}

/** The hazard field's own ramp — cooled ember through to the leading edge. */
const FIELD_RAMP: Rgb[] = [[120, 53, 32], HAZARD_RGB, [250, 202, 187]];

function Dot({ rgb, hollow = false }: { rgb: Rgb; hollow?: boolean }) {
  return (
    <span
      aria-hidden
      className="size-[8px] flex-none rounded-full"
      style={
        hollow
          ? { border: `1.5px solid ${css(rgb)}`, background: css(rgb, 0.2) }
          : { background: css(rgb) }
      }
    />
  );
}

function Bar({ rgb, dashed = false }: { rgb: Rgb; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className="h-[3px] w-[10px] flex-none rounded-full"
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

/**
 * Silhouette swatches for the vehicle stack.
 *
 * A Dot cannot carry these rows. The map draws bus, ambulance and engine as
 * masked shapes precisely so that SHAPE encodes type and colour stays free to
 * encode state — a legend that reduced all three to coloured circles would
 * teach the reader the opposite of what the map is doing. These are the same
 * outlines as the atlas in vehicle-icons.ts, at 12px.
 */
function Glyph({ kind, rgb }: { kind: "bus" | "ambulance" | "engine" | "barrier"; rgb: Rgb }) {
  const fill = css(rgb);
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="size-[12px] flex-none"
      style={{ color: fill }}
      focusable="false"
    >
      <title>{kind}</title>
      {kind === "bus" ? (
        <rect x="1" y="4" width="10" height="4" rx="1.2" fill="currentColor" />
      ) : null}
      {kind === "ambulance" ? (
        <>
          <rect x="1.5" y="4" width="9" height="4" rx="1" fill="currentColor" />
          <path d="M5.4 4.9h1.2v1.1h1.1v1.2H6.6v1.1H5.4V7.2H4.3V6h1.1z" fill="var(--glass)" />
        </>
      ) : null}
      {kind === "engine" ? (
        <>
          <rect x="1" y="3.6" width="4" height="4.8" rx="1" fill="currentColor" />
          <rect x="4.6" y="4.6" width="6.4" height="2.8" rx="0.6" fill="currentColor" />
          <rect x="5.2" y="2.6" width="5.6" height="1.2" rx="0.6" fill="currentColor" />
        </>
      ) : null}
      {kind === "barrier" ? (
        <>
          <rect x="1" y="5.2" width="10" height="1.6" rx="0.8" fill="currentColor" />
          <rect x="5.2" y="2.4" width="1.6" height="7.2" rx="0.8" fill="currentColor" />
        </>
      ) : null}
    </svg>
  );
}

function Ramp({ stops }: { stops: readonly Rgb[] }) {
  return (
    <span
      aria-hidden
      className="h-[6px] w-[10px] flex-none rounded-[2px]"
      style={{ background: rampCss(stops) }}
    />
  );
}

/**
 * Display copy for the context group. Only the words live here; every colour,
 * break and unit comes from CONTEXT_LEGEND so the key cannot drift from the
 * map. `layer` is the LayerVisibility key the row dims itself against.
 */
const CONTEXT_ROWS: {
  id: ContextLayerId;
  name: string;
  gloss: string;
  layer: keyof LayerVisibility;
}[] = [
  {
    id: "airQuality",
    name: "Air quality",
    gloss: "PM2.5 at regulatory monitors",
    layer: "airQuality",
  },
  {
    id: "aerosol",
    name: "Aerosol",
    gloss: "satellite column depth, NOT surface PM2.5",
    layer: "aerosol",
  },
  { id: "smoke", name: "Smoke", gloss: "analyst plume extent", layer: "smoke" },
  {
    id: "socialVulnerability",
    name: "Vulnerability",
    gloss: "CDC index, by census tract",
    layer: "socialVulnerability",
  },
  { id: "fireWeather", name: "Fire weather", gloss: "advisories in force", layer: "fireWeather" },
  { id: "slope", name: "Slope", gloss: "terrain steepness", layer: "slope" },
  { id: "burnScars", name: "Burn scars", gloss: "earlier fire footprints", layer: "burnScars" },
  {
    id: "transmission",
    name: "Transmission",
    gloss: "high-voltage lines, by voltage",
    layer: "transmission",
  },
  {
    id: "fireIntensity",
    name: "Fire intensity",
    gloss: "satellite radiative power",
    layer: "fireIntensity",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <h3 className="label-mono mb-1">{label}</h3>
      <div className="flex flex-col gap-[2px]">{children}</div>
    </section>
  );
}

function Row({
  swatch,
  name,
  gloss,
  off = false,
  sub = false,
}: {
  swatch: ReactNode;
  /** Empty on a `sub` row, where the gloss IS the label. */
  name?: string;
  gloss: string;
  off?: boolean;
  /** A qualifier belonging to the row above — a monitor state, a no-data mark.
   *  Indented and label-less, so it reads as part of that encoding rather than
   *  as a tenth layer. */
  sub?: boolean;
}) {
  return (
    <div
      className={cx(
        "grid items-baseline gap-x-2.5 text-[11px] leading-[15px]",
        sub ? "grid-cols-[10px_10px_1fr] pl-0" : "grid-cols-[10px_1fr]",
        off && "opacity-45",
      )}
    >
      {sub ? <span aria-hidden /> : null}
      {/* The swatch sits on the cap line, not the baseline, or a 3px bar
          floats a row below the word it labels. */}
      <span className="flex h-[15px] items-center justify-center">{swatch}</span>
      <span className="min-w-0">
        {name ? <span className="text-foreground">{name} </span> : null}
        <span className="text-faint">{gloss}</span>
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function KeySheet({ onClose, layers }: { onClose: () => void; layers: LayerVisibility }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Close key"
        onClick={onClose}
        className="glass-scrim absolute cursor-default"
      />
      <LiquidGlass
        className="sheet relative flex max-h-[86vh] w-full max-w-[356px] flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Map key"
      >
        <div className="flex items-center gap-3 px-4 pt-3 pb-2">
          <div className="panel-title flex-1">Key</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-sm p-1 text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto px-4 pb-3">
          <Group label="Hazard">
            <Row
              swatch={<Ramp stops={FIELD_RAMP} />}
              name="Fire field"
              gloss="burn age, hottest at the front"
              off={!layers.hazard}
            />
            <Row
              swatch={<Bar rgb={HAZARD_RGB} />}
              name="Solid edge"
              gloss="observed perimeter, recorded"
              off={!layers.hazard}
            />
            <Row
              swatch={<Bar rgb={HAZARD_RGB} dashed />}
              name="Dashed edge"
              gloss="modelled between observations"
              off={!layers.hazard}
            />
          </Group>

          <Group label="Closures">
            <Row
              swatch={<Glyph kind="barrier" rgb={HAZARD_RGB} />}
              name="Road closed"
              gloss="taken by the modelled perimeter"
              off={!layers.roadblocks}
            />
            <Row
              swatch={<Bar rgb={PLAN_RGB} />}
              name="On a dispatch route"
              gloss="cyan casing — a run used this road"
              off={!layers.roadblocks}
            />
          </Group>

          <Group label="Flow">
            <Row
              swatch={<Bar rgb={ZONE_STATUS_RGB.flowing} />}
              name="Trips"
              gloss="vehicles moving, tinted by zone"
              off={!layers.flow}
            />
            <Row
              swatch={<Ramp stops={CONGESTION_RAMP} />}
              name="Road load"
              gloss="free flow through to at capacity"
              off={!layers.congestion}
            />
            <Row
              swatch={<Bar rgb={PLAN_RGB} dashed />}
              name="Contraflow"
              gloss="opposing lanes reversed outbound"
            />
            <Row
              swatch={<Bar rgb={WARN_RGB} />}
              name="Pickup run"
              gloss="bus sent for households without cars"
              off={!layers.busArcs}
            />
          </Group>

          <Group label="Zones">
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.held} />}
              name="Held"
              gloss="not ordered out yet"
              off={!layers.zones}
            />
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.ordered} />}
              name="Ordered"
              gloss="order issued, not moving"
              off={!layers.zones}
            />
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.flowing} />}
              name="Flowing"
              gloss="under way on its corridor"
              off={!layers.zones}
            />
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.cleared} />}
              name="Cleared"
              gloss="last household out"
              off={!layers.zones}
            />
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.cutoff} />}
              name="Cut off"
              gloss="egress lost to the fire"
              off={!layers.zones}
            />
          </Group>

          <Group label="Teams">
            {/* Shape first, because that is the encoding the fleet actually
                uses. Colour on these three is phase, never type. */}
            <Row
              swatch={<Glyph kind="bus" rgb={WARN_RGB} />}
              name="Bus"
              gloss="shape is the type; colour is the phase"
              off={!layers.busArcs}
            />
            <Row
              swatch={<Glyph kind="ambulance" rgb={WARN_RGB} />}
              name="Ambulance"
              gloss="cross cut through the body"
              off={!layers.busArcs}
            />
            <Row
              swatch={<Glyph kind="engine" rgb={WARN_RGB} />}
              name="Engine"
              gloss="stabled at a station, never dispatched"
              off={!layers.facilities}
            />
            <Row
              swatch={<Dot rgb={PLAN_RGB} />}
              name="Dispatch"
              gloss="fire, EMS, transit, school"
              off={!layers.facilities}
            />
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.cleared} />}
              name="Shelter"
              gloss="destination, sized by capacity"
              off={!layers.facilities}
            />
            <Row
              swatch={<Dot rgb={WARN_RGB} hollow />}
              name="Mobile homes"
              gloss="manufactured housing, slowest to clear"
              off={!layers.facilities}
            />
            <Row
              swatch={<Dot rgb={HAZARD_RGB} />}
              name="In hazard"
              gloss="facility inside the footprint"
              off={!layers.facilities}
            />
            <Row
              swatch={<Dot rgb={WARN_RGB} hollow />}
              name="No vehicle"
              gloss="households with no car"
              off={!layers.noVehicle}
            />
            <Row
              swatch={<Dot rgb={ZONE_STATUS_RGB.held} />}
              name="Population"
              gloss="block group, sized by count"
              off={!layers.population}
            />
          </Group>

          {/* Driven by CONTEXT_LEGEND, which context-layers.tsx exports from the
              same constants it draws with. These rows used to be hand-copied
              ramps here, and they had already gone stale in four places: SVI
              became classed, slope gained fixed degree breaks, smoke and fire
              weather became graduated, and the aerosol field did not exist. A
              legend that disagrees with the map is worse than no legend. */}
          <Group label="Context">
            {CONTEXT_ROWS.map(({ id, name, gloss, layer }) => {
              const legend = CONTEXT_LEGEND[id];
              if (!legend) return null;
              const off = !layers[layer];
              return (
                <Fragment key={id}>
                  <Row swatch={<Ramp stops={legend.stops} />} name={name} gloss={gloss} off={off} />
                  {/* Marks are states the ramp cannot express -- a monitor that
                      went dark, a satellite cell with no retrieval. Dropping
                      them would let absence read as a low reading. */}
                  {legend.marks?.map((mark) => (
                    <Row
                      key={mark.label}
                      swatch={<Dot rgb={mark.rgb} hollow={mark.hollow} />}
                      gloss={mark.label}
                      off={off}
                      sub
                    />
                  ))}
                </Fragment>
              );
            })}
          </Group>
        </div>

        <div className="px-4 pt-1.5 pb-3 text-[10px] leading-[14px] text-faint">
          Dimmed rows are switched off. Colour on this map only ever encodes data.
        </div>
      </LiquidGlass>
    </div>
  );
}

/** Button plus sheet, self-contained so the shell mounts one element. */
export function MapKey({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const layers = useEgress(selLayers);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Map key"
        aria-expanded={open}
        title="Map key"
        onClick={() => setOpen(true)}
        className={cx(
          "glass pointer-events-auto flex size-7 items-center justify-center rounded-full text-subtle transition-colors hover:bg-glass-hover hover:text-foreground",
          className,
        )}
      >
        <KeyRound size={13} strokeWidth={1.75} />
      </button>
      {open ? <KeySheet layers={layers} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

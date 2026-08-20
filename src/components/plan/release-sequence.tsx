"use client";

import { ArrowLeftRight, DoorClosed, Download, Radio } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBundle } from "@/lib/bundle-context";
import { CONGESTION_RAMP } from "@/lib/constants";
import { bindingWave, zoneClearance } from "@/lib/derive";
import {
  cx,
  formatCount,
  formatPercent,
  formatShort,
  formatTick,
  loadBucket,
  URGENCY_VAR,
  urgencyBand,
} from "@/lib/format";
import { actions, selView, useEgress } from "@/lib/store";
import type { ContraflowOrder, EvacZone, ReleaseWave, SimulationRun, Tick } from "@/types/egress";
import { AlertComposer } from "./alert-composer";

// ─────────────────────────────────────────────────────────────────────────────
// CSV — every field is quoted because zone lists and route labels contain
// commas, and a silently shifted column in an evacuation order is a disaster.
// ─────────────────────────────────────────────────────────────────────────────

function csvCell(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function download(filename: string, body: string, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many columns fit, decided by the TABLE's own scroller and nothing else.
 *
 * It used to follow the panel column's 780px compact threshold, which left a
 * dead band of panel widths — 781 to 835, i.e. 1562 to 1670 window — where the
 * full table needed 810px in a 773px scroller and MARGIN, the one column that
 * says whether a wave makes it, sat 37px off the right edge behind a horizontal
 * scrollbar with its header reading "MAI". A table measured against a container
 * that is not the one it renders in will always have a band like that.
 *
 * Thresholds are the measured min-content of each tier plus a small guard, not
 * round numbers: see MIN_CONTENT below.
 */
type RsTier = "full" | "mid" | "tight";

/**
 * Measured on :3010 by forcing `width: min-content` on the live table and
 * reading its width back: all nine columns need 810px, eight without ROUTE
 * need 502, six without the two household columns need 416. A table with
 * `width: 100%` cannot render below its min-content, so those ARE the widths at
 * which each tier starts to overflow. Thresholds are those plus a 4px guard.
 *
 * The consequence worth naming: at a 1440 window this pane is about 693px, so
 * the demand columns — households and no-vehicle households — now survive there.
 * They were being dropped along with ROUTE by a single threshold, which left
 * the console's central artifact unable to say what a wave was made of at the
 * commonest laptop width there is.
 */
const TIER_MIN: { tier: RsTier; needs: number }[] = [
  { tier: "full", needs: 814 },
  { tier: "mid", needs: 506 },
];

/** Zone ids printed inline before the row switches to a "+N" summary. */
const ZONE_CHIPS: Record<RsTier, number> = { full: 4, mid: 3, tight: 1 };

/** Columns rendered, by tier. The rationale row's colSpan reads off this, so
 *  the two can never disagree. */
const COLUMN_COUNT: Record<RsTier, number> = { full: 9, mid: 8, tight: 6 };

function tierFor(width: number): RsTier {
  for (const t of TIER_MIN) if (width >= t.needs) return t.tier;
  return "tight";
}

/**
 * How much room this wave actually has: the earliest a zone in it burns, minus
 * the moment that zone finishes emptying. Worst zone in the wave wins, because
 * clearance is when the LAST person is out.
 *
 * NOT `hazardEta - departAt`. That subtraction is order-to-fire time — how long
 * after the order the fire arrives — and it is the number an operator will read
 * as "do we make it", because that is the only question the column can be about.
 * The two answers diverge exactly where it matters: the baseline releases 46
 * zones at T+0 against a 35-minute hazard ETA and clears in 9:30 with 3,797
 * vehicles caught, and the old column printed a comfortable 35m for it. The new
 * one prints five hours late. This is the same subtraction zone-egress-panel.tsx
 * already makes per zone (`clearedAt <= hazardEta ? margin : LATE`); the column
 * only aggregates what that panel has always said.
 *
 * STRANDED ZONES ARE EXCLUDED FROM THE MINIMUM AND NAMED INSTEAD.
 * One zone — BUT-CON-513, four households — reports the same 4 remaining in
 * every frame of BOTH runs, from the first to the last. It is not a
 * property of any plan; it is the solver slack the CONTROL pane already refuses
 * to render as abandonment (`summary.unassigned` is 8 in both runs). Folding it
 * into the minimum made wave 0 read NEVER in the baseline and in the plan
 * alike, which is the one thing a comparison column must not do. It is excluded
 * from the number and listed in the cell's own tooltip, never dropped silently.
 */
interface WaveMargin {
  /** Worst margin across the zones that do empty. Null when none of them do. */
  margin: Tick | null;
  /** Zones that never empty inside the run window. */
  stranded: string[];
}

function waveMargin(
  run: SimulationRun | null,
  wave: ReleaseWave,
  zoneById: Map<string, EvacZone>,
): WaveMargin {
  const stranded: string[] = [];
  let worst = Number.POSITIVE_INFINITY;
  if (!run) return { margin: null, stranded };
  for (const id of wave.zoneIds) {
    const zone = zoneById.get(id);
    if (!zone) continue;
    const clearance = zoneClearance(run, id, 0);
    if (!clearance || clearance.clearedAt === null) {
      stranded.push(id);
      continue;
    }
    worst = Math.min(worst, zone.hazardEta - clearance.clearedAt);
  }
  return { margin: Number.isFinite(worst) ? worst : null, stranded };
}

/** Said in full in the cell's tooltip, because the column header has room for
 *  one word and the distinction is the entire point of the column. */
function marginTitle({ margin, stranded }: WaveMargin): string {
  const note =
    stranded.length === 0
      ? ""
      : ` Excluded: ${stranded.join(", ")} — never empties in either run, so it is solver slack rather than a property of this plan.`;
  if (margin === null) return `No zone in this wave empties inside the run window.${note}`;
  if (margin === 0) {
    return `A zone in this wave finishes clearing on the same frame the fire reaches it — no room at all.${note}`;
  }
  if (margin < 0) {
    return `The fire reaches a zone in this wave ${formatShort(-margin)} before that zone finishes clearing.${note}`;
  }
  return `Hazard arrival minus the moment the wave finishes clearing — the room it actually has.${note}`;
}

export interface ReleaseSequenceProps {
  className?: string;
}

export function ReleaseSequence({ className }: ReleaseSequenceProps) {
  const bundle = useBundle();
  const view = useEgress(selView);
  const [selectedWave, setSelectedWave] = useState<number | null>(null);
  const [composerWave, setComposerWave] = useState<ReleaseWave | null>(null);

  /* The scroller measures itself. Switching tier makes the table narrower and
     never the scroller, so there is no width at which this oscillates.
     A callback ref rather than a mount effect, and that is not a style choice:
     this component returns a loading placeholder until the bundle lands, so a
     [] effect runs while the table does not exist, the ref is null, and the
     width stays 0 forever — which pins the tier at its pre-measure fallback and
     reproduces the exact 47px overflow this measurement exists to prevent. */
  const observer = useRef<ResizeObserver | null>(null);
  const [scrollerWidth, setScrollerWidth] = useState(0);
  const scrollerRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setScrollerWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setScrollerWidth(el.clientWidth));
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const tier: RsTier = scrollerWidth > 0 ? tierFor(scrollerWidth) : "full";

  /* The sequence of the run you are LOOKING at, not always the planned one.
     The baseline's plan is a single wave releasing all 46 zones at T+0 at
     1231% of corridor capacity — the whole thesis in one row — and hiding it
     behind the planned table would be special-casing the argument away. */
  const plan = (view === "baseline" ? bundle?.baseline?.plan : bundle?.planned?.plan) ?? null;
  const waves = useMemo(() => plan?.waves ?? [], [plan]);
  const binding = useMemo(() => (plan ? bindingWave(plan) : null), [plan]);

  const zoneById = useMemo(() => {
    const m = new Map<string, EvacZone>();
    for (const z of bundle?.zones.zones ?? []) m.set(z.id, z);
    return m;
  }, [bundle]);

  const chipCount = ZONE_CHIPS[tier];

  /* Same run the table is describing. Reading margins off the planned run
     while showing the baseline's plan would print a counterfactual's clearance
     against the observed event's fire. */
  const run = (view === "baseline" ? bundle?.baseline : bundle?.planned) ?? null;

  const activeWave: ReleaseWave | null = useMemo(() => {
    if (selectedWave !== null) return waves.find((w) => w.wave === selectedWave) ?? null;
    return binding ?? waves[0] ?? null;
  }, [selectedWave, waves, binding]);

  /** No-vehicle households are the door-knock list: the transit-dependent are
   *  exactly the people a push alert reaches last, and the only zone-level
   *  field that identifies them. */
  const doorKnockCount = useMemo(
    () => waves.reduce((n, w) => n + w.noVehicleHouseholds, 0),
    [waves],
  );

  const exportWaves = useCallback(() => {
    const rows = waves.map((w) => {
      // Two different questions, named apart. The old export called the first
      // of these "margin", which is the conflation the table used to make.
      const { margin, stranded } = waveMargin(run, w, zoneById);
      return [
        w.wave,
        w.zoneIds.join("; "),
        formatTick(w.departAt, false),
        w.departAt,
        w.households,
        w.noVehicleHouseholds,
        w.routeLabel,
        formatPercent(w.egressLoad, 1),
        formatShort(w.hazardEta),
        w.hazardEta - w.departAt,
        margin === null ? "NO ZONE CLEARS" : formatShort(margin),
        margin === null ? "" : margin,
        stranded.join("; "),
        w.binding ? "BINDING" : "",
        w.rationale ?? "",
      ];
    });
    download(
      `egress-release-sequence-${bundle?.meta.id ?? "scenario"}.csv`,
      toCsv(
        [
          "wave",
          "zones",
          "depart",
          "depart_seconds",
          "households",
          "no_vehicle_households",
          "route",
          "egress_load",
          "hazard_eta",
          "order_to_hazard_seconds",
          "clear_before_hazard",
          "clear_before_hazard_seconds",
          "zones_never_clearing",
          "flag",
          "rationale",
        ],
        rows,
      ),
    );
  }, [waves, bundle, run, zoneById]);

  const exportContraflow = useCallback(() => {
    const orders: ContraflowOrder[] = plan?.contraflow ?? [];
    const rows = orders.map((o) => [
      o.label,
      o.edgeIds.length,
      formatTick(o.activateAt, false),
      formatTick(o.releaseAt, false),
      o.capacityBefore,
      o.capacityAfter,
      o.capacityAfter - o.capacityBefore,
      o.edgeIds.join("; "),
    ]);
    download(
      `egress-contraflow-work-orders-${bundle?.meta.id ?? "scenario"}.csv`,
      toCsv(
        [
          "corridor",
          "segments",
          "activate",
          "release",
          "capacity_before_vph",
          "capacity_after_vph",
          "capacity_gain_vph",
          "edge_ids",
        ],
        rows,
      ),
    );
  }, [plan, bundle]);

  const exportDoorKnock = useCallback(() => {
    const rows: (string | number)[][] = [];
    for (const w of waves) {
      for (const id of w.zoneIds) {
        const z = zoneById.get(id);
        if (!z || z.noVehicleHouseholds <= 0) continue;
        rows.push([
          w.wave,
          z.id,
          z.label,
          z.noVehicleHouseholds,
          z.mobileHomes,
          z.centroid[1].toFixed(5),
          z.centroid[0].toFixed(5),
          formatTick(w.departAt, false),
          formatShort(z.hazardEta),
        ]);
      }
    }
    download(
      `egress-door-knock-${bundle?.meta.id ?? "scenario"}.csv`,
      toCsv(
        [
          "wave",
          "zone_id",
          "zone",
          "no_vehicle_households",
          "mobile_homes",
          "lat",
          "lng",
          "depart",
          "hazard_eta",
        ],
        rows,
      ),
    );
  }, [waves, zoneById, bundle]);

  if (!bundle || !plan) {
    return (
      <div className={cx("glass flex items-center justify-center px-6 py-10", className)}>
        <div className="text-center">
          <div className="label-mono mb-1">Release sequence</div>
          <div className="text-[12px] text-faint">
            {bundle ? "Planned run not computed yet." : "Loading scenario…"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cx("glass flex min-h-0 flex-col overflow-hidden", className)}>
      {/* header */}
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="label-mono">Actuating artifact</div>
          <div className="panel-title">Zone release sequence</div>
        </div>
        <div className="text-right">
          <div className="label-mono">Waves</div>
          <div className="readout text-[13px] text-foreground">{waves.length}</div>
        </div>
        <div className="text-right">
          <div className="label-mono">Rev</div>
          <div className="readout text-[13px] text-foreground">{plan.revision}</div>
        </div>
      </div>

      {/* table */}
      <div ref={scrollerRef} className="thin-scroll min-h-0 flex-1 overflow-auto">
        <table
          className={cx("w-full border-collapse text-[11.5px]", tier !== "full" && "rs-tight")}
        >
          <thead className="sticky top-0 z-10 bg-glass backdrop-blur-md">
            <tr className="border-b border-hairline">
              <Th className="w-[46px]">Wave</Th>
              <Th>Zones</Th>
              <Th className="w-[80px]" right>
                Depart
              </Th>
              {/* HH and NO-VEH are the demand columns: how many households a
                  wave moves, and how many of those cannot move themselves. They
                  are the last thing to go, not the first — the previous tier
                  dropped all three at once at a 1440 window, which left the
                  console's central artifact unable to say what a wave is made
                  of at the commonest laptop width there is. */}
              {tier === "tight" ? null : (
                <Th className="w-[62px]" right>
                  HH
                </Th>
              )}
              {tier === "tight" ? null : (
                <Th className="w-[66px]" right>
                  No-veh
                </Th>
              )}
              {tier === "full" ? <Th className="w-[136px]">Route</Th> : null}
              <Th className="w-[112px]">Egress load</Th>
              <Th className="w-[86px]" right>
                Hazard ETA
              </Th>
              <Th className="w-[80px]" right>
                Margin
              </Th>
            </tr>
          </thead>
          <tbody>
            {waves.map((w) => {
              const isBinding = binding ? w.wave === binding.wave : Boolean(w.binding);
              const isSelected = activeWave?.wave === w.wave;
              const ramp = CONGESTION_RAMP[loadBucket(w.egressLoad, CONGESTION_RAMP.length)];
              const band = urgencyBand(w.hazardEta);
              const wm = waveMargin(run, w, zoneById);
              const margin = wm.margin;
              return (
                <Fragment key={w.wave}>
                  <tr
                    onClick={() => {
                      setSelectedWave(w.wave);
                      const first = w.zoneIds[0];
                      if (first) actions.select("zone", first);
                    }}
                    className={cx(
                      "cursor-pointer border-b border-hairline transition-colors",
                      isBinding ? "bg-warn-dim" : "hover:bg-glass-hover",
                      isSelected && !isBinding && "bg-glass-inset",
                    )}
                  >
                    <Td>
                      <span
                        className={cx(
                          "readout inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-xs px-1 text-[10.5px]",
                          isBinding ? "bg-warn text-background" : "bg-glass-inset text-subtle",
                        )}
                      >
                        {w.wave}
                      </span>
                    </Td>
                    <Td>
                      {/* Capped. Wave 0 names 28 zones; printed in full they
                          made one row 600px tall and pushed the other three
                          waves off the pane. The count leads, the CSV carries
                          every id, and the title has the rest. */}
                      <div className="flex flex-wrap items-baseline gap-1">
                        <span className="readout mr-0.5 text-[10.5px] text-subtle">
                          {w.zoneIds.length}
                        </span>
                        {w.zoneIds.slice(0, chipCount).map((id) => (
                          <span
                            key={id}
                            className="readout whitespace-nowrap rounded-xs bg-glass-inset px-1.5 py-0.5 text-[10.5px] text-foreground"
                          >
                            {id}
                          </span>
                        ))}
                        {w.zoneIds.length > chipCount ? (
                          <span
                            className="readout text-[10.5px] text-faint"
                            title={w.zoneIds.slice(chipCount).join(", ")}
                          >
                            +{w.zoneIds.length - chipCount}
                          </span>
                        ) : null}
                      </div>
                    </Td>
                    <Td right>
                      <span className="readout text-foreground">
                        {formatTick(w.departAt, false)}
                      </span>
                    </Td>
                    {tier === "tight" ? null : (
                      <Td right>
                        <span className="readout text-subtle">{formatCount(w.households)}</span>
                      </Td>
                    )}
                    {tier === "tight" ? null : (
                      <Td right>
                        <span
                          className={cx(
                            "readout",
                            w.noVehicleHouseholds > 0 ? "text-warn" : "text-faint",
                          )}
                        >
                          {formatCount(w.noVehicleHouseholds)}
                        </span>
                      </Td>
                    )}
                    {tier === "full" ? (
                      <Td>
                        <span className="truncate text-subtle">{w.routeLabel}</span>
                      </Td>
                    ) : null}
                    <Td>
                      <div className="flex items-center gap-2">
                        <div className="h-[4px] w-[52px] overflow-hidden rounded-xs bg-glass-inset">
                          <div
                            className="h-full rounded-xs"
                            style={{
                              width: `${Math.min(100, Math.round(w.egressLoad * 100))}%`,
                              background: `rgb(${ramp[0]},${ramp[1]},${ramp[2]})`,
                            }}
                          />
                        </div>
                        <span className="readout text-[10.5px] text-subtle">
                          {formatPercent(w.egressLoad)}
                        </span>
                      </div>
                    </Td>
                    <Td right>
                      <span className="readout" style={{ color: URGENCY_VAR[band] }}>
                        {formatShort(w.hazardEta)}
                      </span>
                    </Td>
                    {/* The only number in the row that says whether the wave
                        makes it: when the last zone in it finishes emptying,
                        against when the first zone in it burns. */}
                    <Td right>
                      <span
                        className="readout"
                        style={{
                          color:
                            margin === null || margin <= 0
                              ? "var(--hazard)"
                              : URGENCY_VAR[urgencyBand(margin)],
                        }}
                        title={marginTitle(wm)}
                      >
                        {margin === null ? "NEVER" : margin <= 0 ? "NONE" : formatShort(margin)}
                      </span>
                    </Td>
                  </tr>
                  {isBinding && w.rationale && (
                    <tr className="border-b border-hairline bg-warn-dim">
                      <td colSpan={COLUMN_COUNT[tier]} className="px-3 pb-2.5 pt-0">
                        <div className="flex gap-2 border-l-2 border-warn pl-2.5">
                          <div className="min-w-0">
                            <div className="label-mono !text-warn">
                              Binding wave — this is what pins clearance
                            </div>
                            <div className="mt-0.5 text-[11.5px] italic leading-snug text-subtle">
                              “{w.rationale}”
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3">
        <Action
          onClick={exportWaves}
          icon={<Download size={13} strokeWidth={1.75} />}
          label="Export CSV"
        />
        <Action
          onClick={() => setComposerWave(activeWave)}
          disabled={!activeWave}
          icon={<Radio size={13} strokeWidth={1.75} />}
          label={
            activeWave ? `Generate CAP messages — wave ${activeWave.wave}` : "Generate CAP messages"
          }
          primary
        />
        <Action
          onClick={exportContraflow}
          disabled={plan.contraflow.length === 0}
          icon={<ArrowLeftRight size={13} strokeWidth={1.75} />}
          label={`Contraflow work orders (${plan.contraflow.length})`}
        />
        <Action
          onClick={exportDoorKnock}
          icon={<DoorClosed size={13} strokeWidth={1.75} />}
          label={`Door-knock list (${formatCount(doorKnockCount)})`}
        />
      </div>

      {composerWave && <AlertComposer wave={composerWave} onClose={() => setComposerWave(null)} />}
    </div>
  );
}

function Th({
  children,
  className,
  right,
}: {
  children: React.ReactNode;
  className?: string;
  right?: boolean;
}) {
  return (
    <th
      className={cx(
        "label-mono px-3 py-2 font-medium",
        right ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={cx("px-3 py-2 align-middle", right && "text-right")}>{children}</td>;
}

function Action({
  onClick,
  icon,
  label,
  disabled,
  primary,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        // Primacy in ink and weight, never in a data hue. --plan/cyan means
        // "this is the planned run" everywhere else on screen, and spending it
        // here to mean "this is the important button" is the decoration the
        // project's own rule forbids — this was the only coloured control among
        // four peers in the bar.
        primary
          ? "border-hairline-strong bg-glass-active font-semibold text-foreground hover:bg-glass-hover"
          : "border-hairline bg-glass-inset text-subtle hover:bg-glass-hover hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

"use client";

import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EGRESS_FLYTO_EVENT, type FlyToDetail, MapShell } from "@/components/map/map-shell";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { frameAt } from "@/lib/derive";
import {
  clamp,
  cx,
  formatCount,
  formatDelta,
  formatDistance,
  formatDuration,
  formatTick,
} from "@/lib/format";
import { actions, selScenarioId, selT, useEgress } from "@/lib/store";
import type { RunKind, ScenarioMeta, SimulationRun } from "@/types/egress";

/** Camera shared by both halves. Locking it is the entire point of this view. */
export interface SplitViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface SplitViewProps {
  className?: string;
  /**
   * Per-run deck.gl overlay, injected as MapShell children. The layer stack is
   * owned elsewhere; this is the seam that lets each half draw its own run
   * without split-view importing it.
   */
  renderOverlay?: (runKind: RunKind, scenario: ScenarioMeta) => ReactNode;
}

export function SplitView({ className, renderOverlay }: SplitViewProps) {
  const bundle = useBundle();
  const t = useEgress(selT);
  const scenarioId = useEgress(selScenarioId);
  const meta = bundle?.meta ?? getScenario(scenarioId);

  const [viewState, setViewState] = useState<SplitViewState>(() => ({
    longitude: meta.center[0],
    latitude: meta.center[1],
    zoom: meta.zoom,
    pitch: 0,
    bearing: 0,
  }));

  /**
   * Pane-derived initial zoom.
   *
   * MapShell's own `zoomAdjust` never reaches here: this view builds its own
   * viewState from meta.center / meta.zoom directly, so the offset has to be
   * computed against the PANE box, not the map plane's. 1600x900 is the frame
   * the scenario cameras were authored against; a 960x510 pane is 0.6 of that
   * in one axis, so without this the compare panes frame a fraction of the town
   * and the argument lands badly on stage.
   *
   * Applied once, guarded by a ref: after this the operator owns the camera.
   */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current) return;
    const el = gridRef.current;
    if (!el) return;
    const paneW = el.clientWidth;
    const paneH = (el.clientHeight - 8) / 2;
    if (paneW <= 0 || paneH <= 0) return;
    framed.current = true;
    const offset = clamp(Math.log2(Math.min(paneW / 1600, paneH / 900)), -1.2, 0);
    if (offset === 0) return;
    setViewState((v) => ({ ...v, zoom: meta.zoom + offset }));
  }, [meta.zoom]);

  // One camera object, two controlled maps — dragging either half writes here
  // and both halves re-read it on the same commit. No echo guard needed: the
  // callback carries the camera it produced, so a round trip is a no-op.
  const onViewStateChange = useCallback((v: SplitViewState) => setViewState(v), []);

  // Both shells are handed `viewStateOverride={null}`, which tells them this
  // view owns the camera and stops two listeners fighting over one fly-to.
  useEffect(() => {
    const onFly = (e: Event) => {
      const d = (e as CustomEvent<FlyToDetail>).detail;
      if (!d) return;
      setViewState((v) => ({
        ...v,
        longitude: d.center[0],
        latitude: d.center[1],
        zoom: d.zoom ?? v.zoom,
      }));
    };
    window.addEventListener(EGRESS_FLYTO_EVENT, onFly);
    return () => window.removeEventListener(EGRESS_FLYTO_EVENT, onFly);
  }, []);

  const frozen = t >= meta.burnoverAt;

  // Stop the clock exactly once on the crossing. Clamping every frame would
  // fight the scrubber and make the timeline un-draggable past burnover.
  const prevT = useRef(t);
  useEffect(() => {
    if (prevT.current < meta.burnoverAt && t >= meta.burnoverAt) actions.setPlaying(false);
    prevT.current = t;
  }, [t, meta.burnoverAt]);

  const baseline = bundle?.baseline ?? null;
  const planned = bundle?.planned ?? null;

  const delta = useMemo(() => {
    if (!baseline || !planned) return null;
    return planned.summary.clearanceTime - baseline.summary.clearanceTime;
  }, [baseline, planned]);

  return (
    <div className={cx("flex h-full min-h-0 flex-col", className)}>
      {/* Stacked, not side by side. Two panes inside a 960-wide map plane are
          476x1028 each — aspect 0.46, an unreadable sliver of a town. Stacked
          they are 960x510, aspect 1.88 against the 1.78 the cameras were
          authored for, both left edges align so the eye reads down one column,
          and the burnover verdict's 495px min-content headline fits. */}
      <div ref={gridRef} className="relative grid min-h-0 flex-1 grid-rows-2 gap-2 p-2">
        <SplitHalf
          runKind="baseline"
          label="Baseline — what happened"
          accent="hazard"
          run={baseline}
          scenario={meta}
          viewState={viewState}
          onViewStateChange={onViewStateChange}
          frozen={frozen}
          overlay={renderOverlay?.("baseline", meta)}
        />
        <SplitHalf
          runKind="planned"
          label="Planned — staged release"
          accent="plan"
          run={planned}
          scenario={meta}
          viewState={viewState}
          onViewStateChange={onViewStateChange}
          frozen={frozen}
          overlay={renderOverlay?.("planned", meta)}
        />

        {/* The camera lock, stated out loud in the middle of the seam. The
            seam is horizontal now, so the chip sits on it. */}
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <div className="glass flex items-center gap-1.5 px-2 py-1">
            <Lock size={11} strokeWidth={1.75} className="text-faint" />
            <span className="label-mono">Cameras locked</span>
            <span className="readout text-[10px] text-subtle">{formatTick(t, false)}</span>
          </div>
        </div>

        {frozen && (
          <BurnoverOverlay
            baseline={baseline}
            planned={planned}
            burnoverAt={meta.burnoverAt}
            delta={delta}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function SplitHalf({
  runKind,
  label,
  accent,
  run,
  scenario,
  viewState,
  onViewStateChange,
  frozen,
  overlay,
}: {
  runKind: RunKind;
  label: string;
  accent: "hazard" | "plan";
  run: SimulationRun | null;
  scenario: ScenarioMeta;
  viewState: SplitViewState;
  onViewStateChange: (v: SplitViewState) => void;
  frozen: boolean;
  overlay?: ReactNode;
}) {
  const t = useEgress(selT);
  const frame = run ? frameAt(run, t) : null;
  const accentText = accent === "hazard" ? "text-hazard-text" : "text-plan-text";
  const accentBg = accent === "hazard" ? "bg-hazard" : "bg-plan";

  return (
    <div
      className={cx(
        "relative min-h-0 overflow-hidden rounded-lg border border-hairline bg-sunken transition-[filter] duration-500",
        frozen && "saturate-[0.4] brightness-[0.7]",
      )}
    >
      {/* Both halves stay interactive: the lock is the shared controlled camera,
          not a disabled follower, so the presenter can grab either one. */}
      <MapShell
        key={`${scenario.id}-${runKind}`}
        scenario={scenario}
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        viewStateOverride={null}
      >
        {overlay}
      </MapShell>

      {!run && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="glass px-3 py-1.5 text-[11.5px] text-faint">
            {runKind} run not computed yet
          </span>
        </div>
      )}

      {/* header */}
      <div className="glass pointer-events-none absolute inset-x-2 top-2 z-10 flex items-center gap-2.5 px-3 py-2">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", accentBg)} />
        {/* A dot, a label and one readout. The sentences that used to sit here
            are running text in the ARGUMENT band, which is already saying
            exactly this — words belong in the panel, pictures in the map. */}
        <div className={cx("label-mono min-w-0 flex-1 truncate", accentText)}>{label}</div>
        <div className="shrink-0 text-right">
          <div className="label-mono">Clearance</div>
          <div className={cx("readout text-[18px] leading-none", accentText)}>
            {run ? formatDuration(run.summary.clearanceTime) : "—:—"}
          </div>
        </div>
      </div>

      {/* footer KPI pair */}
      <div className="glass pointer-events-none absolute inset-x-2 bottom-2 z-10 grid grid-cols-2 divide-x divide-hairline">
        <Kpi
          label="In hazard at burnover"
          value={run ? formatCount(run.summary.vehiclesInHazardAtBurnover) : "—"}
          unit="veh"
          alarm={accent === "hazard"}
        />
        <Kpi
          label="Peak queue"
          value={run ? formatDistance(run.summary.peakQueueLength) : "—"}
          unit={frame ? `${formatCount(frame.vehiclesMoving)} moving now` : ""}
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  alarm,
}: {
  label: string;
  value: string;
  unit?: string;
  alarm?: boolean;
}) {
  return (
    <div className="px-3 py-2">
      <div className="label-mono">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={cx("readout text-[15px]", alarm ? "text-hazard-text" : "text-foreground")}>
          {value}
        </span>
        {unit && <span className="text-[10px] text-faint">{unit}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The freeze. This is the payload of the whole presentation, so it gets the
// weight: the clock stops, both maps recede, and the two clearance times sit
// alone in the middle of the screen.
// ─────────────────────────────────────────────────────────────────────────────

function BurnoverOverlay({
  baseline,
  planned,
  burnoverAt,
  delta,
}: {
  baseline: SimulationRun | null;
  planned: SimulationRun | null;
  burnoverAt: number;
  delta: number | null;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[rgba(4,6,10,0.62)] backdrop-blur-[3px]">
      <div className="label-mono mb-1 !text-hazard-text">
        Burnover — {formatTick(burnoverAt, false)}
      </div>
      <div className="mb-7 text-[12px] text-subtle">
        The hazard has overrun the last occupied egress route.
      </div>

      <div className="flex items-end gap-10">
        <Headline
          label="Baseline"
          value={baseline ? formatDuration(baseline.summary.clearanceTime) : "—:—"}
          support={
            baseline
              ? `${formatCount(baseline.summary.vehiclesInHazardAtBurnover)} vehicles still in the hazard`
              : "run not computed"
          }
          tone="hazard"
        />
        <div className="pb-9 text-center">
          <div className="label-mono">Clearance delta</div>
          <div className="readout text-[26px] leading-none text-foreground">
            {delta === null ? "—" : formatDelta(delta)}
          </div>
        </div>
        <Headline
          label="Planned"
          value={planned ? formatDuration(planned.summary.clearanceTime) : "—:—"}
          support={
            planned
              ? `${formatCount(planned.summary.vehiclesInHazardAtBurnover)} vehicles still in the hazard`
              : "run not computed"
          }
          tone="plan"
        />
      </div>

      <div className="mt-8 max-w-[520px] text-center text-[11px] leading-relaxed text-faint">
        Clearance time is when the <em>last</em> household reaches a sink. Egress claims hours and
        vehicles exposed. It does not claim lives.
      </div>
    </div>
  );
}

function Headline({
  label,
  value,
  support,
  tone,
}: {
  label: string;
  value: string;
  support: string;
  tone: "hazard" | "plan";
}) {
  const color = tone === "hazard" ? "text-hazard-text" : "text-plan-text";
  return (
    <div className="text-center">
      <div className={cx("label-mono mb-1.5", color)}>{label}</div>
      <div className={cx("readout text-[72px] leading-[0.86] tracking-tight", color)}>{value}</div>
      <div className="mt-2.5 text-[11px] text-subtle">{support}</div>
    </div>
  );
}

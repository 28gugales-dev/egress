"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { frameAt, summaryFor } from "@/lib/derive";
import { clamp, cx, formatCount, formatDelta, formatDuration } from "@/lib/format";
import { selParams, selScenarioId, selT, selView, useEgress } from "@/lib/store";
import type { SimulationRun, ViewMode } from "@/types/egress";

const EM_DASH = "—";
const TWEEN_MS = 120;

/**
 * Which run the time-varying cells read. Duplicated in scrubber.tsx on purpose —
 * neither file owns a shared module, and a three-line fork beats reaching into
 * a file another agent owns.
 */
function activeRun(
  view: ViewMode,
  baseline: SimulationRun | null,
  planned: SimulationRun | null,
): SimulationRun | null {
  if (view === "baseline") return baseline ?? planned;
  return planned ?? baseline;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Counts up to a new figure instead of snapping. A KPI that jumps reads as a
 * page reload; a KPI that moves reads as an instrument tracking something real.
 * Snaps when the previous value was absent — tweening up from a placeholder
 * would invent a number that was never true.
 */
function useTweenedNumber(target: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(target);
  const fromRef = useRef<number | null>(target);
  const rafRef = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    const from = fromRef.current;
    if (target === null || from === null || !Number.isFinite(from) || prefersReducedMotion()) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    if (from === target) return;
    const start = performance.now();
    const step = (now: number) => {
      const p = clamp((now - start) / TWEEN_MS, 0, 1);
      const eased = 1 - (1 - p) * (1 - p);
      const v = from + (target - from) * eased;
      // Held so an interrupted tween resumes from what is on screen, not from
      // the value it was originally chasing.
      fromRef.current = p < 1 ? v : target;
      setDisplay(p < 1 ? v : target);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  return display;
}

interface CellProps {
  caption: string;
  value: string;
  tone?: string;
  pulse?: boolean;
  divider?: boolean;
}

function Cell({ caption, value, tone, pulse, divider }: CellProps) {
  return (
    <div
      className={cx(
        "flex min-w-0 flex-1 flex-col justify-center gap-px px-2 py-0.5",
        divider && "border-hairline border-l",
      )}
    >
      <span className="label-mono whitespace-nowrap [letter-spacing:0.08em]">{caption}</span>
      <span className="flex items-center gap-1.5">
        {pulse ? (
          <span
            className="pulse-critical h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: "var(--hazard)" }}
            aria-hidden="true"
          />
        ) : null}
        <span className="readout truncate" style={{ fontSize: 17, color: tone }}>
          {value}
        </span>
      </span>
    </div>
  );
}

export function KpiStrip({ className }: { className?: string }) {
  const t = useEgress(selT);
  const view = useEgress(selView);
  const params = useEgress(selParams);
  const bundle = useBundle();

  const baseline = bundle?.baseline ?? null;
  const planned = bundle?.planned ?? null;
  const grid = bundle?.grid ?? null;
  const run = activeRun(view, baseline, planned);

  const frame = useMemo(() => (run ? frameAt(run, t) : null), [run, t]);

  /**
   * Parameter-driven figures come from the sweep, not from `run.summary` —
   * a run's summary describes the params it was solved at, so the moment a
   * slider moves it is the wrong number. Baseline view is the exception: it
   * replays a fixed set of orders, so its own summary is the honest source.
   */
  const swept = useMemo(
    () => (view !== "baseline" && grid ? summaryFor(grid, params) : null),
    [view, grid, params],
  );
  const fixed = view === "baseline" ? (baseline?.summary ?? null) : null;
  const headline = swept ?? fixed;

  const clearance = headline?.clearanceTime ?? null;
  const inHazard = frame?.vehiclesInHazard ?? null;
  const evacuated = frame?.peopleCleared ?? null;
  const delta = swept && baseline ? swept.clearanceTime - baseline.summary.clearanceTime : null;

  const dClearance = useTweenedNumber(clearance);
  const dInHazard = useTweenedNumber(inHazard);
  const dEvacuated = useTweenedNumber(evacuated);
  const dDelta = useTweenedNumber(delta);

  const exposed = (dInHazard ?? 0) > 0;

  return (
    <div
      className={cx("glass flex w-full items-stretch overflow-hidden py-1 pr-1 pl-1", className)}
    >
      <Cell caption="Clear" value={dClearance === null ? EM_DASH : formatDuration(dClearance)} />
      <Cell
        caption="Exposed"
        value={dInHazard === null ? EM_DASH : formatCount(dInHazard)}
        tone={exposed ? "var(--hazard-text)" : undefined}
        pulse={exposed}
        divider
      />
      <Cell caption="Out" value={dEvacuated === null ? EM_DASH : formatCount(dEvacuated)} divider />
      <Cell
        caption="vs base"
        value={dDelta === null ? EM_DASH : formatDelta(dDelta)}
        tone={dDelta === null ? undefined : dDelta <= 0 ? "var(--ok)" : "var(--hazard-text)"}
        divider
      />
    </div>
  );
}

/**
 * The scenario chip is its own island. Inside the KPI strip it took roughly a
 * third of the width, which left the four readouts too narrow for their own
 * captions once the bar stopped spanning the window.
 */
export function ScenarioChip({ className }: { className?: string }) {
  const scenarioId = useEgress(selScenarioId);
  const meta = useMemo(() => getScenario(scenarioId), [scenarioId]);

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("egress:open-scenarios"))}
      aria-label="Change scenario"
      className={cx("glass flex items-center gap-1.5 px-2.5 py-2", className)}
    >
      <span
        className="pulse-critical h-1.5 w-1.5 flex-none rounded-full"
        style={{ background: "var(--hazard)" }}
        aria-hidden="true"
      />
      <span className="panel-title whitespace-nowrap">{meta.name}</span>
      <span className="label-mono whitespace-nowrap">{meta.eventDate}</span>
      <ChevronDown size={13} strokeWidth={1.75} className="text-faint" />
    </button>
  );
}

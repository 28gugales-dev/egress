"use client";

import { Pause, Play } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useBundle } from "@/lib/bundle-context";
import { getScenario } from "@/lib/constants";
import { clamp, cx, formatTick, formatWallClock } from "@/lib/format";
import {
  actions,
  selPlaying,
  selScenarioId,
  selSpeed,
  selT,
  selView,
  useEgress,
} from "@/lib/store";
import type { HazardTrack, LngLat, SimulationRun, Tick, ViewMode } from "@/types/egress";

const SPEEDS = [1, 30, 60, 120];

/**
 * Ceiling on the real-time delta a single rAF step may represent. Without it a
 * backgrounded tab resumes with a multi-second delta and, at 120x, teleports
 * the playhead past the end of the run in a single frame.
 */
const MAX_REAL_DT = 0.1;

/** Minimum horizontal gap, in percent of track width, between two captions. */
const MIN_CAPTION_GAP = 7.5;

type MarkKind = "ignition" | "wave" | "contraflow" | "burnover";

interface Mark {
  /** Stable identity. Two contraflow orders can share an activateAt, so kind
   *  and t alone are not unique and one tick would silently disappear. */
  id: string;
  t: Tick;
  label: string;
  kind: MarkKind;
}

interface ProvenanceSegment {
  from: Tick;
  to: Tick;
  observed: boolean;
}

/**
 * Which run drives the event ticks. Duplicated in kpi-strip.tsx on purpose —
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

/** Shoelace on a local equirectangular projection. Units are arbitrary — the
 *  sparkline only ever shows area relative to the run's own maximum. */
function ringArea(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const k = Math.cos((ring[0][1] * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * k * ring[i][1] - ring[i][0] * k * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

/** Area chart of hazard footprint growth in a 0..100 square. Drawn with
 *  preserveAspectRatio="none" so it stretches to the track without measuring. */
function hazardSparkPath(hazard: HazardTrack | null, duration: Tick): string {
  const frames = hazard?.frames;
  if (!frames || frames.length < 2 || duration <= 0) return "";
  const areas = frames.map((f) => f.rings.reduce((a, r) => a + ringArea(r), 0));
  let max = 0;
  for (const a of areas) if (a > max) max = a;
  if (!(max > 0)) return "";
  let d = "M 0 100";
  for (let i = 0; i < frames.length; i++) {
    const x = clamp((frames[i].t / duration) * 100, 0, 100);
    const y = 100 - (areas[i] / max) * 100;
    d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${d} L 100 100 Z`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function Scrubber({ className }: { className?: string }) {
  const t = useEgress(selT);
  const playing = useEgress(selPlaying);
  const speed = useEgress(selSpeed);
  const view = useEgress(selView);
  const scenarioId = useEgress(selScenarioId);
  const bundle = useBundle();

  const meta = useMemo(() => getScenario(scenarioId), [scenarioId]);
  const { duration, frameStep, burnoverAt, eventDate, startHourLocal } = meta;

  const run = activeRun(view, bundle?.baseline ?? null, bundle?.planned ?? null);
  const hazard = bundle?.hazard ?? null;

  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const resumeRef = useRef(false);
  // Read inside the keydown listener so stepping does not re-register the
  // window handler on every one of the 30+ store writes a second while playing.
  const tRef = useRef(t);
  tRef.current = t;

  // ── clock ────────────────────────────────────────────────────────────────
  // rAF, never setInterval: an interval drifts against the compositor and ends
  // up writing t twice inside one paint.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, MAX_REAL_DT);
      last = now;
      actions.advance(dt * speed, duration);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, duration]);

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
        return;
      }
      const jump = (d: Tick) => {
        e.preventDefault();
        actions.setT(clamp(tRef.current + d, 0, duration));
      };
      switch (e.key) {
        case " ":
        case "Spacebar":
          // A focused button already fires its own click on Space; toggling
          // here as well would cancel it out.
          if (tag === "BUTTON") return;
          e.preventDefault();
          actions.togglePlay();
          return;
        case "ArrowLeft":
          jump(e.shiftKey ? -10 * frameStep : -frameStep);
          return;
        case "ArrowRight":
          jump(e.shiftKey ? 10 * frameStep : frameStep);
          return;
        case "Home":
          e.preventDefault();
          actions.setT(0);
          return;
        case "End":
          e.preventDefault();
          actions.setT(duration);
          return;
        default:
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration, frameStep]);

  // ── seeking ──────────────────────────────────────────────────────────────
  const seek = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return;
      actions.setT(clamp((clientX - r.left) / r.width, 0, 1) * duration);
    },
    [duration],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      // Scrubbing against a running clock fights the rAF loop, so park playback
      // and hand it back on release.
      resumeRef.current = playing;
      if (playing) actions.setPlaying(false);
      seek(e.clientX);
    },
    [playing, seek],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) seek(e.clientX);
    },
    [seek],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (resumeRef.current) actions.setPlaying(true);
    resumeRef.current = false;
  }, []);

  // ── derived geometry ─────────────────────────────────────────────────────
  const sparkPath = useMemo(() => hazardSparkPath(hazard, duration), [hazard, duration]);

  const provenance = useMemo<ProvenanceSegment[]>(() => {
    const frames = hazard?.frames;
    if (!frames?.length) return [];
    const segs: ProvenanceSegment[] = [];
    for (const f of frames) {
      const observed = f.provenance === "observed";
      const last = segs[segs.length - 1];
      if (last && last.observed === observed) last.to = f.t + frameStep;
      else segs.push({ from: f.t, to: f.t + frameStep, observed });
    }
    return segs;
  }, [hazard, frameStep]);

  const marks = useMemo<Mark[]>(() => {
    const out: Omit<Mark, "id">[] = [{ t: 0, label: "Ignition", kind: "ignition" }];
    const plan = run?.plan;
    if (plan) {
      for (const w of plan.waves) {
        out.push({ t: w.departAt, label: `Wave ${w.wave}`, kind: "wave" });
      }
      for (const c of plan.contraflow) {
        out.push({ t: c.activateAt, label: truncate(c.label, 16), kind: "contraflow" });
      }
    }
    out.push({ t: burnoverAt, label: "Burnover", kind: "burnover" });
    return out
      .filter((m) => m.t >= 0 && m.t <= duration)
      .sort((a, b) => a.t - b.t)
      .map((m, i) => ({ ...m, id: `${m.kind}-${m.t}-${i}` }));
  }, [run, burnoverAt, duration]);

  /** Ids of the captions that survive collision. Ignition and burnover are
   *  placed first so a dense cluster of waves cannot evict either landmark. */
  const captionShown = useMemo(() => {
    const pcts = marks.map((m) => (duration > 0 ? (m.t / duration) * 100 : 0));
    const shown = new Set<string>();
    const placed: number[] = [];
    const rank = (k: MarkKind) => (k === "burnover" ? 0 : k === "ignition" ? 1 : 2);
    const order = marks
      .map((_, i) => i)
      .sort((a, b) => {
        const d = rank(marks[a].kind) - rank(marks[b].kind);
        return d !== 0 ? d : marks[a].t - marks[b].t;
      });
    for (const i of order) {
      if (placed.every((q) => Math.abs(pcts[i] - q) >= MIN_CAPTION_GAP)) {
        shown.add(marks[i].id);
        placed.push(pcts[i]);
      }
    }
    return shown;
  }, [marks, duration]);

  const pct = duration > 0 ? clamp((t / duration) * 100, 0, 100) : 0;
  const anchor = (p: number) => `translateX(${p < 6 ? 0 : p > 94 ? -100 : -50}%)`;

  return (
    <div className={cx("glass flex w-full flex-col gap-1 px-2.5 py-1.5", className)}>
      {/* transport */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => actions.togglePlay()}
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          className="glass-inset glass-inset-hover flex h-7 w-7 flex-none items-center justify-center text-foreground"
        >
          {playing ? <Pause size={14} strokeWidth={1.75} /> : <Play size={14} strokeWidth={1.75} />}
        </button>

        <div className="flex flex-none items-baseline gap-2.5">
          <span className="readout text-foreground" style={{ fontSize: 15 }}>
            {formatTick(t)}
          </span>
          <span className="label-mono">{formatWallClock(eventDate, t, startHourLocal)}</span>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center"></div>

        <div className="seg flex-none">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              data-on={speed === s}
              onClick={() => actions.setSpeed(s)}
              aria-label={`${s} times speed`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      {/* Provenance band. One observed perimeter, 96 interpolated — saying so
          in the timeline is the point; hiding it would be the lie. */}
      <div className="relative h-3 w-full">
        <div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-full bg-glass-inset">
          {provenance.map((s) => (
            <div
              key={`prov-${s.from}`}
              className="absolute top-0 bottom-0"
              style={{
                left: `${(s.from / duration) * 100}%`,
                width: `${((s.to - s.from) / duration) * 100}%`,
                minWidth: s.observed ? 3 : undefined,
                background: s.observed ? "var(--plan)" : "var(--hairline-strong)",
              }}
            />
          ))}
        </div>
        {provenance.length > 0 && (
          <span className="label-mono absolute bottom-[5px] left-0">Modelled</span>
        )}
        {provenance
          .filter((s) => s.observed)
          .map((s) => {
            const c = (((s.from + s.to) / 2 / duration) * 100) as number;
            return (
              <span
                key={`obs-${s.from}`}
                className="label-mono absolute bottom-[5px] whitespace-nowrap text-plan-text"
                style={{ left: `${c}%`, transform: anchor(c) }}
              >
                Observed
              </span>
            );
          })}
      </div>

      {/* track */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Scenario time"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round(t)}
        aria-valuetext={formatTick(t)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="glass-inset relative h-7 w-full cursor-pointer overflow-hidden"
        style={{ touchAction: "none", userSelect: "none" }}
      >
        {/* Hazard growth behind everything: the fire's acceleration, legible in
            the timeline itself rather than only on the map. */}
        {sparkPath ? (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={sparkPath} fill="var(--hazard-dim)" />
            <path
              d={sparkPath}
              fill="none"
              stroke="var(--hazard)"
              strokeOpacity={0.45}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : null}

        <div
          className="pointer-events-none absolute inset-y-0 left-0"
          style={{ width: `${pct}%`, background: "var(--plan-dim)" }}
        />

        {marks.map((m) => {
          const p = duration > 0 ? (m.t / duration) * 100 : 0;
          const burn = m.kind === "burnover";
          return (
            <div
              key={`tick-${m.id}`}
              className="pointer-events-none absolute inset-y-0"
              style={{
                left: `${p}%`,
                width: burn ? 2 : 1,
                marginLeft: burn ? -1 : 0,
                background: burn ? "var(--hazard)" : "var(--hairline-strong)",
              }}
            />
          );
        })}

        <div
          className="pointer-events-none absolute inset-y-0"
          style={{
            left: `${pct}%`,
            width: 2,
            marginLeft: -1,
            background: "var(--hazard)",
            boxShadow: "0 0 8px var(--hazard-glow)",
          }}
        >
          <span
            className="absolute top-0 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rotate-45"
            style={{ background: "var(--hazard)" }}
          />
        </div>
      </div>

      {/* captions */}
      <div className="relative h-3 w-full">
        {marks.map((m) => {
          if (!captionShown.has(m.id)) return null;
          const p = duration > 0 ? (m.t / duration) * 100 : 0;
          const burn = m.kind === "burnover";
          return (
            <span
              key={`cap-${m.id}`}
              className={cx(
                "label-mono absolute top-0 whitespace-nowrap",
                // Wave and contraflow captions overlap once the bar is an
                // island rather than a full-width band. The marks stay; only
                // the two that carry the story keep their text.
                m.kind !== "ignition" && m.kind !== "burnover" && "hidden",
                burn && "text-hazard-text",
              )}
              style={{
                left: `${p}%`,
                transform: anchor(p),
                fontWeight: burn ? 700 : undefined,
              }}
            >
              {m.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

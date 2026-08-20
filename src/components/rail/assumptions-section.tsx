"use client";

import { RotateCcw } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { formatPercent, formatShort } from "@/lib/format";
import { actions, selParams, useEgress } from "@/lib/store";

interface SliderRowProps {
  label: string;
  /** Canonical store value — fractions and seconds, never display units. */
  value: number;
  min: number;
  max: number;
  step: number;
  display: (v: number) => string;
  caption?: string;
  onCommit: (v: number) => void;
}

/**
 * Local mirror + ~16ms trailing throttle. The thumb has to track the pointer at
 * 60fps, but every store write re-renders the whole deck.gl layer stack, so the
 * store gets at most one write per frame — and always the newest value, so the
 * committed number is exactly where the thumb stopped.
 */
function SliderRow({ label, value, min, max, step, display, caption, onCommit }: SliderRowProps) {
  const [local, setLocal] = useState(value);
  const committed = useRef(value);
  const pending = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resync only on an external write (Reset). Our own commits echo back
  // identical, so they are skipped and can never yank the thumb backwards.
  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    setLocal(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function push(v: number) {
    setLocal(v);
    pending.current = v;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      committed.current = pending.current;
      onCommit(pending.current);
    }, 16);
  }

  const pct = ((local - min) / (max - min)) * 100;

  return (
    /* Wider between sliders than inside one, so a caption is unambiguously
       attached to the control above it rather than floating between two. */
    <div className="mb-4 last:mb-1">
      {/* Half a point up on the value: JetBrains Mono sits optically smaller
          than Inter at the same size, and a value that looks smaller than its
          own label is the wrong way round. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11.5px] text-subtle">{label}</span>
        <span className="readout text-[12px] text-foreground">{display(local)}</span>
      </div>
      <input
        type="range"
        className="rng mt-1"
        min={min}
        max={max}
        step={step}
        value={local}
        aria-label={label}
        onChange={(e) => push(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as CSSProperties}
      />
      {caption ? <p className="mt-0.5 text-[10px] leading-[1.4] text-faint">{caption}</p> : null}
    </div>
  );
}

export function AssumptionsSection() {
  const params = useEgress(selParams);

  return (
    <section className="px-3 pt-[18px] pb-1">
      <div className="mb-2 flex items-center justify-between">
        <span className="label-mono">Assumptions</span>
        <button
          type="button"
          onClick={actions.resetParams}
          className="flex items-center gap-1 rounded-xs px-1 py-0.5 text-[10px] text-faint transition-colors hover:bg-glass-hover hover:text-subtle"
        >
          <RotateCcw size={13} strokeWidth={1.75} />
          Reset
        </button>
      </div>

      <SliderRow
        label="Compliance"
        value={params.compliance}
        min={0.4}
        max={1}
        step={0.01}
        display={(v) => formatPercent(v)}
        onCommit={(v) => actions.setParam("compliance", v)}
      />
      <SliderRow
        label="Shadow evac"
        value={params.shadowEvac}
        min={0}
        max={0.4}
        step={0.01}
        display={(v) => formatPercent(v)}
        caption="Households outside the order who leave anyway and clog the roads."
        onCommit={(v) => actions.setParam("shadowEvac", v)}
      />
      <SliderRow
        label="Notice time"
        value={params.noticeTime}
        min={600}
        max={5400}
        step={60}
        display={formatShort}
        onCommit={(v) => actions.setParam("noticeTime", v)}
      />
      <SliderRow
        label="Vehicles / household"
        value={params.vehiclesPerHousehold}
        min={1}
        max={2}
        step={0.05}
        display={(v) => v.toFixed(2)}
        onCommit={(v) => actions.setParam("vehiclesPerHousehold", v)}
      />
    </section>
  );
}

"use client";

import { ArrowRight, Flame, Info, MapPin, Waves, Wind, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { SCENARIOS } from "@/lib/constants";
import { cx } from "@/lib/format";
import { actions, selScenarioId, useEgress } from "@/lib/store";
import type { HazardKind, ScenarioMeta } from "@/types/egress";

const HAZARD_CHIP: Record<HazardKind, { label: string; cls: string }> = {
  wildfire: { label: "Wildfire", cls: "bg-hazard-dim text-hazard-text" },
  plume: { label: "Chemical plume", cls: "bg-warn-dim text-warn-text" },
  flood: { label: "Flood", cls: "bg-plan-dim text-plan-text" },
};

function HazardIcon({ kind }: { kind: HazardKind }) {
  const props = { size: 13, strokeWidth: 1.75 } as const;
  if (kind === "wildfire") return <Flame {...props} />;
  if (kind === "plume") return <Wind {...props} />;
  return <Waves {...props} />;
}

function formatEventDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function ScenarioCard({
  scenario,
  active,
  onPick,
}: {
  scenario: ScenarioMeta;
  active: boolean;
  onPick: () => void;
}) {
  const chip = HAZARD_CHIP[scenario.hazardKind];
  const disabled = !scenario.available;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className={cx(
        "glass-inset group flex flex-col items-start gap-2 p-4 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-45" : "glass-inset-hover cursor-pointer",
        active && "border-hairline-strong",
      )}
      style={active ? { boxShadow: "inset 0 0 0 1px var(--plan)" } : undefined}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="panel-title truncate">{scenario.name}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-faint">
            <MapPin size={12} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">{scenario.place}</span>
          </div>
        </div>
        <span
          className={cx(
            "flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-[10.5px] font-medium",
            chip.cls,
          )}
        >
          <HazardIcon kind={scenario.hazardKind} />
          {chip.label}
        </span>
      </div>

      <div className="readout text-[11px] text-subtle">{formatEventDate(scenario.eventDate)}</div>

      <p className="text-[12px] leading-relaxed text-subtle">{scenario.blurb}</p>

      <div className="mt-auto flex w-full items-start justify-between gap-3 pt-2">
        <span className="label-mono leading-[1.6]">{scenario.provingPoint}</span>
        {disabled ? (
          <span className="shrink-0 text-[11px] text-faint">data not built</span>
        ) : (
          <ArrowRight
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
          />
        )}
      </div>
    </button>
  );
}

function CustomCard() {
  const inputId = useId();
  const [town, setTown] = useState("");
  const [attempted, setAttempted] = useState<string | null>(null);

  return (
    <form
      className="glass-inset flex flex-col gap-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const value = town.trim();
        if (!value) return;
        setAttempted(value);
      }}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div>
          <div className="panel-title">Custom town</div>
          <div className="mt-0.5 text-[11.5px] text-faint">Live pull, any US place</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-sm bg-glass-inset px-2 py-1 text-[10.5px] font-medium text-faint">
          <Info size={13} strokeWidth={1.75} />
          Not wired
        </span>
      </div>

      <p className="text-[12px] leading-relaxed text-subtle">
        A custom scenario runs the same pipeline live: Overpass for roads, ACS for population, HIFLD
        for facilities, then the solver. Nothing here is precomputed.
      </p>

      <label className="label-mono mt-1" htmlFor={inputId}>
        Town name
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          value={town}
          onChange={(e) => setTown(e.target.value)}
          placeholder="Grass Valley, CA"
          className="min-w-0 flex-1 rounded-sm border border-hairline bg-glass-inset px-2.5 py-1.5 text-[12.5px] text-foreground placeholder:text-faint focus:border-hairline-strong focus:outline-none"
        />
        <button
          type="submit"
          disabled={town.trim().length === 0}
          className="shrink-0 rounded-sm border border-hairline bg-glass-inset px-3 py-1.5 text-[12px] text-subtle transition-colors hover:bg-glass-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          Build
        </button>
      </div>

      {attempted ? (
        <p className="text-[11.5px] leading-relaxed text-warn-text">
          The live pipeline is not wired into the console yet, so nothing was fetched for{" "}
          <span className="readout">{attempted}</span>. Build it from a terminal instead:{" "}
          <span className="readout text-foreground">pnpm data:all &lt;scenario-id&gt;</span>, then
          add the scenario to SCENARIOS. Showing a fake result here would be worse than showing
          none.
        </p>
      ) : null}
    </form>
  );
}

export interface ScenarioPickerProps {
  open: boolean;
  onClose: () => void;
}

export function ScenarioPicker({ open, onClose }: ScenarioPickerProps) {
  const scenarioId = useEgress(selScenarioId);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Close scenario picker"
        onClick={onClose}
        className="glass-scrim absolute cursor-default"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-deep lg-surface sheet relative flex max-h-[86dvh] w-full max-w-[880px] flex-col overflow-hidden focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
          <div>
            <h2 className="panel-title">Scenario</h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              Each one replays a real event from archived perimeters, census vintage and road
              geometry. Nothing is synthesized.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-sm p-1 text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>

        <div className="thin-scroll grid grid-cols-1 gap-3 overflow-y-auto p-6 md:grid-cols-2">
          {SCENARIOS.map((s) => (
            <ScenarioCard
              key={s.id}
              scenario={s}
              active={s.id === scenarioId}
              onPick={() => {
                if (s.id !== scenarioId) actions.setScenario(s.id);
                onClose();
              }}
            />
          ))}
          <CustomCard />
        </div>
      </div>
    </div>
  );
}

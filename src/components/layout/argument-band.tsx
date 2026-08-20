"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { useBundle } from "@/lib/bundle-context";
import { cx, formatCount, formatDelta, formatDistance, formatDuration } from "@/lib/format";
import { layoutActions, selArgument, useLayout } from "@/lib/layout-store";

/**
 * Band 2 — what doing nothing costs against what this plan does.
 *
 * SOURCE DISCIPLINE, and it is the most important rule in this file: every
 * figure here comes from a SOLVED run summary — `baseline.summary` and
 * `planned.summary` — and never from the swept parameter grid. DEFAULT_PARAMS
 * (compliance 0.72, shadowEvac 0.18) sit off the grid's axis nodes, so a swept
 * figure is always a 4-D interpolation and can never equal the plan's solved
 * 13,500s. Reading the grid here is what produced a console saying 3:46 four
 * inches from a pane saying 3:45. The interpolated figure lives in the CONTROL
 * pane instead, beside the sliders that move it.
 */

const EM_DASH = "—";

/** "8 November 2018" from an ISO date, parsed as UTC so the day never slips. */
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

/**
 * One column of the comparison, placed onto the band's SHARED rows.
 *
 * Not a flex column any more, and the reason is the whole point of the band.
 * `flex flex-col justify-center` centred each column against its own content,
 * and the right column carries three sub-lines against the left column's two —
 * so justify-center lifted the entire right stack and the two numbers the
 * product exists to compare, 9:30 and 3:45, sat 7.5px out of register at the
 * same 34px size. On an instrument whose own brief says jittering numerals read
 * as amateur, that was the two most-looked-at numerals on the screen.
 *
 * Each part is placed explicitly into row 1 (label), row 2 (value) or row 3
 * (sub-lines) of the parent grid, and the parent baseline-aligns each row, so
 * the three columns share a baseline whatever they contain and whatever size
 * the numeral is.
 */
function Column({
  col,
  label,
  labelTone,
  value,
  valueTone,
  size,
  lines,
  align = "left",
}: {
  col: number;
  label: string;
  labelTone?: string;
  value: string;
  valueTone?: string;
  size: number;
  lines: { id: string; text: string }[];
  align?: "left" | "center";
}) {
  const justify = align === "center" ? "center" : "stretch";
  return (
    <>
      <span
        className="label-mono min-w-0 truncate"
        style={{
          gridColumn: col,
          gridRow: 1,
          justifySelf: justify,
          ...(labelTone ? { color: labelTone } : null),
        }}
      >
        {label}
      </span>
      <span
        className="readout mt-1 leading-[0.92]"
        style={{
          gridColumn: col,
          gridRow: 2,
          justifySelf: justify,
          fontSize: size,
          color: valueTone ?? "var(--foreground)",
        }}
      >
        {value}
      </span>
      <div
        className={cx("mt-1.5 flex min-w-0 flex-col gap-px", align === "center" && "items-center")}
        style={{ gridColumn: col, gridRow: 3, justifySelf: justify }}
      >
        {lines.map((l) => (
          <span key={l.id} className="truncate text-[10.5px] leading-[14px] text-faint">
            {l.text}
          </span>
        ))}
      </div>
    </>
  );
}

export function ArgumentBand({ compact = false }: { compact?: boolean }) {
  const argument = useLayout(selArgument);
  const bundle = useBundle();
  const [narrativeOpen, setNarrativeOpen] = useState(false);

  const baseline = bundle?.baseline ?? null;
  const planned = bundle?.planned ?? null;
  const b = baseline?.summary ?? null;
  const p = planned?.summary ?? null;
  const delta = b && p ? p.clearanceTime - b.clearanceTime : null;

  const baseClear = b ? formatDuration(b.clearanceTime) : EM_DASH;
  const planClear = p ? formatDuration(p.clearanceTime) : EM_DASH;
  const deltaText = delta === null ? EM_DASH : formatDelta(delta);

  if (argument === "strip") {
    return (
      <button
        type="button"
        onClick={() => layoutActions.setArgument("full")}
        aria-expanded={false}
        className="flex h-[34px] flex-none cursor-pointer items-center gap-3 px-3 text-left transition-colors hover:bg-glass-hover"
      >
        <span className="label-mono">Do nothing → this plan</span>
        <span className="readout text-[13px]" style={{ color: "var(--hazard-text)" }}>
          {baseClear}
        </span>
        <span className="text-faint">→</span>
        <span className="readout text-[13px]" style={{ color: "var(--plan-text)" }}>
          {planClear}
        </span>
        <span className="readout text-[13px] text-foreground">{deltaText}</span>
        <ChevronDown size={13} strokeWidth={1.75} className="ml-auto text-faint" />
      </button>
    );
  }

  const waves = planned?.plan.waves.length ?? 0;
  const validation = baseline?.validation ?? null;
  const meta = bundle?.meta ?? null;

  /* Fixed height, so band 3 below it gets the same slot every time. A band
     that resizes with its own content is a band the operator has to re-find. */
  const height = (compact ? 176 : 156) + (narrativeOpen ? 70 : 0);

  return (
    <div className="flex flex-none flex-col justify-center px-3 py-2" style={{ height }}>
      {/* Baseline-aligned rows, not three self-centring stacks. */}
      <div
        className="grid items-baseline gap-x-3"
        style={{
          // In a narrow column the two runs go side by side and the delta drops
          // full width beneath them; the comparison survives, the three-across
          // row does not.
          gridTemplateColumns: compact ? "minmax(0,1fr) minmax(0,1fr)" : "340px 232px 1fr",
          gridTemplateRows: compact ? "auto auto 1fr auto" : "auto auto 1fr",
        }}
      >
        <Column
          col={1}
          label="Do nothing — one order, no staging"
          labelTone="var(--hazard-text)"
          value={baseClear}
          valueTone="var(--hazard-text)"
          size={34}
          lines={[
            {
              id: "exposure",
              text: b
                ? `${formatCount(b.vehiclesInHazardAtBurnover)} vehicles caught at burnover`
                : EM_DASH,
            },
            { id: "queue", text: b ? `peak queue ${formatDistance(b.peakQueueLength)}` : EM_DASH },
          ]}
        />

        {compact ? null : (
          <Column
            col={2}
            label="Clearance saved"
            value={deltaText}
            size={30}
            align="center"
            lines={[
              { id: "roads", text: "no new roads" },
              { id: "vehicles", text: "no new vehicles" },
            ]}
          />
        )}

        <Column
          col={compact ? 2 : 3}
          label={`This plan — ${waves} staged wave${waves === 1 ? "" : "s"}`}
          labelTone="var(--plan-text)"
          value={planClear}
          valueTone="var(--plan-text)"
          size={34}
          lines={[
            {
              id: "exposure",
              text: p
                ? `${formatCount(p.vehiclesInHazardAtBurnover)} vehicles caught at burnover`
                : EM_DASH,
            },
            { id: "queue", text: p ? `peak queue ${formatDistance(p.peakQueueLength)}` : EM_DASH },
            // What actually changed, as running text. It used to be a bar under
            // the compare panes, where it competed with the maps for the same
            // glance and was invisible from every other view.
            {
              id: "changed",
              text: planned
                ? `${planned.plan.contraflow.length} corridors reversed · ${planned.plan.manifests.length} vehicles dispatched`
                : EM_DASH,
            },
          ]}
        />

        {compact ? (
          <div
            className="flex items-baseline gap-2 border-hairline border-t pt-1.5"
            style={{ gridColumn: "1 / -1", gridRow: 4 }}
          >
            <span className="label-mono">Clearance saved</span>
            <span className="readout text-[20px] leading-none text-foreground">{deltaText}</span>
            <span className="text-[10.5px] text-faint">no new roads · no new vehicles</span>
          </div>
        ) : null}
      </div>

      {/* Baseline before counterfactual. `validation` exists only on the
          baseline run and is rendered nowhere else in the app; when it is
          absent this line is absent too — never a fallback string. */}
      {validation ? (
        <div className="mt-1.5 border-hairline border-t pt-1.5">
          <button
            type="button"
            onClick={() => setNarrativeOpen((v) => !v)}
            aria-expanded={narrativeOpen}
            className="flex w-full cursor-pointer items-baseline gap-1.5 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-[10.5px] leading-[14px] text-subtle">
              Baseline reproduces {meta ? meta.place : "the event"}
              {meta ? `, ${longDate(meta.eventDate)}` : ""} — modelled{" "}
              <span className="readout">{formatDuration(validation.modeledClearance)}</span> against
              approximately{" "}
              <span className="readout">{formatDuration(validation.observedClearanceApprox)}</span>{" "}
              observed.
            </span>
            <span className="label-mono shrink-0" style={{ color: "var(--warn)" }}>
              Approximate
            </span>
            {narrativeOpen ? (
              <ChevronUp size={12} strokeWidth={1.75} className="shrink-0 text-faint" />
            ) : (
              <ChevronDown size={12} strokeWidth={1.75} className="shrink-0 text-faint" />
            )}
          </button>

          {narrativeOpen ? (
            <div className="thin-scroll mt-1.5 max-h-[56px] overflow-y-auto pr-1">
              <p className="text-[10.5px] leading-[15px] text-faint">
                {validation.observedNarrative}
              </p>
              <p className="mt-1.5 text-[10.5px] leading-[15px] text-faint">{validation.note}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import type { LucideIcon } from "lucide-react";
import { flyTo } from "@/components/map/map-shell";
import { actions } from "@/lib/store";
import type { LngLat, Selection } from "@/types/egress";
import { Chip, SectionLabel, TONE_VAR, type Tone } from "./queue-tab";

/**
 * Shared furniture for the entity detail panels.
 *
 * Two rules the components enforce rather than merely document:
 *
 *  1. An unknown value renders an em-dash, never a zero. `formatCount(0)` and
 *     "we have no figure" look identical on screen and mean opposite things to
 *     the person reading them. `Field` takes `null | undefined` and prints "—".
 *
 *  2. Every panel closes with a `Sources` block. See "Never silently
 *     synthesize" in CLAUDE.md: a number whose origin the operator cannot trace
 *     is worse than a number we did not print.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a figure came to be on screen.
 *
 * `observed`     an instrument or an agency of record published it.
 * `interpolated` sits between two observations; nothing measured this instant.
 * `modelled`     the pipeline's solver produced it.
 * `derived`      computed in this browser, from a payload, on selection.
 * `authored`     a human chose it. Constants and thresholds live here.
 */
export type ProvenanceKind = "observed" | "interpolated" | "modelled" | "derived" | "authored";

const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  observed: "Observed",
  interpolated: "Interpolated",
  modelled: "Modelled",
  derived: "Derived",
  authored: "Authored",
};

const PROVENANCE_TITLE: Record<ProvenanceKind, string> = {
  observed: "Measured by an instrument, or published by the agency of record.",
  interpolated: "Between two observations. Nothing measured this exact instant.",
  modelled: "Produced by the deterministic solver in the data pipeline.",
  derived: "Computed in this browser from a loaded payload, on selection.",
  authored: "A constant a person chose. Defensible, not measured.",
};

/** Neutral by design. Provenance is a qualifier on a number, not a state to
 *  alarm about, and colour in this console is reserved for data state. */
export function ProvenanceChip({ kind }: { kind: ProvenanceKind }) {
  return (
    <Chip tone="neutral" title={PROVENANCE_TITLE[kind]}>
      {PROVENANCE_LABEL[kind].toUpperCase()}
    </Chip>
  );
}

export interface SourceLine {
  label: string;
  /** The upstream string exactly as the payload carries it. Never paraphrased —
   *  several facility `source` values contain their own disclaimer. */
  value: string;
  kind: ProvenanceKind;
}

/** The block every detail panel ends on. */
export function Sources({ lines, note }: { lines: SourceLine[]; note?: string }) {
  return (
    <div className="mt-auto border-t border-hairline pt-2">
      <SectionLabel>Provenance</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {lines.map((l) => (
          <div key={`${l.label}:${l.value}`} className="flex flex-col gap-[3px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="label-mono">{l.label}</span>
              <ProvenanceChip kind={l.kind} />
            </div>
            <span className="break-words text-[10.5px] leading-snug text-faint">{l.value}</span>
          </div>
        ))}
      </div>
      {note ? (
        <p className="mt-2 border-t border-hairline pt-1.5 text-[10.5px] leading-snug text-faint">
          {note}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/** Scroll container every detail panel uses, so they all scroll the same way. */
export function PanelBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
      {children}
    </div>
  );
}

export function PanelHeader({
  kind,
  id,
  name,
  icon: Icon,
  right,
}: {
  kind: string;
  id: string;
  name?: string;
  icon?: LucideIcon;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-1.5">
        {Icon ? (
          <Icon size={13} strokeWidth={1.75} className="mt-[3px] shrink-0 text-faint" />
        ) : null}
        <div className="min-w-0">
          <div className="label-mono">{kind}</div>
          <div className="readout truncate text-[13px] text-foreground" title={id}>
            {id}
          </div>
          {name ? (
            <div className="truncate text-[11px] text-subtle" title={name}>
              {name}
            </div>
          ) : null}
        </div>
      </div>
      {right ? <div className="shrink-0 pt-0.5">{right}</div> : null}
    </div>
  );
}

/** A titled well. `right` carries the one number the block is about. */
export function Block({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-inset px-2.5 py-2">
      {right ? (
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>{label}</SectionLabel>
          {right}
        </div>
      ) : (
        <SectionLabel>{label}</SectionLabel>
      )}
      {children}
    </div>
  );
}

/**
 * A labelled figure. Pass `null` or `undefined` for a value we do not have and
 * it prints an em-dash — the one thing that must never round to zero.
 */
export function Field({
  label,
  value,
  unit,
  tone,
  title,
}: {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  tone?: Tone;
  title?: string;
}) {
  const missing =
    value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={title}>
      <span className="label-mono">{label}</span>
      <span
        className="readout text-[12px]"
        style={missing ? { color: "var(--faint)" } : tone ? { color: TONE_VAR[tone] } : undefined}
      >
        {missing ? "—" : value}
        {!missing && unit ? <span className="text-faint"> {unit}</span> : null}
      </span>
    </div>
  );
}

/** A loud, bordered callout. Reserved for a fact that changes what the operator
 *  does next — a cut-off zone, a shelter inside the footprint. */
export function Alarm({
  icon: Icon,
  tone = "hazard",
  children,
}: {
  icon: LucideIcon;
  tone?: Extract<Tone, "hazard" | "warn">;
  children: React.ReactNode;
}) {
  const bg = tone === "hazard" ? "var(--hazard-dim)" : "var(--warn-dim)";
  const fg = tone === "hazard" ? "var(--hazard-text)" : "var(--warn-text)";
  return (
    <div
      className="flex items-start gap-2 rounded-sm px-2 py-1.5"
      style={{ background: bg, border: `1px solid ${TONE_VAR[tone]}` }}
    >
      <Icon size={13} strokeWidth={1.75} className="mt-[2px] shrink-0" style={{ color: fg }} />
      <p className="text-[11.5px] font-medium leading-snug" style={{ color: fg }}>
        {children}
      </p>
    </div>
  );
}

/** A row that selects another entity. Cross-links are what make the dock feel
 *  like one instrument rather than eight unrelated panels. */
export function LinkRow({
  kind,
  id,
  primary,
  secondary,
  right,
  center,
}: {
  kind: Selection["kind"];
  id: string;
  primary: string;
  secondary?: string;
  right?: React.ReactNode;
  /** Fly the camera here as well as selecting. */
  center?: LngLat;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        actions.select(kind, id);
        if (center) flyTo({ center, zoom: 14 });
      }}
      className="glass-inset glass-inset-hover flex w-full cursor-pointer items-baseline justify-between gap-2 px-2 py-1.5 text-left"
    >
      <span className="min-w-0">
        <span className="readout block truncate text-[11.5px] text-foreground">{primary}</span>
        {secondary ? <span className="label-mono block truncate">{secondary}</span> : null}
      </span>
      {right ? <span className="shrink-0">{right}</span> : null}
    </button>
  );
}

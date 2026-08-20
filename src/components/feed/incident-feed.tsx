"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useMemo } from "react";
import { selectEntity } from "@/components/inspector/pick-select";
import { flyTo } from "@/components/map/map-shell";
import { useBundle } from "@/lib/bundle-context";
import { cx, formatCount } from "@/lib/format";
import { incidentCountAt, incidentEvents, incidentTime } from "@/lib/incident-feed";
import { actions, selFeedCollapsed, selT, selView, useEgress } from "@/lib/store";
import type { IncidentEvent, IncidentTone, RunKind, SimulationRun, ViewMode } from "@/types/egress";

/**
 * The incident feed.
 *
 * A log of what the run did, ordered newest first, showing exactly the events
 * whose tick has passed the playhead. It is NOT a toast stack: there is no
 * fired-once state anywhere, because the console's whole premise is a
 * scrubbable replay and a queue of dismissed notifications would disagree with
 * the timeline the moment anyone drags backwards. Events come from
 * lib/incident-feed.ts, which reads only the precomputed run on disk.
 *
 * Rendering cost is the reason this file is split in two. The outer component
 * subscribes to `t` and so re-renders up to 30 times a second; all it computes
 * is how many events have fired. The panel below it is memoised on that COUNT,
 * so the list reconciles when an incident actually crosses the playhead and at
 * no other time.
 */

/**
 * Rows kept in the scroll region, oldest trimmed first. Above the largest run
 * either scenario produces (camp-fire's baseline is 83), so nothing is
 * unreachable in practice — the cap exists so a longer scenario cannot grow the
 * DOM without bound, not to hide anything. The header always counts the whole
 * run either way.
 */
const MAX_ROWS = 120;

/** Fill colour for the tone rail. Every one of these is an existing data hue —
 *  a feed row is red for the same reason a zone is red. */
const TONE_FILL: Record<IncidentTone, string> = {
  critical: "var(--hazard)",
  warning: "var(--warn)",
  plan: "var(--plan)",
  ok: "var(--ok)",
  neutral: "var(--hairline-strong)",
};

const TONE_INK: Record<IncidentTone, string> = {
  critical: "var(--hazard-text)",
  warning: "var(--warn-text)",
  plan: "var(--plan-text)",
  ok: "var(--ok)",
  neutral: "var(--faint)",
};

/**
 * Which run the feed reads. Duplicated from scrubber.tsx and kpi-strip.tsx on
 * purpose — neither file owns a shared module, and a three-line fork beats
 * reaching into a file another agent owns.
 */
function activeRun(
  view: ViewMode,
  baseline: SimulationRun | null,
  planned: SimulationRun | null,
): SimulationRun | null {
  if (view === "baseline") return baseline ?? planned;
  return planned ?? baseline;
}

export function IncidentFeed({ className }: { className?: string }) {
  const t = useEgress(selT);
  const view = useEgress(selView);
  const collapsed = useEgress(selFeedCollapsed);
  const bundle = useBundle();

  const run = activeRun(view, bundle?.baseline ?? null, bundle?.planned ?? null);

  const events = useMemo(
    () =>
      incidentEvents({
        run,
        zones: bundle?.zones ?? null,
        network: bundle?.network ?? null,
        hazard: bundle?.hazard ?? null,
        meta: bundle?.meta ?? null,
      }),
    [run, bundle],
  );

  // No simulation on disk means no log. The shell already says so in its own
  // notice; a second empty panel would only repeat it.
  if (!run || events.length === 0) return null;

  return (
    <FeedPanel
      events={events}
      fired={incidentCountAt(events, t)}
      collapsed={collapsed}
      runKind={run.kind}
      className={className}
    />
  );
}

interface FeedPanelProps {
  events: IncidentEvent[];
  fired: number;
  collapsed: boolean;
  runKind: RunKind;
  className?: string;
}

const FeedPanel = memo(function FeedPanel({
  events,
  fired,
  collapsed,
  runKind,
  className,
}: FeedPanelProps) {
  const visible = useMemo(() => {
    const start = Math.max(0, fired - MAX_ROWS);
    return events.slice(start, fired).reverse();
  }, [events, fired]);

  // "Latest" is the whole frame, not one row: several things happen on one
  // frame of a 5-minute grid and picking one of them as the arrival would be
  // arbitrary. Derived from the count, so it survives a scrub in either
  // direction without any stored state.
  const latestTick = visible.length > 0 ? visible[0].t : null;

  return (
    <section
      aria-label="Incident feed"
      className={cx(
        "glass pointer-events-auto flex w-[336px] max-w-full flex-col overflow-hidden",
        className,
      )}
    >
      <header className="flex items-center gap-2 px-2.5 py-1.5">
        <span className="label-mono flex-1 truncate">Incident feed</span>
        <span
          className="label-mono"
          title={
            runKind === "baseline"
              ? "Events from the baseline run — what the event actually did."
              : "Events from the planned run — the counterfactual."
          }
          style={{ color: runKind === "planned" ? "var(--plan-text)" : "var(--faint)" }}
        >
          {runKind === "planned" ? "Plan" : "Baseline"}
        </span>
        <span className="readout text-[10.5px] text-subtle tabular-nums">
          {formatCount(fired)}/{formatCount(events.length)}
        </span>
        <button
          type="button"
          onClick={() => actions.toggleFeed()}
          aria-label={collapsed ? "Expand incident feed" : "Collapse incident feed"}
          aria-expanded={!collapsed}
          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-faint transition-colors duration-[120ms] hover:bg-glass-hover hover:text-foreground"
        >
          {collapsed ? (
            <ChevronUp size={14} strokeWidth={1.75} />
          ) : (
            <ChevronDown size={14} strokeWidth={1.75} />
          )}
        </button>
      </header>

      {/* One live region either way, so a screen reader hears the newest
          incident whether or not the list is folded away. */}
      {/* role=log is the ARIA role for an append-only record; no HTML element
          carries it, so the div is annotated rather than replaced. */}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Incidents up to the playhead"
        className={cx(
          "thin-scroll flex flex-col overflow-y-auto",
          collapsed ? "max-h-0" : "max-h-[228px]",
        )}
      >
        {visible.length === 0 ? (
          <p className="px-2.5 py-2 text-[11px] text-faint">Nothing has happened yet.</p>
        ) : (
          visible.map((e) => (
            <FeedRow key={e.id} event={e} latest={e.t === latestTick} hidden={collapsed} />
          ))
        )}
      </div>

      {collapsed && visible.length > 0 ? (
        <p className="truncate px-2.5 pb-1.5 text-[11px] text-subtle">
          <span className="readout mr-1.5 text-[10.5px] text-faint">
            {incidentTime(visible[0].t)}
          </span>
          {visible[0].headline}
        </p>
      ) : null}
    </section>
  );
});

function FeedRow({
  event,
  latest,
  hidden,
}: {
  event: IncidentEvent;
  latest: boolean;
  hidden: boolean;
}) {
  const fill = TONE_FILL[event.tone];
  const ink = TONE_INK[event.tone];

  return (
    <button
      type="button"
      tabIndex={hidden ? -1 : undefined}
      /* One gesture, three effects: park the playhead on the moment, select the
         thing the event is about, and point the camera at it. An incident row
         that opens nothing is the same broken instrument a dead map pick is. */
      onClick={() => {
        actions.setT(event.t);
        if (event.subject) selectEntity(event.subject.kind, event.subject.id);
        if (event.focus) flyTo({ center: event.focus, zoom: 12.5, duration: 900 });
      }}
      className={cx(
        "flex w-full cursor-pointer items-start gap-2 px-2.5 py-1.5 text-left transition-colors duration-[120ms] hover:bg-glass-hover",
        latest && "bg-glass-inset",
      )}
      style={
        // Mounts once, when the event crosses the playhead. Reused keyframe from
        // globals.css, so prefers-reduced-motion already neutralises it.
        latest ? { animation: "fade-up 220ms cubic-bezier(0.22, 1, 0.36, 1) both" } : undefined
      }
    >
      <span
        aria-hidden="true"
        className={cx(
          "mt-0.5 w-[2px] shrink-0 self-stretch rounded-full",
          latest && event.tone === "critical" && "pulse-critical",
        )}
        style={{ background: fill }}
      />

      <span className="readout mt-[1px] shrink-0 text-[10.5px] text-faint">
        {incidentTime(event.t)}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
        <span className="flex items-baseline gap-1.5">
          <span className="label-mono truncate" style={{ color: ink }}>
            {event.channel}
          </span>
          {event.count > 1 ? (
            <span className="readout shrink-0 text-[9.5px] text-faint">×{event.count}</span>
          ) : null}
          {event.modelled ? (
            <span
              className="label-mono shrink-0"
              title="Timed from an interpolated hazard frame, not an observed perimeter."
            >
              Modelled
            </span>
          ) : null}
        </span>

        <span className="text-[11.5px] leading-snug text-foreground">{event.headline}</span>

        {event.detail ? (
          <span className="line-clamp-2 text-[10.5px] leading-snug text-faint" title={event.detail}>
            {event.detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

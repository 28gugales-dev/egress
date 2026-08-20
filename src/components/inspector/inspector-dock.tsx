"use client";

import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useRef } from "react";
import { useBundle } from "@/lib/bundle-context";
import { cx } from "@/lib/format";
import {
  actions,
  selInspectorCollapsed,
  selInspectorTab,
  selLoadError,
  selSelection,
  useEgress,
} from "@/lib/store";
import type { InspectorTab, Selection } from "@/types/egress";
import { DetailTab } from "./detail-tab";
import { PeopleTab } from "./people-tab";
import { EGRESS_SELECT_EVENT, type SelectDetail } from "./pick-select";
import { QueueTab } from "./queue-tab";
import { RouteTab } from "./route-tab";
import { TeamsTab } from "./teams-tab";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "route", label: "Route" },
  { id: "people", label: "People" },
  { id: "teams", label: "Teams" },
  { id: "detail", label: "Detail" },
];

const TAB_TITLE: Record<InspectorTab, string> = {
  queue: "Evacuation queue",
  route: "Route & release",
  people: "People",
  teams: "Pickup teams",
  detail: "Selection detail",
};

/** What the header calls the thing that is selected. */
const KIND_LABEL: Record<NonNullable<Selection["kind"]>, string> = {
  zone: "Zone",
  edge: "Segment",
  facility: "Facility",
  vehicle: "Vehicle",
  cell: "Block group",
  context: "Context",
  wave: "Wave",
  hazard: "Hazard",
  block: "Block",
  building: "Structure",
};

/**
 * Whether a tab can say anything about this selection.
 *
 * Queue, Route, People and Teams are views of a zone. Anything else the map can
 * hand back belongs to Detail, and a click that lands on a tab which ignores it
 * is indistinguishable from a click that did nothing.
 */
function tabHandles(tab: InspectorTab, kind: Selection["kind"]): boolean {
  if (kind === null) return true;
  if (kind === "zone") return true;
  if (kind === "vehicle") return tab === "teams" || tab === "detail";
  return tab === "detail";
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="loading-sweep glass-inset relative h-11 overflow-hidden" />
      ))}
    </div>
  );
}

export interface InspectorDockProps {
  /**
   * "dock" is the floating right-hand aside. "pane" is the same dock mounted
   * inside the panel plane's work band, which supplies its own title strip and
   * its own width — so the pane variant drops the 308px cap, the header and the
   * collapse affordance, and stops painting its own glass surface (there is
   * nothing behind it to refract there). Nothing else changes, and in
   * particular the TABS array stays the single source of truth for what tabs
   * exist.
   */
  variant?: "dock" | "pane";
}

/**
 * The dock deliberately does NOT subscribe to `t`. Only the tabs that render
 * countdowns do, so the header and tab strip stay off the 30fps path.
 */
export function InspectorDock({ variant = "dock" }: InspectorDockProps = {}) {
  const collapsed = useEgress(selInspectorCollapsed);
  const tab = useEgress(selInspectorTab);
  const selection = useEgress(selSelection);
  const loadError = useEgress(selLoadError);
  const bundle = useBundle();

  /* Any module can ask for a selection over the same window-event bus the shell
     already uses for fly-to and the scenario picker. The map's own layers reach
     the store directly; this is for everything that must not import it. */
  useEffect(() => {
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent<SelectDetail>).detail;
      if (!detail) return;
      actions.select(detail.kind, detail.id);
    };
    window.addEventListener(EGRESS_SELECT_EVENT, onSelect);
    return () => window.removeEventListener(EGRESS_SELECT_EVENT, onSelect);
  }, []);

  /* Follow the selection onto a tab that can render it — but only when the
     selection itself changes, so an operator who deliberately switches back to
     Queue while a road is selected is not yanked away again. */
  const lastSelection = useRef<string>("");
  useEffect(() => {
    const key = `${selection.kind ?? ""}:${selection.id ?? ""}`;
    if (key === lastSelection.current) return;
    lastSelection.current = key;
    if (!tabHandles(tab, selection.kind)) actions.setInspectorTab("detail");
  }, [selection, tab]);

  const pane = variant === "pane";

  if (collapsed && !pane) {
    return (
      <aside className="glass flex h-full w-10 shrink-0 flex-col items-center gap-3 py-3">
        <button
          type="button"
          onClick={() => actions.toggleInspector()}
          aria-label="Expand inspector"
          title="Expand inspector"
          className="cursor-pointer rounded-sm p-1 text-faint transition-colors duration-[120ms] hover:bg-glass-hover hover:text-foreground"
        >
          <PanelRightOpen size={15} strokeWidth={1.75} />
        </button>
        <span
          className="label-mono whitespace-nowrap"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {TAB_TITLE[tab]}
        </span>
      </aside>
    );
  }

  return (
    <aside
      className={cx(
        "flex h-full min-h-0 flex-col overflow-hidden",
        pane ? "w-full" : "glass w-[308px] shrink-0",
      )}
    >
      {pane ? null : (
        <header className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
          <h2 className="panel-title min-w-0 flex-1 truncate">{TAB_TITLE[tab]}</h2>
          <span
            className="label-mono max-w-[130px] truncate"
            title={selection.id ?? undefined}
            style={selection.id ? { color: "var(--foreground)" } : undefined}
          >
            {selection.kind && selection.id
              ? `${KIND_LABEL[selection.kind]} · ${selection.id}`
              : "No selection"}
          </span>
          <button
            type="button"
            onClick={() => actions.toggleInspector()}
            aria-label="Collapse inspector"
            title="Collapse inspector"
            className="shrink-0 cursor-pointer rounded-sm p-1 text-faint transition-colors duration-[120ms] hover:bg-glass-hover hover:text-foreground"
          >
            <PanelRightClose size={15} strokeWidth={1.75} />
          </button>
        </header>
      )}

      <nav className="flex shrink-0 gap-0.5 border-b border-hairline px-1.5" aria-label="Inspector">
        {TABS.map((tb) => {
          const on = tb.id === tab;
          // A tab that cannot speak to the current selection is dimmed rather
          // than disabled: Queue still lists every zone, it just is not about
          // the thing that was clicked.
          const mute = !on && !tabHandles(tb.id, selection.kind);
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => actions.setInspectorTab(tb.id)}
              aria-current={on ? "page" : undefined}
              className={cx(
                "cursor-pointer border-b-2 px-1.5 py-1.5 text-[11.5px] transition-colors duration-[120ms]",
                on
                  ? "font-semibold text-foreground"
                  : mute
                    ? "border-transparent font-medium text-faint/60 hover:text-subtle"
                    : "border-transparent font-medium text-faint hover:text-subtle",
              )}
              // Chrome is neutral. An ember underline on a tab is a data hue
              // carrying no data, sitting in the most-looked-at nav in the app.
              style={on ? { borderBottomColor: "var(--foreground)" } : undefined}
            >
              {tb.label}
            </button>
          );
        })}
      </nav>

      {loadError ? (
        <div className="flex flex-1 items-center px-3 py-4">
          <p className="text-[11px] leading-snug text-hazard-text">{loadError}</p>
        </div>
      ) : !bundle ? (
        <Skeleton />
      ) : tab === "queue" ? (
        <QueueTab />
      ) : tab === "route" ? (
        <RouteTab />
      ) : tab === "people" ? (
        <PeopleTab />
      ) : tab === "teams" ? (
        <TeamsTab />
      ) : (
        <DetailTab />
      )}
    </aside>
  );
}

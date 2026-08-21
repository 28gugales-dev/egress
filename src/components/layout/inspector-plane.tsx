"use client";

import { IncidentFeed } from "@/components/feed/incident-feed";
import { InspectorDock } from "@/components/inspector/inspector-dock";
import { useBundle } from "@/lib/bundle-context";
import { selInspectorTab, selSelection, useEgress } from "@/lib/store";
import type { InspectorTab, Selection } from "@/types/egress";

/**
 * The RIGHT modal, in MAP VIEW: the evacuation queue with the incident log
 * under it.
 *
 * Two things that in panel view are somewhere else, and both moves are the same
 * move. There the inspector is one of three work-band panes, so it is on screen
 * only when it has won the column; the incident feed is a 336px strip beside
 * the scrubber, so the log of what the run just did is as wide as a phone. Map
 * view has a whole side of the window free, and these are the two things an
 * operator reads WHILE working in the left sheet rather than instead of it.
 *
 * The dock inside is the SAME component the work band mounts — `variant="pane"`
 * in both — so there is one inspector in this codebase and two places it can
 * appear. Only the header is authored here: the dock's `dock` variant brings a
 * collapse control, and a sheet that is half the console's information cannot
 * carry a button that folds it to 40px while the layout axis already has a
 * control that does the honest version of that. The `pane` variant supplies no
 * header at all, so the title and the selection readout are re-hung here.
 */

const TAB_TITLE: Record<InspectorTab, string> = {
  queue: "Evacuation queue",
  route: "Route & release",
  people: "People",
  teams: "Pickup teams",
  detail: "Selection detail",
};

/** What the header calls the thing that is selected. Forked from the dock so
 *  this file does not have to reach into a private map inside it. */
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

export function InspectorPlane() {
  const tab = useEgress(selInspectorTab);
  const selection = useEgress(selSelection);
  const bundle = useBundle();
  const hasRun = bundle?.baseline !== null || bundle?.planned !== null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex h-[28px] flex-none items-center gap-2 px-3">
        <h2 className="panel-title min-w-0 flex-1 truncate">{TAB_TITLE[tab]}</h2>
        <span
          className="label-mono max-w-[140px] shrink-0 truncate"
          title={selection.id ?? undefined}
          style={selection.id ? { color: "var(--foreground)" } : undefined}
        >
          {selection.kind && selection.id
            ? `${KIND_LABEL[selection.kind]} · ${selection.id}`
            : "No selection"}
        </span>
      </header>
      <div className="band-rule" aria-hidden />

      {/* The one scroller in this sheet. */}
      <div className="min-h-0 flex-1">
        <InspectorDock variant="pane" />
      </div>

      {/* The log, on the floor. flex-none so the queue above keeps every pixel
          the feed does not need — the feed caps its own scroll region, and a
          feed that grew with its content would push the queue off the bottom of
          a sheet whose whole point is that the queue is always visible.
          `max-w-full` is already on the feed, so its authored 336px yields to
          whatever this sheet is and nothing here fights it for width.

          The rule is gated on the same condition the feed gates itself on: with
          no simulation on disk IncidentFeed renders nothing, and an unattached
          hairline across the floor of the sheet would be a divider between one
          thing and nothing. */}
      {hasRun ? (
        <div className="flex-none">
          <div className="band-rule" aria-hidden />
          <IncidentFeed className="flat-surface w-full" />
        </div>
      ) : null}
    </div>
  );
}

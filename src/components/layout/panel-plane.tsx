"use client";

import { useEffect, useRef, useState } from "react";
import { IncidentFeed } from "@/components/feed/incident-feed";
import { ArgumentBand } from "@/components/layout/argument-band";
import { MapControlRow, MapKeyRow } from "@/components/layout/map-controls";
import { SituationBand, type SituationTier } from "@/components/layout/situation-band";
import { WorkBand } from "@/components/layout/work-band";
import { Scrubber } from "@/components/timeline/scrubber";
import { cx } from "@/lib/format";
import { selPlane, useLayout } from "@/lib/layout-store";

/**
 * The panel column: four bands, three hairlines, ONE scroller — and two more
 * registers in map view.
 *
 * Every band except the work band is fixed-height and never moves. The work
 * band is the only region whose content is unbounded, so it is the only one
 * that scrolls. That is what makes this an instrument rather than a page — the
 * operator learns where a band is, and the band never shifts under their hand.
 *
 * Bands are divided by a 1px rule and nothing else. No gaps: a gap turns
 * registers of one face into a stack of cards.
 *
 * WHAT THE PLANE CHANGES HERE, and nothing else does:
 *
 *   panel view  the column as it has always been. The map keeps its own frame
 *               — a control strip above the geography and a key strip below it
 *               — so this column carries no map chrome, and the incident feed
 *               sits beside the scrubber where it has room.
 *   map view    the map has no frame, so the two strips fold in as this
 *               column's first and last rows, at the SAME height they occupied
 *               over the geography. The move is sideways, out of the map and
 *               into the sheet, and nothing else. The incident feed leaves for
 *               the right modal, which is what pays for the two new rows: the
 *               scrubber alone does not need the 184px the two of them shared.
 */

/** Panel width below which the ARGUMENT band folds its three-across row into
 *  two. Container-driven, not viewport-driven: the same column is 960 at 1920
 *  in panel view and 883 there in map view, and only it knows which. All of
 *  these compare `clientWidth`, which includes 12px of padding a side. */
const COMPACT_BELOW = 780;

/**
 * The SITUATION band's four steps, in panel clientWidth.
 *
 * Every number is that tier's own measured cell widths plus 170px for a
 * scenario chip that can still show a name and a date, plus the 25px the band
 * loses to the column's padding and seam:
 *
 *   full  112 clock + 99 exposed + 53 out + 417 dispatch + 97 segment = 778
 *   mid   112 + 99 + 53 + 224 + 97 = 585
 *   compact 76 + 99 + 53 + 116 + 97 = 441
 *   tiny  76 + 72 + 45 + 116 + 91 = 400, and 100 is enough chip for a name
 *
 * The previous single 780px step put the band in its FULL tier from 780 all
 * the way up, so at 1600 it overflowed by 25px — clipping the Panel|Map segment
 * — and at 1920 it rendered the scenario as "Cam…".
 */
const BAND_FULL_ABOVE = 980;
const BAND_MID_ABOVE = 790;
/* 600 rather than the 640 the arithmetic suggests: a 1280 window gives this
   column a clientWidth of 639, one pixel short, and dropping a whole tier over
   one pixel costs the event date and the full cell labels for 115px of slack
   nothing else wants. Between 600 and 640 the scenario label gives up a few
   characters instead, which is the fallback this band is specified to take. */
const BAND_COMPACT_ABOVE = 600;

/**
 * Panel width below which the transport band drops the incident feed.
 *
 * The number is the scrubber's arithmetic, not a design target: the scrubber's
 * min-content is 364px and the feed stops being a log at about 224, so the two
 * need 597px of content width plus the rule between them. 624 clientWidth is
 * 600 of content — the first width where both fit honestly.
 */
const FEED_BELOW = 624;

/**
 * The transport band's height, in each layout.
 *
 * PANEL 184: 111px gave the feed a 79px viewport for 295px of content — 1.2
 * events out of four, with the third line clipping mid-word. Two complete
 * events need about 150px of scroll viewport under a 29px header.
 *
 * MAP 112: no feed here, and the scrubber's own content is 104px — two 28px
 * control rows, two 12px mark gutters, 12px of padding and three 4px gaps — so
 * 112 centres it with a hair of slack and nothing more. Keeping 184 would be a
 * band still sized for a component that left.
 */
const TRANSPORT_PANEL = 184;
const TRANSPORT_MAP = 112;

/** Feed column width. Never below the point where a headline stops fitting on
 *  two lines, never above the width it was designed at. */
function feedWidthFor(content: number): number {
  return Math.max(224, Math.min(336, Math.round(content * 0.36)));
}

export function PanelPlane() {
  const plane = useLayout(selPlane);
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    /* Window listener beside the observer: observer deliveries are tied to the
       rendering pipeline and can lag or be suspended, and this column's width
       is a clamp on the viewport that also changes when the plane does. */
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, []);

  /* And once more after every render, deliberately without a dependency list.
     Switching the plane changes this column's width through a CSS clamp rather
     than through anything React measured, and observer deliveries are tied to
     the rendering pipeline. React bails out when the width is unchanged, so the
     steady-state cost is one clientWidth read per render. */
  useEffect(() => {
    const el = ref.current;
    if (el) setWidth(el.clientWidth);
  });

  /* Zero is the pre-measure state, not a real width. Treating it as "full"
     keeps the first paint at the design target instead of flashing the tiny
     tier for one frame on every load. */
  const measured = width > 0;
  const compact = measured && width < COMPACT_BELOW;
  const tier: SituationTier = !measured
    ? "mid"
    : width >= BAND_FULL_ABOVE
      ? "full"
      : width >= BAND_MID_ABOVE
        ? "mid"
        : width >= BAND_COMPACT_ABOVE
          ? "compact"
          : "tiny";

  const mapView = plane === "map";
  const showFeed = !mapView && (!measured || width >= FEED_BELOW);

  return (
    <div
      ref={ref}
      className={cx(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        mapView ? "px-3 pt-2 pb-1.5" : "p-3",
      )}
    >
      {mapView ? (
        <>
          {/* What the map is drawing. The top bezel's survivors, in the row the
              top bezel occupied. */}
          <MapControlRow className="flex-none" />
          <div className="band-rule mt-1" aria-hidden />
        </>
      ) : null}

      <SituationBand tier={tier} />
      <div className="band-rule" aria-hidden />
      <ArgumentBand compact={compact} />
      <div className="band-rule" aria-hidden />
      <WorkBand />
      <div className="band-rule" aria-hidden />

      {/* Where you are on the clock, and — in panel view — what just happened
          on it. The scrubber spans the width it never had as a 430px island;
          the incident feed takes the slack beside it rather than floating over
          the map, which is the one place in this layout nothing may cover. */}
      <div
        className="flex flex-none items-stretch"
        style={{ height: mapView ? TRANSPORT_MAP : TRANSPORT_PANEL }}
      >
        {/* Centred rather than stretched: the scrubber is a content-height
            component, and a taller band would otherwise park it against the
            top rule with all the slack underneath. */}
        <div className="flex min-w-0 flex-1 items-center">
          <Scrubber className="flat-surface min-w-0 flex-1" />
        </div>
        {showFeed ? (
          <div
            className="flex min-h-0 flex-none border-hairline border-l pl-2"
            style={{ width: feedWidthFor(Math.max(0, width - 24)) }}
          >
            <IncidentFeed className="flat-surface h-full min-h-0 w-full" />
          </div>
        ) : null}
      </div>

      {mapView ? (
        <>
          <div className="band-rule" aria-hidden />
          {/* The floor — the bottom bezel's survivors, at the height the bottom
              bezel had them. */}
          <MapKeyRow className="flex-none pt-1" />
        </>
      ) : null}
    </div>
  );
}

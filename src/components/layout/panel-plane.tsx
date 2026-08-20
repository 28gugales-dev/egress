"use client";

import { useEffect, useRef, useState } from "react";
import { IncidentFeed } from "@/components/feed/incident-feed";
import { ArgumentBand } from "@/components/layout/argument-band";
import { SituationBand, type SituationTier } from "@/components/layout/situation-band";
import { WorkBand } from "@/components/layout/work-band";
import { Scrubber } from "@/components/timeline/scrubber";

/**
 * The panel plane: four bands, three hairlines, ONE scroller.
 *
 * Bands 1, 2 and 4 never scroll and never move. Band 3 is the only region whose
 * content is unbounded, so it is the only one that scrolls. That is what makes
 * this an instrument rather than a page — the operator learns where a band is,
 * and the band never shifts under their hand.
 *
 * Bands are divided by a 1px rule and nothing else. No gaps: a gap turns four
 * registers of one face into four cards.
 */

/** Panel width below which the ARGUMENT band folds its three-across row into
 *  two. Container-driven, not viewport-driven: the same column is 960 at 1920,
 *  640 at 1280 and the whole window in stacked mode, and only it knows which.
 *  All of these compare `clientWidth`, which includes 12px of padding a side. */
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
 * Panel width below which band 4 drops the incident feed.
 *
 * The number is the scrubber's arithmetic, not a design target: the scrubber's
 * min-content is 364px and the feed stops being a log at about 224, so the two
 * need 597px of content width plus the rule between them. 624 clientWidth is
 * 600 of content — the first width where both fit honestly.
 *
 * It used to be COMPACT_BELOW, which meant the feed vanished at 1440 and 1280,
 * the two commonest laptop widths, for no reason connected to either component.
 */
const FEED_BELOW = 624;

/**
 * Band 4's height.
 *
 * 111px gave the feed a 79px viewport for 295px of content — 1.2 events out of
 * four, with the third line of the first event clipping mid-word. Two complete
 * events need about 150px of scroll viewport under a 29px header, and the work
 * band above can afford it: at a 1080 window band 3 still clears 660px against
 * a release table that asks for roughly 390.
 */
const TRANSPORT_BAND = 184;

/** Feed column width. Never below the point where a headline stops fitting on
 *  two lines, never above the width it was designed at. */
function feedWidthFor(content: number): number {
  return Math.max(224, Math.min(336, Math.round(content * 0.36)));
}

export function PanelPlane() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    /* Window listener beside the observer: below 1280 this column stops being
       a flex sibling and becomes `absolute inset-0`, which changes its width
       without the window changing size on the frame the observer would fire. */
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
     Crossing 1280 turns this column from a flex sibling into `absolute
     inset-0`: its width changes because its POSITIONING changed, not because
     anything resized, and observer deliveries are tied to the rendering
     pipeline and can lag or be suspended. React bails out when the width is
     unchanged, so the steady-state cost is one clientWidth read per render of
     a component that renders a handful of times. */
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
  const showFeed = !measured || width >= FEED_BELOW;

  return (
    <div ref={ref} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-3">
      <SituationBand tier={tier} />
      <div className="band-rule" aria-hidden />
      <ArgumentBand compact={compact} />
      <div className="band-rule" aria-hidden />
      <WorkBand />
      <div className="band-rule" aria-hidden />

      {/* Band 4 — where you are on the clock, and what just happened on it.
          The scrubber spans the width it never had as a 430px island; the
          incident feed takes the slack beside it rather than floating over the
          map, which is the one place in this layout nothing is allowed to
          cover. */}
      <div className="flex flex-none items-stretch" style={{ height: TRANSPORT_BAND }}>
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
    </div>
  );
}

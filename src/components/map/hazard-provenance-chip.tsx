"use client";

import { useMemo } from "react";
import { useBundle } from "@/lib/bundle-context";
import { hazardFrameAt } from "@/lib/derive";
import { cx, formatTick } from "@/lib/format";
import { selT, useEgress } from "@/lib/store";

/**
 * Provenance of the hazard frame currently on screen.
 *
 * This is an honesty requirement, not decoration. One frame of the Camp Fire
 * track is an observed perimeter; the other ninety-six are interpolated between
 * observations. A viewer watching the fire crawl across the map will assume
 * they are watching a replay unless the UI says otherwise on every frame, so
 * the chip is always mounted and always states which it is.
 */

export interface HazardProvenanceChipProps {
  className?: string;
  /** Drop the observed/total count when space beside the clock is tight. */
  compact?: boolean;
}

export function HazardProvenanceChip({ className, compact = false }: HazardProvenanceChipProps) {
  const bundle = useBundle();
  const t = useEgress(selT);

  const frames = bundle?.hazard.frames;
  const counts = useMemo(() => {
    if (!frames) return { observed: 0, total: 0 };
    let observed = 0;
    for (const f of frames) if (f.provenance === "observed") observed++;
    return { observed, total: frames.length };
  }, [frames]);

  if (!bundle) return null;

  const frame = hazardFrameAt(bundle.hazard, t);
  const isObserved = frame.provenance === "observed";
  const tone = isObserved ? "var(--plan)" : "var(--warn)";

  const explain = isObserved
    ? `Observed fire perimeter at ${formatTick(frame.t)}. ${counts.observed} of ${counts.total} frames in this track are observed; the rest are interpolated between observations. Source: ${bundle.hazard.source}`
    : `Modelled perimeter at ${formatTick(frame.t)} — interpolated between observations, not a recorded footprint. Only ${counts.observed} of ${counts.total} frames in this track are observed. Source: ${bundle.hazard.source}`;

  return (
    <div
      className={cx("glass inline-flex items-center gap-1.5 px-2 py-[3px]", className)}
      title={explain}
      role="status"
    >
      <span
        aria-hidden
        className="size-[7px] flex-none rounded-full"
        style={
          isObserved
            ? { background: tone }
            : { border: `1.5px solid ${tone}`, background: "transparent" }
        }
      />
      <span className="label-mono" style={{ color: tone }}>
        {isObserved ? "Observed" : "Modelled"}
      </span>
      {!compact && (
        <span className="readout text-[10px] text-faint">
          {counts.observed}/{counts.total}
        </span>
      )}
    </div>
  );
}

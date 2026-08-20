"use client";

import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { getScenario } from "@/lib/constants";
import { cx } from "@/lib/format";
import { selScenarioId, useEgress } from "@/lib/store";

/**
 * The scenario identity, as the SITUATION band needs it.
 *
 * Forked from timeline/kpi-strip.tsx's ScenarioChip rather than imported, and
 * both reasons are rules rather than taste.
 *
 * That chip renders a hardcoded pulse dot filled with --hazard and no data
 * input at all. Permanent colour in the reserved hazard hue, on a permanent
 * 1.9s animation, sitting at the console's top-left anchor 18px from a cell
 * that reads "Exposed now 0 veh" — which is the exact thing "chrome is neutral,
 * colour only ever encodes data state" forbids.
 *
 * And it is `.glass` with `whitespace-nowrap` and no truncation, so inside the
 * opaque panel it ran a backdrop-filter pass over nothing and then refused to
 * yield a pixel of width, pushing the whole shortfall onto the DISPATCH cell
 * until a number truncated mid-digit-group. The band's own rule is that the
 * scenario label truncates first and a number never does; this is the half of
 * that rule that has to live in the component.
 *
 * Same event, same words, no dot, and it yields width before anything else.
 */
export function ScenarioChip({
  className,
  showDate = true,
}: {
  className?: string;
  showDate?: boolean;
}) {
  const scenarioId = useEgress(selScenarioId);
  const meta = useMemo(() => getScenario(scenarioId), [scenarioId]);

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("egress:open-scenarios"))}
      aria-label="Change scenario"
      title={`${meta.name} — ${meta.eventDate}. Change scenario.`}
      className={cx(
        "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-glass-hover",
        className,
      )}
    >
      <span className="panel-title min-w-0 truncate">{meta.name}</span>
      {showDate ? (
        <span className="label-mono min-w-0 flex-none truncate">{meta.eventDate}</span>
      ) : null}
      <ChevronDown size={13} strokeWidth={1.75} className="flex-none text-faint" />
    </button>
  );
}

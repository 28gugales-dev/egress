"use client";

import { getScenario } from "@/lib/constants";
import { actions, selScenarioId, selView, useEgress } from "@/lib/store";
import type { ViewMode } from "@/types/egress";

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "planned", label: "Planned" },
  { id: "baseline", label: "Baseline" },
  // The layout axis is PANEL/MAP. This axis is COMPARE. The literal "split"
  // survives only as ViewMode's value, which lives in types/egress.ts.
  { id: "split", label: "Compare" },
];

/** One line per mode, because "Baseline" alone does not tell an operator that
 *  they are looking at the counterfactual-free replay of what actually ran. */
const VIEW_HINT: Record<ViewMode, string> = {
  planned: "Staged release, contraflow and dispatch applied.",
  baseline: "What the event actually got: one order, no staging.",
  split: "Both runs side by side on the same clock.",
};

/**
 * `showView` exists for one caller: the split-plane console's CONTROL pane,
 * where the same Planned | Baseline | Compare segment already sits in the map
 * bezel — a control that changes only which run the map draws belongs on the
 * map. Two identical three-state controls at two different type sizes, 930px
 * apart, is a control an operator has to check twice. The old shell's rail has
 * no bezel to move it to, so it keeps the segment and the default stays true.
 */
export function ScenarioSection({ showView = true }: { showView?: boolean }) {
  const scenarioId = useEgress(selScenarioId);
  const view = useEgress(selView);
  const scenario = getScenario(scenarioId);

  return (
    <section className="px-3 pt-[18px] pb-1">
      <div className="label-mono mb-2">Plan</div>

      <div className="mb-2.5">
        <div className="panel-title truncate text-foreground">{scenario.name}</div>
        <div className="truncate text-[10.5px] text-faint">
          {scenario.place} · <span className="readout">{scenario.eventDate}</span>
        </div>
      </div>

      {showView ? (
        <div className="seg">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              data-on={view === v.id}
              onClick={() => actions.setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* The hint stays either way: it is what tells an operator that BASELINE
          is the counterfactual-free replay, and that sentence is worth more
          here than the segment was. */}
      <p className="mt-1.5 text-[10px] leading-[1.45] text-faint">{VIEW_HINT[view]}</p>
    </section>
  );
}

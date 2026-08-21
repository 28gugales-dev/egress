"use client";

import { Chip, SectionLabel } from "@/components/inspector/queue-tab";
import { type ScenarioCoverage, useScenarioCoverage } from "@/lib/coverage";
import { selScenarioId, useEgress } from "@/lib/store";

/**
 * What THIS scenario's payload contains, and what it does not.
 *
 * The four scenarios are not interchangeable. Camp Fire and Palisades carry a
 * hazard field, context imagery and block detail; Marshall and Conyers carry
 * none of the three, so their map draws less — correctly, since nothing is
 * substituted for a missing layer, but until this block existed it drew less
 * without ever saying why. A judge who picks the bare one and notices before
 * we mention it is the failure CLAUDE.md's "volunteer the seam" rule names.
 *
 * ABSENCE IS NEUTRAL HERE, NOT A WARNING. These layers are richness, not
 * correctness: the release sequence, the capacity solve and the clearance
 * figures come from the required bundle, which every scenario carries in full.
 * Colouring a missing context raster in warn amber would say the plan is less
 * trustworthy on Marshall, which is not true and is not a thing to imply on a
 * screen an incident commander reads.
 */

const ROWS: { key: keyof ScenarioCoverage; label: string; what: string }[] = [
  {
    key: "hazardField",
    label: "Hazard field",
    what: "Per-cell arrival raster. Without it the hazard is perimeter frames only.",
  },
  {
    key: "context",
    label: "Context imagery",
    what: "Reference rasters drawn under the network.",
  },
  {
    key: "detail",
    label: "Block detail",
    what: "Block and structure geometry, drawn past its zoom gate.",
  },
];

export function CoverageSection() {
  const scenarioId = useEgress(selScenarioId);
  const coverage = useScenarioCoverage(scenarioId);

  return (
    <div className="px-3 pt-2.5 pb-2">
      <SectionLabel>Payload coverage</SectionLabel>
      {ROWS.map(({ key, label, what }) => {
        const present = coverage?.[key];
        return (
          <div
            key={key}
            className="flex items-baseline justify-between gap-3 py-[3px]"
            title={what}
          >
            <span className="label-mono">{label}</span>
            {coverage === null ? (
              <span className="readout text-[12.5px] text-faint">—</span>
            ) : (
              <Chip tone={present ? "ok" : "neutral"}>{present ? "LOADED" : "NOT IN PAYLOAD"}</Chip>
            )}
          </div>
        );
      })}
      <p className="mt-1.5 text-[10px] leading-[1.4] text-faint">
        Optional layers only. The network, population, hazard track and both solved runs are
        required, and every scenario carries them — a missing layer above costs detail on the map,
        never a figure in the plan.
      </p>
    </div>
  );
}

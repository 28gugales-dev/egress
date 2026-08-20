"use client";

import { actions, selParams, useEgress } from "@/lib/store";
import type { RunParams } from "@/types/egress";

/** The boolean half of RunParams — the four things an operator can actuate. */
type LeverKey = {
  [K in keyof RunParams]: RunParams[K] extends boolean ? K : never;
}[keyof RunParams];

const LEVERS: { key: LeverKey; label: string; caption?: string }[] = [
  {
    key: "staged",
    label: "Staged release",
    caption: "The single biggest lever, and no consumer navigation app has it.",
  },
  { key: "contraflow", label: "Contraflow" },
  { key: "busDispatch", label: "Bus dispatch" },
  { key: "shelterInPlaceOption", label: "Shelter-in-place option" },
];

export function LeversSection() {
  const params = useEgress(selParams);

  return (
    <section className="px-3 pt-[18px] pb-1">
      <div className="label-mono mb-2">Levers</div>

      {LEVERS.map((lever) => {
        const on = params[lever.key];
        return (
          <div key={lever.key} className="mb-2 last:mb-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] text-subtle">{lever.label}</span>
              <button
                type="button"
                className="sw"
                data-on={on}
                aria-pressed={on}
                aria-label={lever.label}
                onClick={() => actions.setParam(lever.key, !on)}
              />
            </div>
            {lever.caption ? (
              <p className="mt-0.5 max-w-[176px] text-[10px] leading-[1.4] text-faint">
                {lever.caption}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

"use client";

import { Check, Copy, Database } from "lucide-react";
import { useState } from "react";
import { getScenario } from "@/lib/constants";
import { cx } from "@/lib/format";

/**
 * Every payload the console can be missing, with the one command that rebuilds
 * it. Keyed by the substring the loader is expected to name in its error — we
 * match on both the key and the filename so a message like
 * `GET /data/camp-fire-2018/hazard.json -> 404` still resolves.
 */
const PAYLOADS: { key: string; file: string; label: string; command: string }[] = [
  { key: "network", file: "network.json", label: "Road network", command: "pnpm data:network" },
  { key: "hazard", file: "hazard.json", label: "Hazard track", command: "pnpm data:hazard" },
  {
    key: "population",
    file: "population.json",
    label: "Population",
    command: "pnpm data:population",
  },
  { key: "zones", file: "zones.json", label: "Evacuation zones", command: "pnpm data:zones" },
  {
    key: "facilities",
    file: "facilities.json",
    label: "Facilities and fleet",
    command: "pnpm data:facilities",
  },
  { key: "weather", file: "weather.json", label: "Weather", command: "pnpm data:weather" },
  {
    key: "run_baseline",
    file: "run_baseline.json",
    label: "Baseline run",
    command: "pnpm data:simulate",
  },
  {
    key: "run_planned",
    file: "run_planned.json",
    label: "Planned run",
    command: "pnpm data:simulate",
  },
  {
    key: "param_grid",
    file: "param_grid.json",
    label: "Parameter grid",
    command: "pnpm data:simulate",
  },
];

function missingFrom(error: string): typeof PAYLOADS {
  const hay = error.toLowerCase();
  const hits = PAYLOADS.filter((p) => hay.includes(p.file) || hay.includes(p.key));
  return hits;
}

function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="glass-inset flex items-center justify-between gap-3 px-3 py-2">
      <code className="readout text-[12px] text-foreground">
        <span className="text-faint">$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            },
            () => setCopied(false),
          );
        }}
        className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] text-subtle transition-colors hover:bg-glass-hover hover:text-foreground"
      >
        {copied ? (
          <Check size={13} strokeWidth={1.75} className="text-ok" />
        ) : (
          <Copy size={13} strokeWidth={1.75} />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export interface DataMissingProps {
  /** The loader's message. Named payloads inside it are resolved to commands. */
  error?: string | null;
  scenarioId?: string;
  className?: string;
}

export function DataMissing({ error, scenarioId, className }: DataMissingProps) {
  const message = error ?? "No payload was returned for this scenario.";
  const missing = missingFrom(message);
  const scenario = scenarioId ? getScenario(scenarioId) : null;
  const commands = Array.from(new Set(missing.map((m) => m.command)));

  return (
    <div
      className={cx(
        "flex h-dvh w-full items-center justify-center bg-background p-6 text-foreground",
        className,
      )}
    >
      <div className="glass w-full max-w-[560px] p-6">
        <div className="flex items-center gap-2.5">
          <Database size={15} strokeWidth={1.75} className="text-warn" />
          <h1 className="panel-title">Scenario payloads are not on disk</h1>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-subtle">
          {scenario ? (
            <>
              <span className="text-foreground">{scenario.name}</span> — {scenario.place} needs its
              data built before the console can draw it.
            </>
          ) : (
            <>The console needs its data built before it can draw anything.</>
          )}
        </p>

        <div className="mt-5">
          <div className="label-mono">{missing.length > 0 ? "Absent" : "Loader said"}</div>
          {missing.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {missing.map((p) => (
                <li key={p.key} className="glass-inset flex items-center justify-between px-3 py-2">
                  <span className="text-[12.5px] text-foreground">{p.label}</span>
                  <span className="readout text-[11px] text-faint">
                    public/data/{scenarioId ?? "<scenario>"}/{p.file}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="glass-inset mt-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-subtle">
              {message}
            </p>
          )}
        </div>

        <div className="mt-5">
          <div className="label-mono">Build it</div>
          <div className="mt-2 flex flex-col gap-1.5">
            {commands.length > 0 && commands.length < 3 ? (
              commands.map((c) => <CopyLine key={c} command={c} />)
            ) : (
              <CopyLine command="pnpm data:all" />
            )}
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
            Pipeline scripts take a scenario id as the first argument and default to{" "}
            <span className="readout text-subtle">camp-fire-2018</span>. Every source is keyless.
            Reload once the files land.
          </p>
        </div>
      </div>
    </div>
  );
}

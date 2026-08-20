/**
 * compact-hazard.ts — rewrite hazard.json to ship closures once, not per frame.
 *
 *     npx tsx scripts/compact-hazard.ts [scenarioId|--all] [--check]
 *
 * `HazardFrame.closedEdgeIds` is cumulative, so every frame after the one that
 * closed an edge restates that edge id. On camp-fire-2018 that is 4.00 MB of a
 * 4.39 MB payload — 91% of the file, and the single largest thing the console
 * downloads. This replaces the per-frame arrays with one `closedFrom` map of
 * edge id -> first-closed tick, which `loadScenario` expands back before any
 * consumer sees the track.
 *
 * LOSSLESS OR IT REFUSES. The transform is only valid while closure is
 * monotonic — an edge that reopens cannot be described by a single tick. Every
 * scenario is checked before it is touched, and a reopen aborts that scenario
 * with a loud warning rather than quietly dropping the reopening. After
 * rewriting, the script expands its own output and compares it frame by frame
 * against what it read; a mismatch restores nothing and exits non-zero, because
 * a hazard payload that disagrees with itself is worse than a large one.
 *
 * `--check` reports without writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { HazardTrack, Tick } from "../src/types/egress";

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(here, "..", "public", "data");

const SCENARIOS = [
  "camp-fire-2018",
  "palisades-fire-2025",
  "marshall-fire-2021",
  "conyers-plume-2024",
];

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const positional = args.filter((a) => !a.startsWith("--"));
const targets = args.includes("--all") || positional.length === 0 ? SCENARIOS : positional;

interface Report {
  scenario: string;
  ok: boolean;
  note: string;
  beforeMb: number;
  afterMb: number;
}

/** Cumulative per-frame arrays, rebuilt from a close-tick map. Mirrors
 *  `expandClosures` in src/lib/data.ts — kept here so the verification does not
 *  depend on importing browser-side code into a script. */
function expand(track: HazardTrack, closedFrom: Record<string, Tick>): string[][] {
  const byTick = new Map<number, string[]>();
  for (const [edgeId, t] of Object.entries(closedFrom)) {
    const bucket = byTick.get(t);
    if (bucket) bucket.push(edgeId);
    else byTick.set(t, [edgeId]);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const out: string[][] = [];
  let next = 0;
  let running: string[] = [];
  for (const frame of track.frames) {
    while (next < ticks.length && ticks[next] <= frame.t) {
      running = running.concat(byTick.get(ticks[next]) as string[]);
      next += 1;
    }
    out.push(running);
  }
  return out;
}

function compact(scenario: string): Report {
  const path = join(dataRoot, scenario, "hazard.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { scenario, ok: false, note: "no hazard.json", beforeMb: 0, afterMb: 0 };
  }
  const beforeMb = Buffer.byteLength(raw) / 1e6;
  const track = JSON.parse(raw) as HazardTrack;

  if (track.closedFrom) {
    return { scenario, ok: true, note: "already compact", beforeMb, afterMb: beforeMb };
  }
  if (track.frames.length === 0) {
    return { scenario, ok: true, note: "no frames", beforeMb, afterMb: beforeMb };
  }

  // Monotonicity first. A reopen makes the whole idea invalid, and the right
  // answer is to leave the payload alone and say so.
  const closedFrom: Record<string, Tick> = {};
  let seen = new Set<string>();
  let reopened = 0;
  for (const frame of track.frames) {
    const cur = new Set(frame.closedEdgeIds ?? []);
    for (const id of seen) if (!cur.has(id)) reopened += 1;
    for (const id of cur) if (!(id in closedFrom)) closedFrom[id] = frame.t;
    seen = cur;
  }
  if (reopened > 0) {
    console.warn(
      `\n!!! LOUD WARNING: ${scenario} reopens ${reopened} edge-frames. Closure is NOT ` +
        "monotonic here, so a single close-tick per edge would silently drop every " +
        "reopening. Left uncompacted on purpose — the payload is large but correct.",
    );
    return {
      scenario,
      ok: false,
      note: `${reopened} reopens — skipped`,
      beforeMb,
      afterMb: beforeMb,
    };
  }

  const original = track.frames.map((f) => [...(f.closedEdgeIds ?? [])].sort());
  const next: HazardTrack = {
    ...track,
    closedFrom,
    frames: track.frames.map((f) => ({ ...f, closedEdgeIds: [] })),
  };

  // Round-trip against what we read, not against what we hoped to write.
  const rebuilt = expand(next, closedFrom).map((a) => [...a].sort());
  for (let i = 0; i < original.length; i += 1) {
    const a = original[i];
    const b = rebuilt[i];
    if (a.length !== b.length || a.some((id, j) => id !== b[j])) {
      console.error(
        `\n!!! ${scenario} frame ${i} (t=${track.frames[i].t}) does not round-trip: ` +
          `${a.length} edges in, ${b.length} out. NOT WRITTEN.`,
      );
      return { scenario, ok: false, note: "round-trip failed", beforeMb, afterMb: beforeMb };
    }
  }

  const out = JSON.stringify(next);
  const afterMb = Buffer.byteLength(out) / 1e6;
  if (!checkOnly) writeFileSync(path, out);
  return {
    scenario,
    ok: true,
    note: `${Object.keys(closedFrom).length} edges, ${track.frames.length} frames`,
    beforeMb,
    afterMb,
  };
}

const reports = targets.map(compact);

console.log(`\n${checkOnly ? "CHECK" : "COMPACT"} hazard payloads\n`);
console.log("  scenario                  before     after    saved   note");
let saved = 0;
for (const r of reports) {
  const delta = r.beforeMb - r.afterMb;
  saved += delta;
  console.log(
    `  ${r.scenario.padEnd(22)} ${r.beforeMb.toFixed(2).padStart(6)} MB ${r.afterMb
      .toFixed(2)
      .padStart(6)} MB ${delta.toFixed(2).padStart(6)} MB   ${r.ok ? "" : "SKIPPED "}${r.note}`,
  );
}
console.log(`\n  total saved: ${saved.toFixed(2)} MB${checkOnly ? " (nothing written)" : ""}\n`);

if (reports.some((r) => r.note === "round-trip failed")) process.exit(1);

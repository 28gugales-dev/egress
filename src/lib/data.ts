import { asset } from "@/lib/base-path";
import { getScenario } from "@/lib/constants";
import type {
  FacilityLayer,
  HazardTrack,
  ParamGrid,
  PopulationLayer,
  RoadNetwork,
  ScenarioMeta,
  SimulationRun,
  WindSample,
  ZoneLayer,
} from "@/types/egress";

/**
 * Payload loading.
 *
 * Everything under public/data/<scenarioId>/ is static and precomputed, so the
 * whole bundle is one parallel fetch and then a module-level cache — the
 * scrubber must never wait on IO, and switching scenarios and back must not
 * refetch 6 MB of JSON.
 */

export interface ScenarioBundle {
  meta: ScenarioMeta;
  network: RoadNetwork;
  hazard: HazardTrack;
  population: PopulationLayer;
  zones: ZoneLayer;
  facilities: FacilityLayer;
  /** Null until scripts/simulate has written the run. UI degrades, never crashes. */
  baseline: SimulationRun | null;
  planned: SimulationRun | null;
  grid: ParamGrid | null;
}

/** Files without which there is no console to show. */
const CORE_FILES = [
  "network.json",
  "hazard.json",
  "population.json",
  "zones.json",
  "facilities.json",
  "weather.json",
] as const;

/** Files the simulate step produces; absent during an early pipeline run. */
const RUN_FILES = ["run_baseline.json", "run_planned.json", "param_grid.json"] as const;

/**
 * Thrown when a core payload is missing or truncated. Carries the file list so
 * the shell can name it instead of showing a generic failure — the fix is
 * always the same command, and the operator should be told which one.
 */
export class LoadError extends Error {
  readonly scenarioId: string;
  readonly missing: string[];
  readonly remedy = "pnpm data:all";

  constructor(scenarioId: string, missing: string[]) {
    super(
      `Scenario "${scenarioId}" is missing ${missing.length === 1 ? "payload" : "payloads"}: ` +
        `${missing.join(", ")}. Run pnpm data:all.`,
    );
    this.name = "LoadError";
    this.scenarioId = scenarioId;
    this.missing = missing;
  }
}

export function isLoadError(e: unknown): e is LoadError {
  return e instanceof LoadError;
}

/** weather.json is a sibling of hazard.json rather than a bundle member: its
 *  samples are the `wind` track HazardTrack already declares. */
interface WeatherPayload {
  scenarioId: string;
  samples: WindSample[];
  source?: string;
  generatedAt?: string;
}

const cache = new Map<string, ScenarioBundle>();
const inflight = new Map<string, Promise<ScenarioBundle>>();

/** Synchronous cache read. Lets a remount skip the loading flash. */
export function peekScenario(scenarioId: string): ScenarioBundle | null {
  return cache.get(scenarioId) ?? null;
}

export async function loadScenario(scenarioId: string): Promise<ScenarioBundle> {
  const hit = cache.get(scenarioId);
  if (hit) return hit;

  // Dedupe concurrent callers — StrictMode mounts the provider twice.
  const pending = inflight.get(scenarioId);
  if (pending) return pending;

  const p = fetchBundle(scenarioId)
    .then((bundle) => {
      cache.set(scenarioId, bundle);
      return bundle;
    })
    .finally(() => {
      inflight.delete(scenarioId);
    });

  inflight.set(scenarioId, p);
  return p;
}

async function fetchBundle(scenarioId: string): Promise<ScenarioBundle> {
  const [network, hazard, population, zones, facilities, weather, baseline, planned, grid] =
    await Promise.all([
      fetchJson<RoadNetwork>(scenarioId, CORE_FILES[0]),
      fetchJson<HazardTrack>(scenarioId, CORE_FILES[1]),
      fetchJson<PopulationLayer>(scenarioId, CORE_FILES[2]),
      fetchJson<ZoneLayer>(scenarioId, CORE_FILES[3]),
      fetchJson<FacilityLayer>(scenarioId, CORE_FILES[4]),
      fetchJson<WeatherPayload>(scenarioId, CORE_FILES[5]),
      fetchJson<SimulationRun>(scenarioId, RUN_FILES[0]),
      fetchJson<SimulationRun>(scenarioId, RUN_FILES[1]),
      fetchJson<ParamGrid>(scenarioId, RUN_FILES[2]),
    ]);

  const missing: string[] = [];
  if (!hasArray(network, "edges")) missing.push(CORE_FILES[0]);
  if (!hasArray(hazard, "frames")) missing.push(CORE_FILES[1]);
  if (!hasArray(population, "cells")) missing.push(CORE_FILES[2]);
  if (!hasArray(zones, "zones")) missing.push(CORE_FILES[3]);
  if (!hasArray(facilities, "facilities")) missing.push(CORE_FILES[4]);
  if (!hasArray(weather, "samples")) missing.push(CORE_FILES[5]);
  if (missing.length > 0) throw new LoadError(scenarioId, missing);

  // The guards above establish these; the push-then-throw shape hides that
  // from the narrower, so assert once here rather than nesting six ifs.
  const hazardTrack = hazard as HazardTrack;
  expandClosures(hazardTrack);
  const wind = hazardTrack.wind;

  return {
    meta: getScenario(scenarioId),
    network: network as RoadNetwork,
    // Hazard frames own the perimeter; wind can arrive from either producer,
    // so prefer what the hazard pipeline embedded and backfill from weather.
    hazard:
      wind && wind.length > 0
        ? hazardTrack
        : { ...hazardTrack, wind: (weather as WeatherPayload).samples },
    population: population as PopulationLayer,
    zones: zones as ZoneLayer,
    facilities: facilities as FacilityLayer,
    baseline: hasArray(baseline, "frames") ? (baseline as SimulationRun) : null,
    planned: hasArray(planned, "frames") ? (planned as SimulationRun) : null,
    grid: hasRecord(grid, "entries") ? (grid as ParamGrid) : null,
  };
}

async function fetchJson<T>(scenarioId: string, file: string): Promise<T | null> {
  try {
    /* NOT force-cache. These URLs are rewritten by every `pnpm data:simulate`,
       and force-cache serves a stored response without ever asking whether it
       is still current — so a regenerated run kept rendering the previous
       numbers through a hard reload, and the console reported a clearance the
       files on disk no longer contained. The payloads carry
       `max-age=0, must-revalidate`, so the default policy revalidates and the
       server answers 304 in the common case: correct, and still one round trip
       with no body. */
    const res = await fetch(asset(`/data/${scenarioId}/${file}`), { cache: "default" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // A half-written file during a live pipeline run parses as a syntax error;
    // treat it exactly like absence so the caller reports one clear remedy.
    return null;
  }
}

/**
 * Rebuild each frame's cumulative `closedEdgeIds` from the compact
 * `closedFrom` map the payload actually ships.
 *
 * Seven modules read `closedEdgeIds` -- derive, simulate, the incident feed,
 * the roadblock layer, two inspector panels -- and every one of them wants the
 * cumulative array. So the compaction lives entirely on the wire: the file
 * carries one tick per edge, this puts the arrays back, and nothing downstream
 * knows the difference. Trading 4 MB of transfer for a single O(edges) pass at
 * load is the whole point; the in-memory shape is deliberately unchanged.
 *
 * A payload that predates `closedFrom` keeps whatever per-frame arrays it has.
 */
function expandClosures(track: HazardTrack): void {
  const closedFrom = track.closedFrom;
  if (!closedFrom || track.frames.length === 0) return;

  // Bucket by tick first so this is one pass over the edges plus one over the
  // frames, rather than a scan of every edge for every frame.
  const byTick = new Map<number, string[]>();
  for (const [edgeId, t] of Object.entries(closedFrom)) {
    const bucket = byTick.get(t);
    if (bucket) bucket.push(edgeId);
    else byTick.set(t, [edgeId]);
  }

  /* Cumulative, so each frame's array is the previous frame's plus whatever
     closed at this tick. Frames are ascending by contract. Edges whose tick
     falls between two frames attach to the first frame at or after it, which
     is where the producer put them. */
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  let next = 0;
  let running: string[] = [];
  for (const frame of track.frames) {
    while (next < ticks.length && ticks[next] <= frame.t) {
      running = running.concat(byTick.get(ticks[next]) as string[]);
      next += 1;
    }
    /* Every frame that closed nothing new SHARES the previous frame's array
       rather than copying it. Copying per frame would rebuild the same 4 MB in
       memory that this whole change exists to stop shipping. Safe because
       `concat` above always allocates a new array, so no consumer can mutate a
       shared one into a past frame -- and none of them mutate it anyway. */
    frame.closedEdgeIds = running;
  }
}

function hasArray(v: unknown, key: string): boolean {
  return !!v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key]);
}

/** An entry-less grid is treated as absent, so every non-null grid handed to
 *  derive.summaryFor can actually answer. */
function hasRecord(v: unknown, key: string): boolean {
  const inner = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : null;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return false;
  return Object.keys(inner).length > 0;
}

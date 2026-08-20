# Egress

Capacity-constrained evacuation planning at incident tempo.

## The thesis (shapes every decision)

Navigation apps are **user-optimal**: each person gets their individually fastest road, so
everyone gets the same road, and that road stops moving. Paradise CA lost 85 people in 2018,
many in vehicles, on a town with roughly four egress routes.

Egress solves for **clearance time** — when the *last* person is out — under real road
capacity, using staged zone release, contraflow, and dispatched pickup for households with no
vehicle. The output is not a route. It is a **zone release sequence** an incident commander
can execute.

Rigorous evacuation modelling exists and is legally required — for nuclear plants (NRC
Evacuation Time Estimates) and coastal hurricanes (USACE Hurricane Evacuation Studies).
Wildfire gets zone polygons and a notification list. That regulatory asymmetry is the problem
statement.

## Architecture

```
scripts/          data pipeline, run via tsx, writes public/data/<scenario>/*.json
  fetch-network     Overpass -> RoadNetwork (graph + capacities)
  fetch-hazard      NIFC perimeters + FIRMS hotspots -> HazardTrack (timestamped frames)
  fetch-population  Census ACS + TIGERweb -> PopulationLayer (incl. no-vehicle households)
  fetch-facilities  HIFLD + Overpass -> FacilityLayer (dispatch origins, shelters)
  fetch-weather     Open-Meteo archive -> WindSample[]
  build-zones       Dijkstra to sinks, cluster by egress corridor -> ZoneLayer
  simulate          time-expanded capacity flow -> run_baseline, run_planned, param_grid

src/types/egress.ts     THE CONTRACT. Every module codes against it. Read before writing.
src/lib/store.ts        external store via useSyncExternalStore (NOT context — the scrubber
                        writes t at 30fps and context would re-render the world)
src/lib/derive.ts       pure selectors over a loaded bundle
src/lib/data.ts         payload loading + ScenarioBundle
src/components/map      MapLibre shell + deck.gl overlay
src/components/rail     left control rail (params, levers, layers, filters)
src/components/inspector right dock (queue / route / people / teams)
src/components/timeline  scrubber + KPI strip
src/components/compare   split baseline-vs-plan view
src/components/plan      release sequence table + CAP alert composer
research/                verified API findings, CAP templates, real archived alerts
```

## Non-negotiables

**The solver is deterministic, not a model.** A route that kills someone cannot come from
something that hallucinates. AI is load-bearing in exactly three places: extracting structured
need from unstructured records, turning field reports into graph edits, and generating
multilingual alert copy. Say this out loud in any demo.

**Never silently synthesize.** Every pipeline script falls back when an upstream API fails —
and prints a LOUD warning naming exactly what was faked. A number nobody can trace is worse
than a missing number.

**Baseline before counterfactual.** The baseline run must reproduce the observed event before
the planned run is allowed to mean anything. `run.validation` carries that comparison, and it
never claims a precise observed figure we cannot cite.

**Claim clearance hours and vehicles-exposed. Never claim lives saved.** Deaths in these
events have multiple causes — warning delay, communication failure, disability, refusal to
leave. Egress addresses one factor. The audience does the emotional math themselves.

**Volunteer the seam.** The map replay is precomputed so it loads instantly. Say so before
anyone asks, then offer to pull a judge-named town live. Hiding the seam and getting caught
ends the demo.

## Design system

Glassmorphic dark-first command deck. Tokens in `src/app/globals.css`, registered as Tailwind
utilities via `@theme inline` — one set of classes renders in both themes, no `dark:`
duplication anywhere.

Three glass depths: `.glass` (floating panels), `.glass-deep` (modals), `.glass-inset`
(recessed rows inside a panel). Controls: `.seg` + `button[data-on]`, `.sw`, `input.rng`.

**Chrome is neutral. Colour only ever encodes data state** — hazard (ember), plan (cyan),
warn (amber), and the five zone-status hues. If a UI element is coloured, it is carrying
information.

Every number uses `.readout` (mono, tabular-nums). Every group label uses `.label-mono`.
Jittering numerals read as amateur; this is an instrument.

## Data sources — all free, zero required keys

Two optional keys (`CENSUS_API_KEY`, `FIRMS_MAP_KEY`) are used at build time only and both
have keyless fallback paths. The running app makes no authenticated calls. Basemaps are Esri
World Imagery, Carto dark, and AWS terrarium DEM — all keyless, so no token can expire on
stage.

`research/` holds verified endpoint findings. **Read it before adding an integration** — the
endpoints there were confirmed live, not guessed.

## Commands

```
pnpm dev            run the console
pnpm data:all       rebuild every payload for camp-fire-2018 (slow, hits rate limits)
pnpm typecheck      tsc --noEmit
pnpm lint:fix       biome
```

Pipeline scripts take a scenario id as argv[2] and default to `camp-fire-2018`.

## Conventions

- Comments explain non-obvious **why**, never what.
- All state mutation goes through `actions.*` in the store, never inline `setState`.
- Never define an inline selector arrow in a component — import the exported `sel*` functions
  or memoisation breaks.
- Coordinates are `[lng, lat]` everywhere, GeoJSON order, WGS84.
- All time fields are seconds since scenario T+0 (`Tick`).

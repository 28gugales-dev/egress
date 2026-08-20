# Scenario status

What each shipped scenario can and cannot demonstrate. Read this before putting one
on a screen in front of anyone.

| Scenario | Clearance (baseline → planned) | Contraflow orders | Mean egress utilisation |
|---|---|---|---|
| `camp-fire-2018` | 34,200s → (see `run_planned`) | yes | 0.416 |
| `palisades-fire-2025` | 13,200s → 8,400s (−36%) | 3 | 0.792 → 0.876 |
| `marshall-fire-2021` | 24,600s → 24,600s (no change) | **0** | **0** |
| `conyers-plume-2024` | 29,700s → 29,700s (no change) | **0** | **0** |

## Marshall and Conyers are staging-only

Their flat baseline-vs-plan delta is honest output, not a broken run. The mechanism is
mechanical and worth stating plainly rather than working around:

`CORRIDOR_CAPACITY_BY_SCENARIO` in `scripts/simulate.ts` declares an egress corridor
system — road names and lane capacities — for `camp-fire-2018` and
`palisades-fire-2025` only. A scenario absent from that table still runs: every
corridor it uses is discovered from the routes themselves. But discovered corridors are
built with `primary: false`, and that flag carries three consequences.

1. `activeCapAt` and the per-frame `frameFlow` sum only primary corridors. With none,
   both are zero, so `meanEgressUtilization` reads 0 and the closed-form cross-check
   prints `NaN`. Neither figure is measuring anything on these two scenarios — do not
   quote them.
2. Discovered corridors hardcode `contraflow: false`. Contraflow is therefore
   *structurally* unavailable, which is why the planner issues zero orders.
3. With contraflow off the table, the plan has only staged release to work with, and
   staging cannot beat a corridor-capacity bound. Clearance is pinned at the binding
   corridor's demand ÷ capacity — Arapahoe Road (onward) at 6.82h for Marshall,
   Habersham Circle at 8.32h for Conyers — identical in both runs by construction.

The plan is not doing nothing. Peak standing queue drops from 149.8 km to 52.3 km
(Marshall) and 146.9 km to 53.8 km (Conyers): staging moves the wait off the roadway
and into driveways. That is a real result and it is the one to show. It is not
clearance, and it should not be described as clearance.

Fixing this means declaring an egress corridor system for each town. That is a
modelling claim about a real place, not a code change, and it is deliberately not made
from OSM road names alone. Until someone researches the routes those evacuations
actually used, these two scenarios prove the engine generalises across hazard class and
road density — the point they were built for — and nothing about contraflow.

## Other gaps

- `fireIntensity` is empty on every scenario: `FIRMS_MAP_KEY` is unset at build time.
  The fetch path itself is exercised and works; the hotspot layer simply has no rows.
- `palisades-fire-2025` ships no `context/` directory, so context layers render empty
  there.
- No scenario except `camp-fire-2018` has an observed record in `OBSERVED`, so the
  other three ship `run_baseline.json` without a `validation` block rather than
  borrowing another scenario's. That is the intended behaviour, not a missing file.

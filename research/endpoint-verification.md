# Endpoint verification

Hand-verified against live services, not read from docs. Each row records what was actually
fetched and what came back. Re-verify before a demo; these are dated observations, not
guarantees.

Verified: 2026-08-19

---

## Open-Meteo archive — CONFIRMED LIVE, keyless

```
https://archive-api.open-meteo.com/v1/archive
  ?latitude=39.7596&longitude=-121.6219
  &start_date=2018-11-08&end_date=2018-11-08
  &hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m
  &timezone=America/Los_Angeles&wind_speed_unit=ms
```

Returned 24 hourly samples. No key, no redirect, no rate-limit hit.

**The data is correct for the real event.** Early-morning wind at Paradise on the day of the
Camp Fire:

| Local | Speed | Direction | Gust |
|-------|-------|-----------|------|
| 05:00 | 7.8 m/s | 52° | 20.3 m/s |
| 06:00 | 5.0 m/s | 46° | 18.2 m/s |
| 07:00 | 3.1 m/s | 21° | 12.4 m/s |
| 08:00 | 2.4 m/s | 22° | 7.2 m/s |
| 09:00 | 1.6 m/s | 270° | 5.4 m/s |

Direction 21–52° is **northeast** — the Jarbo Gap downslope wind that drove the fire southwest
into Paradise, weakening and reversing to westerly by mid-morning. The reanalysis reproduces
the documented meteorology, which means the hazard interpolation can be oriented by real wind
rather than an assumption.

Caveat worth stating in the demo: this is ERA5-class reanalysis on a coarse grid, so it
understates the local ridge-top gusts that were reported during the event. Use it for
*direction* with confidence and treat *speed* as a lower bound.

---

## Census ACS API — REQUIRES A FREE KEY

Variable IDs confirmed by fetching the group definition (this call is keyless):

```
https://api.census.gov/data/2022/acs/acs5/groups/B25044.json
```

| Variable | Meaning |
|----------|---------|
| `B25044_001E` | Total occupied housing units |
| `B25044_003E` | Owner occupied, **no vehicle available** |
| `B25044_010E` | Renter occupied, **no vehicle available** |

No-vehicle households = `B25044_003E + B25044_010E`. Confirmed exactly, not guessed.

**But the data query itself now requires a key.** A keyless request:

```
https://api.census.gov/data/2022/acs/acs5?get=NAME,B25044_001E&for=block%20group:*&in=state:06%20county:007%20tract:*
```

returns `HTTP 302` redirecting to `https://api.census.gov/data/missing_key.html`. This is true
at both tract and block-group scope. The historical keyless allowance is gone.

Two further gotchas that cost time:

1. **You must follow redirects.** Without `-L`, curl reports a bare 302 with zero bytes and it
   looks like a network failure rather than an auth failure.
2. The `in=` parameter takes space-separated clauses (`in=state:06 county:007 tract:*`),
   URL-encoded. Repeating `&in=` also works. Neither form avoids the key requirement.

### Action required

Register a free key (instant, email only): https://api.census.gov/data/key_signup.html
Then set `CENSUS_API_KEY` in `.env.local`.

### Fallback when no key is present

`scripts/fetch-population.ts` must not silently invent population. Without a key it should
either use a committed snapshot under `research/snapshots/` or apply a documented county-level
no-vehicle rate to building counts — and print a loud warning naming exactly what was
synthesized. See the "never silently synthesize" rule in CLAUDE.md.

---

## FEMA OpenFEMA IPAWS archive — CONFIRMED LIVE, keyless

```
https://www.fema.gov/api/open/v1/IpawsArchivedAlerts
```

Serves **real archived CAP 1.2 alerts**, including the genuine evacuation order issued for the
Rockdale County GA BioLab plume (`GA.001_199_2024-09-29T16:06:20-04:00`).

This is a significant find. It means the alert composer can show a real historical evacuation
order beside the one Egress generates — same schema, same event — instead of asserting that
our output is correctly shaped. Reference implementation and templates live in
`research/cap/`.

---

## Still to re-verify before demo

- NIFC / WFIGS fire perimeter FeatureServer — the host has moved before; confirm the current
  URL and whether Camp Fire perimeters are available at better than daily granularity.
- HIFLD Open facility FeatureServers — also moved hosts recently.
- Overpass instance availability and rate limits on the day.
- Esri World Imagery tile endpoint terms for a public demo.

---

## Census bulk summary files — CONFIRMED LIVE, KEYLESS. This is the fallback.

The API needs a key; the **bulk table files do not**.

```
https://www2.census.gov/programs-surveys/acs/summary_file/2022/table-based-SF/data/5YRData/acsdt5y2022-b25044.dat
```

Pipe-delimited, ~63 MB per table, `GEO_ID` first column. Block groups carry the
`1500000US<state><county><tract><bg>` prefix, so a single stream-filter on
`1500000US06007` pulls Butte County without touching disk.

Column naming in these files is `B25044_E003`, **not** the API's `B25044_003E`. That
transposition is easy to miss and produces a silent all-zero extraction.

Extracted with `research/snapshots/extract.py`, committed as
`research/snapshots/acs-butte-ca-2022.json`:

| Metric | Value |
|--------|-------|
| Block groups | 200 |
| Population | 213,605 |
| Occupied households | 83,319 |
| **No-vehicle households** | **5,063 (6.08%)** |

Real ACS estimates, no key. The "zero required API keys" claim survives intact.

One gap: `B18101` (disability) returned zero rows at this prefix — that table is not
published at block-group level. Pull it at tract level and apportion, or drop the field.

---

## NIFC fire perimeters — CONFIRMED LIVE, keyless. **See the correction below this section.**

```
https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query
  ?where=INCIDENT='CAMP' AND FIRE_YEAR_INT=2018&outFields=*&f=geojson
```

Field names are `INCIDENT`, `FIRE_YEAR_INT`, `GIS_ACRES`, `DATE_CUR`, `MAP_METHOD` — **not**
the `poly_IncidentName` / `attr_*` schema used by the current-year WFIGS services. Querying
with the WFIGS field names returns `400 Invalid field`, which reads like a dead endpoint but
is a schema mismatch.

Camp Fire returns three features:

| Acres | DATE_CUR | Method | Unit | Source |
|-------|----------|--------|------|--------|
| 153,336 | 20181126 | GPS Ground | CABTU | CALFIRE |
| 153,335 | 20200203 | Mixed Methods | CAPRI | BLM |
| 14 | 20180717 | GPS Ground | CASLU | CALFIRE |

(The 14-acre July record is an unrelated fire that shares the name — filter by unit `CABTU`
or by geometry, not by name alone.)

**The perimeter is final-only, dated 18 days after ignition. There is no hourly progression
in this archive.** This is the single biggest data risk in the project and it is now
confirmed rather than assumed.

### How the hazard layer handles it honestly

1. The **final perimeter is real** and bounds the hazard extent — verified above.
2. The **wind is real** — verified from Open-Meteo, and correctly northeast at the right hours.
3. The **progression between ignition and final extent is modelled**, using elliptical growth
   from the ignition point (Camp Creek Rd, approx -121.4347, 39.8136, 06:33 PST) oriented by
   the observed hourly wind.

Every frame carries `provenance: "observed" | "interpolated"`, the UI shows which is which,
and the demo says out loud: *the extent and the wind are real, the hour-by-hour spread is
modelled.* Claiming a replayed fire we do not have would be the one thing that ends the
project in Q&A.

NASA FIRMS archived VIIRS/MODIS hotspots would supply genuine timestamped fire detections and
close this gap — but the archive requires a free `MAP_KEY`. Worth registering before a demo.

---

## Overpass — CONFIRMED LIVE, keyless, fast

```
POST https://overpass-api.de/api/interpreter
[out:json][timeout:120];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service)(_link)?$"]
  (39.68,-121.72,39.84,-121.51);
out body geom;
```

1.9 s, 3.0 MB, **2,445 ways** for the Paradise bbox. `out body geom` returns inline geometry,
so no second node query is needed.

### Finding 1 — OSM lane tagging is effectively absent here

Only **22 of 2,445 ways (0.9%)** carry a `lanes` tag. Capacity therefore cannot be read from
OSM; it has to come from class defaults. This validates the `LANE_CAPACITY` table in
`src/lib/constants.ts` as the primary path rather than a fallback, and it is worth saying in
the demo — "we assume lanes by road class because the data does not have them, here is the
table" is a stronger answer than an unexplained number.

1,515 ways are named, so route labels ("Skyway → Neal Rd") come out of real data.

### Finding 2 — the funnel, quantified

Road length inside the Paradise bbox, by class:

| Class | Length |
|-------|--------|
| residential | 484.3 km |
| service | 125.3 km |
| tertiary | 101.9 km |
| secondary | 54.7 km |
| unclassified | 54.3 km |
| **primary** | **26.9 km** |
| motorway / trunk | **0 km** |

Every named road above tertiary in the whole bbox:

- **primary:** Deer Creek Highway
- **secondary:** Skyway, New Skyway, Skyway Road, Clark Road, Pearson Road

That is the entire arterial egress network of the town. **484 km of residential street drains
into 82 km of arterial — an 18:1 funnel — and there is no motorway or trunk road at all.**

These are precisely the roads people died on. The problem statement is not an assertion in a
slide; it falls out of open data in under two seconds, and the map draws it.

---

## Basemaps — ALL THREE CONFIRMED LIVE, all keyless

| Source | Tile URL pattern | Result |
|--------|------------------|--------|
| Esri World Imagery | `.../World_Imagery/MapServer/tile/{z}/{y}/{x}` | `200`, `image/jpeg` |
| Carto dark | `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` | `200`, `image/png` |
| AWS terrarium DEM | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | `200`, `image/png` |

**Axis-order trap:** Esri's ArcGIS tile REST endpoint is `{z}/{y}/{x}`. Carto and the terrarium
DEM are `{z}/{x}/{y}`. Copying one template to the other silently returns valid-looking tiles
from the wrong place, which is far worse than a 404 — the map renders, just somewhere else.

No tokens anywhere in the stack, so nothing can expire on stage.

---

## Butte County evacuation zones — CONFIRMED LIVE, keyless, CORS-safe. **Changes the build.**

```
https://services.arcgis.com/3t3QfTXFRFX44zo8/arcgis/rest/services/ButteEvacuationZones_2_view/FeatureServer/0/query
  ?where=Community IN ('Town of Paradise','Paradise East','Magalia','Concow','Butte Valley')
  &outFields=*&outSR=4326&f=geojson
```

`HTTP 200`, 249 KB, **46 features**. Snapshot committed at
`research/snapshots/butte-evac-zones.geojson`.

The plan assumed evacuation zones would have to be *derived* by clustering block groups onto
egress corridors. They do not. **The county publishes its real zones, free, as GeoJSON.**

| Community | Zones |
|-----------|-------|
| Town of Paradise | 14 |
| Magalia | 12 |
| Concow | 9 |
| Butte Valley | 9 |
| Paradise East | 2 |

Fields: `Zone`, `SubZone`, `Community`, `Status`, `StructureC`, `Zone_Num`, `Shape__Area`.

### The real zone IDs

`BUT-TOP-01` … `BUT-TOP-14` — Butte, Town Of Paradise. With official structure counts:

| Zone | Structures | Zone | Structures |
|------|-----------|------|-----------|
| BUT-TOP-01 | 1,471 | BUT-TOP-08 | 526 |
| BUT-TOP-02 | 1,797 | BUT-TOP-09 | 1,209 |
| BUT-TOP-03 | 1,148 | BUT-TOP-10 | 602 |
| BUT-TOP-04 | 1,622 | BUT-TOP-11 | 696 |
| BUT-TOP-05 | 1,566 | BUT-TOP-12 | 553 |
| BUT-TOP-06 | 940 | BUT-TOP-13 | 914 |
| BUT-TOP-07 | 1,171 | BUT-TOP-14 | 662 |

**14,877 structures** in the town, from the county's own layer.

### Why this matters more than it looks

The whole positioning argument was: *emit a zone release sequence keyed to the naming a county
already uses, so it pastes into the tool they already run.* With derived zones that was a
claim. With `BUT-TOP-01`–`14` it is literally true.

The `Status` field also carries live operational state ("No Order or Warning" at time of
fetch), which means this is the county's working feed and not a static archive.

`build-zones.ts` should therefore **consume these polygons** and join population and egress
routing onto them, rather than inventing a zone geometry of its own.

### Related layers, also confirmed live and keyless

- **Cal OES statewide aggregation** — `CA_EVACUATIONS_CalOESHosted_view` on
  `services.arcgis.com/BLN4oKB0N1YSgvY8`. Aggregates county evacuation services statewide;
  schema explicitly mirrors the Genasys (formerly Zonehaven) model.
- **`ca_evac_zones`** on `services.arcgis.com/pGfbNJoYypmNq86F` — the best solver input found:
  carries `population`, `homes`, and `svi` (social vulnerability index) per zone.

### Honest negative findings, worth stating in the demo

- **IPAWS-OPEN has no unauthenticated endpoint.** There is no open or test API to send an
  alert. Access requires COG credentials. Say this plainly rather than implying we can send.
- **Genasys Protect / Zonehaven has no public developer API.** The public map needs no login,
  but there is no documented feed. This is why positioning *underneath* it — emitting a
  release sequence keyed to its zone IDs — is the right move rather than integrating with it.
- **CodeRED has no public API either.** Enterprise sales only.

---

## The network reproduces the real evacuation routes

Built from the Overpass pull: **4,255 nodes, 4,901 edges, 9 sinks, 290 contraflow-eligible
segments.** 97.7% of nodes can reach an exit; 96 are orphaned (dead-end spurs).

Arterial corridors that came out of the data, with directional capacity from the class table:

| Corridor | Edges | Length | Capacity |
|----------|-------|--------|----------|
| Skyway | 131 | 17.0 km | 1,800 veh/hr |
| Pearson Road | 52 | 5.2 km | 1,800 veh/hr |
| Pentz Road | 117 | 17.7 km | 800 veh/hr |
| Clark Road | 120 | 16.3 km | 900 veh/hr |
| Neal Road | 37 | 13.4 km | 800 veh/hr |
| Honey Run Road | 32 | 15.9 km | 800 veh/hr |

Skyway, Clark, Pentz, Neal, Pearson. Those are, precisely, the roads Paradise evacuated on in
2018. Nobody told the pipeline that — it fell out of OpenStreetMap.

---

## THE ARITHMETIC OF THE DISASTER

This is the whole argument, and it needs no simulation to make.

From the ACS pull: **9,639 households** in the bbox. At 1.4 vehicles per evacuating household,
**13,495 vehicles**.

Independent egress corridors leaving town, summed: **5,100 veh/hr**.

| Scenario | Time to clear |
|----------|---------------|
| Perfectly distributed across all five corridors | **2.65 h** |
| Everyone funnelled onto Skyway alone | **7.50 h** |
| **Difference** | **4.85 h** |

Add contraflow on Skyway (1,800 → 3,600 veh/hr):

| Scenario | Time to clear |
|----------|---------------|
| Distributed, with contraflow | **1.96 h** |
| Skyway-only, with contraflow | 3.75 h |

The fire reached Paradise inside roughly ninety minutes of ignition.

Read those two columns together and the thesis is finished. The town's roads could have cleared
in about two and a half hours if the load had been spread, and under two with contraflow. Routed
selfishly onto the single best road — which is exactly what a navigation app does, and roughly
what happened — the same roads take seven and a half.

**Nothing in that calculation is a model.** Household counts are ACS. Road geometry and class
are OSM. Capacity is a published per-lane figure. It is division. The simulation exists to show
*where and when* the queues form and who is caught in them — but the case for the product is
one slide of arithmetic over open data.

---

## CORRECTION — timestamped perimeters DO exist. The finding gets sharper, not softer.

The section above concluded "final perimeter only". That was **wrong, and wrong for an
avoidable reason**: it queried `InterAgencyFirePerimeterHistory_All_Years_View`, which stores
one consolidated record per fire. The progression lives in a different layer.

```
https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Historic_Geomac_Perimeters_2018/FeatureServer/0/query
  ?where=incidentname='CAMP'&outFields=*&f=geojson
```

`HTTP 200`. **28 timestamped perimeters**, field `perimeterdatetime`, keyless.

| Perimeter time (UTC) | Acres |
|----------------------|-------|
| 2018-11-08 17:54 | 54,586 |
| 2018-11-09 00:00 | 70,454 |
| 2018-11-09 19:02 | 109,503 |
| 2018-11-10 21:10 | 114,866 |
| … 23 more through 2018-11-19 | → 152,761 |

### Why this still does not give us the evacuation

Ignition was **06:33 PST = 14:33 UTC**. The first perimeter is **17:54 UTC — three hours and
twenty-one minutes later, and already 54,586 acres.**

Paradise was overrun between roughly 08:00 and 10:00 PST. **By the time the first observed
perimeter exists, the town had already burned and the evacuation was over.**

So the archive is dense *after* the disaster and empty *during* it. For the three hours that
the entire product is about, there is exactly one observed shape — at the far end — and
nothing before it.

That is precisely what the shipped `hazard.json` reflects: 97 frames, **1 observed** (at
t=14100 s ≈ 3.9 h, the 17:54 UTC perimeter) and **96 interpolated** back toward the ignition
point. 90 frames carry rings.

### What to say in the demo

The honest sentence is now stronger than the one it replaces:

> The fire archive has 28 timestamped perimeters for the Camp Fire. The earliest is three and
> a half hours after ignition, at 54,000 acres — after the town had already burned. The window
> that decides who lives is the window nobody mapped. So our spread between ignition and that
> first real perimeter is modelled, oriented by observed wind, and the UI labels every frame.

Do not describe this as "replaying the fire". The extent is real, the wind is real, the
endpoint is real, the three hours in between are a model.

### Note on the synthesis that surfaced this

The research synthesis reported the provenance as "a genuine mix of observed and
interpolated", which reads as roughly balanced. It is 1 observed against 96 interpolated.
The correction to the endpoint was right and valuable; the characterisation of the payload
was not. Both were checked against the file rather than taken on trust.

---

## ARITHMETIC, CORRECTED — now on the pre-fire vintage, and stated as a range

The first pass at this used the 2022 ACS. That is the **post-fire** snapshot, and Paradise lost
roughly 90% of its housing in 2018 — so it undercounts the population that actually had to
evacuate. `fetch-population.ts` now pulls the **2013–2017 5-year vintage**, the correct pre-fire
picture, and the zone layer uses the county's own polygons.

Two independent anchors for how many people were in the town:

| Anchor | Households | Source |
|--------|-----------|--------|
| ACS 2013–2017, `BUT-TOP-*` zones | **9,897** | Census, pre-fire vintage |
| County structure count, same zones | **14,877** | Butte County evacuation zone layer |

They disagree, and both are real. ACS counts *occupied households*; the county counts
*structures*, which includes vacancies and outbuildings. Reporting the pair as a range is more
honest than picking the flattering one.

Against 5,100 veh/hr of summed corridor capacity, at 1.4 vehicles per household:

| | Lower anchor (13,856 veh) | Upper anchor (20,828 veh) |
|---|---|---|
| Distributed across five corridors | **2.72 h** | **4.08 h** |
| Funnelled onto Skyway alone | **7.70 h** | **11.57 h** |
| Distributed, with Skyway contraflow | **2.01 h** | **3.02 h** |

The fire reached town in roughly ninety minutes.

The correction changed the numbers by about three percent and changed the conclusion not at all.
Distributed load clears in two to four hours; the same roads carrying the same cars funnelled
onto the single best route take eight to twelve. That gap is the product.

State it as a range in the demo. "Between 2.7 and 4.1 hours depending on which population anchor
you trust, against 7.7 to 11.6" is a stronger sentence than one confident number, and it
pre-empts the only interesting question a sharp judge can ask about the input data.

---

## Zone population: areal apportionment, and why the headline number stopped moving

Census block groups are much coarser than the county's evacuation zones, so assigning each block
group to one zone by centroid left **24 of 46 zones reading as empty** while the county listed
5,124 structures in them. `build-zones.ts` now apportions by intersection area:

```
share(b, z) = area(intersect(b, z)) / area(b)
```

Local metric projection, rings signed by their own winding, zone rings fan-decomposed from vertex
0 so concave zones need no ear clipping, then Sutherland-Hodgman clip per signed triangle. No
bounding-box approximation — bbox overlap badly overstates share for the long thin zones along
Skyway. Cross-checked against an independent 60 m point-in-polygon sampler: totals agree to
0.01%, worst single zone off by 12.5 households.

**Zero-household zones: 24 → 0.** Conservation is exact:

```
16,026 households inside mapped zones
+ 3,276 outside mapped zones      (2 block groups wholly Chico-side, 10 spilling past an edge)
= 19,302                          = population.json total, gap 0
```

The outside-zone category is real, not a leak: block-group area genuinely extends beyond the
county's zone system. It is reported under its own banner rather than folded into the totals.

### The arithmetic, third revision

| Anchor | Households | Vehicles at 1.4 |
|--------|-----------|-----------------|
| ACS 2013-2017, apportioned, `BUT-TOP-*` | 8,981 | 12,573 |
| County structure count, same zones | 14,877 | 20,828 |

| Time to clear | Lower | Upper |
|---------------|-------|-------|
| Distributed across five corridors | 2.47 h | 4.08 h |
| Funnelled onto Skyway alone | 6.99 h | 11.57 h |
| Distributed, with Skyway contraflow | 1.82 h | 3.02 h |

**This is the third time these numbers have been recomputed** — 2022 ACS, then 2013-2017 ACS with
centroid assignment, now 2013-2017 with areal apportionment. Distributed clearance has moved
2.65 → 2.72 → 2.47 h. Skyway-only has moved 7.50 → 7.70 → 6.99 h.

That stability is worth more than any single figure. Three genuinely different treatments of the
input population land inside a band a few percent wide, and the ratio between distributed and
funnelled clearance barely moves at all. **Quote the band, not a point: two to four hours
distributed against seven to twelve funnelled.** The conclusion is robust to the input choice,
which is exactly the property a reviewer will probe for.

Route labels also now cut at the first named arterial, so every Paradise zone reads Skyway,
Clark Road, Pentz Road or Neal Road rather than starting from a residential street.

---

## The simulation found a better version of the thesis than the arithmetic assumed

The closed-form section above models the failure as *everyone funnelled onto Skyway*, the
highest-capacity corridor. The corridor-queue simulation says that is not what selfish routing
actually does, and the real answer is worse.

Free-flow shortest-path routing — what a navigation app returns, and what
`primaryRouteEdgeIds` already encodes — puts roughly **12,000 vehicles onto Pentz Road (800
veh/hr) and Clark Road (900 veh/hr)**, while Skyway's 1,800 veh/hr carries about **20% of
demand**. The binding corridor is **Pentz at 7.38 h**.

That is the thesis stated more precisely. A navigation app does not route you onto the road
with the most capacity; it routes you onto the road that is fastest *when empty*. Those are
different roads, and the difference is what kills people. My arithmetic reached 7.70 h by
assuming the wrong corridor and got the right magnitude for the wrong reason — the simulation
reaches 7.38 h via Pentz, on the same data.

### Results

| | Baseline | Planned |
|---|---|---|
| Clearance | **9 h 30 m** | **3 h 45 m** |
| Vehicles released | 20,193 | 20,193 |
| People evacuated | 35,388 | 35,388 |
| Vehicles in hazard at burnover | **3,797** | **0** |
| People in hazard at burnover | 6,593 | 0 |
| Peak vehicle exposure (any time) | 6,949 (T+4h) | 317 (T+2h50) |
| Peak standing queue | 54.7 km | 11.4 km |
| Mean egress utilisation | 42% | 82% |
| Not out by end of window | 8 | 8 |

Both runs release the same vehicles and evacuate the same people. That row exists in the table
because it did not always hold — see "The demand-parity bug" below.

The utilisation pair is the compact statement of the whole product: the baseline leaves 58% of
the town's egress capacity unused *while people queue*, because everyone is on the same road.

### Caveats carried, not buried

- **Closed edges count exposure but do not gate throughput.** Strict gating deadlocks the run —
  the interpolated footprint closes 4,008 of 4,905 edges, including corridor throats, by about
  T+4h. Named in the script header and in `validation.note`.
- Modelled baseline 9 h 30 m sits inside the 6–10 h range reported for the real evacuation, at
  its upper end; `observedClearanceApprox` is the midpoint and is flagged approximate. The
  independent closed-form check puts the binding corridor (Pentz) at 9.23 h against the
  simulation's 9.5 h — 3% apart, on two different methods.
- Shadow evacuation is charged to **both** runs, not to the plan alone. 18% of households leave
  unprompted whether or not anyone stages the release, so it cannot be a cost of staging.
- `BUT-CON-513` (4 households) has no routable egress. Reported unassigned rather than invented.
- Two buses to Concow have **negative slack**: the fire reaches Concow at T+35 m and no depot
  can beat it. Kept in the output because it is true, and because "we cannot reach these people
  in time" is exactly the finding an operator needs.
- 4 of 34 shelters fall inside the hazard footprint and are withdrawn as destinations.

The model is a corridor queue — `demand − served = queue` — not a time-expanded flow solver
with spill-back. Roughly fifty lines. That limitation is in the script header and should be
said out loud: the gridlock signature is reproduced as a standing queue and a utilisation gap,
not as physical back-propagation.

---

# CONTEXT LAYERS — verified 2026-08-19

Environmental and exposure layers, added by `scripts/fetch-context-layers.ts`, writing
`public/data/<scenario>/context/`. Same house rule as everything above: each row is what was
actually fetched, not what a doc page promised. **Seven of eight built for camp-fire-2018,
285 KB total, zero API keys.**

## Open-Meteo AIR QUALITY — LIVE but DOES NOT REACH 2018. Read this before wiring it.

```
https://air-quality-api.open-meteo.com/v1/air-quality
  ?latitude=39.7596&longitude=-121.6219
  &hourly=pm2_5,pm10,us_aqi,carbon_monoxide
  &start_date=2018-11-08&end_date=2018-11-08&timezone=GMT
```

`HTTP 200`. Correct schema. Correct units. **Every hourly value is `null`.**

This is the worst failure mode in the whole project's source list, because nothing about the
response says it failed — status is 200, `hourly.time` is a full 24-element array, only the
value arrays are null. An integration that trusts the status code ships an empty layer that
looks like a working one.

Earliest date carrying values, found by binary search against the live API rather than read
from docs:

| Probe date | Result |
|-----------|--------|
| 2013-01-01 | null |
| 2018-11-08 | null |
| 2021-06-01 | null |
| 2022-07-29 | null |
| **2022-08-04** | **first date with data** |
| 2023-01-01 | data |

So the archive floor is **~2022-08-04**. Marshall Fire (2021) is also below it. Only
`conyers-plume-2024` can use this endpoint.

`OPEN_METEO_AQ_FLOOR` in the script encodes this, and the open-meteo path additionally
asserts that at least one value is non-null before accepting the response — a 200 with an
all-null block is treated as a hard failure, loudly.

## AirNow historical — CONFIRMED LIVE, keyless. This is the pre-2022 answer.

```
https://files.airnowtech.org/airnow/2018/20181108/monitoring_site_locations.dat
https://files.airnowtech.org/airnow/2018/20181108/HourlyData_2018110816.dat
```

Both `200`. Site file 1.8 MB, one hourly file 1.3 MB, nationwide, pipe-delimited, no header.

```
site:   AQSID|param|siteCode|siteName|status|agencyCode|agencyName|region|lat|lon|...
hourly: MM/DD/YY|HH:MM|AQSID|SiteName|GMTOffset|Param|Units|Value|Agency
```

Sites are listed **once per parameter**, so the same monitor appears several times — dedupe on
AQSID or the station count triples.

### What the Camp Fire data actually shows — and it is not what you would guess

34 PM2.5 monitors within 150 km, 25 reporting. Hourly values through the scenario window
(14:00–22:00 UTC = 06:00–14:00 PST):

| UTC | PST | Chico East | Gridley | Yuba City | Auburn |
|-----|-----|-----------|---------|-----------|--------|
| 14Z | 06:00 | 6 | 6 | 10 | 4 |
| 16Z | 08:00 | 4 | 8 | 10 | 5 |
| 18Z | 10:00 | 4 | 15 | 26 | 18 |
| 19Z | 11:00 | 3 | **38** | 38 | 14 |
| 20Z | 12:00 | 7 | 27 | **56** | 18 |
| 22Z | 14:00 | 5 | 13 | 20 | **39** |

**Chico — 20 km due WEST of Paradise — never rises above 17 all morning. Gridley, Yuba City
and Auburn, all to the SOUTH, climb steadily from 10:00 PST.**

That is an independent observational confirmation of the northeast wind already verified from
the Open-Meteo archive at the top of this file. The smoke did not go west into Chico; it went
south down the Sacramento Valley, exactly as a 21–52° wind requires. Two unrelated agencies'
instruments agreeing is a much stronger claim than either alone.

The catastrophic Chico readings everyone remembers came **days later**, not during the
evacuation. Do not claim them for this window.

### The Paradise monitor

`060072001 Paradise - Birch Street` (39.7539, -121.6244) is in the site list and is
**silent for every hour of the event day.** It published nothing.

This is a finding, not a gap. The payload carries `reporting: false` and the map draws it as a
hollow ring rather than as a zero — a monitor inside the burn footprint that stopped
publishing is information, and rendering it as clean air would erase it.

## NOAA HMS smoke polygons — CONFIRMED LIVE, keyless, and time-varying

```
https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/2018/11/hms_smoke20181108.kml
```

`200`, 143,941 bytes, **136 placemarks**. Shapefile equivalent also `200` at
`.../Shapefile/2018/11/hms_smoke20181108.zip` (22 KB), but the KML needs no zip reader.

**Filename trap:** it is `hms_smoke20181108.kml`. `smoke20181108.kml` — the obvious guess, and
the name used in several third-party write-ups — returns `404`. The directory listing at
`.../KML/2018/11/` is browsable and settles it in one request.

Each polygon carries its satellite analysis window inside the description CDATA:

```
Start Time: 2018312 1400UTC
End Time:   2018312 1600UTC
Density:    Light
Satellite:  GOES-EAST
```

`2018312` is **year + day-of-year**, not year-month-day. Day 312 of 2018 is 8 November.
Parsing it as `2018-31-2` yields a silently wrong date.

There is no `<TimeSpan>` or `<when>` element anywhere in the file — the timing lives only in
that free-text description, so it must be regex-extracted. 23 plumes (14 light, 5 medium,
4 heavy) overlap the Camp Fire scenario window within 3° of the bbox, in 2-hour steps. Genuine
observed time variation, not a daily composite.

Placemarks without a `Density:` line are legend, logo and overlay chrome. Requiring a density
is what separates data from decoration.

## HIFLD transmission lines — CONFIRMED LIVE, keyless

```
https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/
  Electric_Power_Transmission_Lines/FeatureServer/0/query
```

**34 segments** in the padded Paradise bbox. All but one owned by **Pacific Gas & Electric**.

| Voltage | Segments |
|---------|----------|
| 115 kV | 17 |
| 230 kV | 13 |
| 500 kV | 4 |

Named substation pairs come back real: `PARADISE–BUTTE`, `TABLE MT.–RIO OSO`, `POE–RIO OSO`,
`PALERMO–BIG BEND`. The bbox needs padding by ~0.18° — the line that starts a fire is rarely
inside the town it burns.

`VOLTAGE` uses `-999999` for "not published", which becomes a zero-kV line at the bottom of
any width ramp unless nulled explicitly.

## CDC/ATSDR SVI — CONFIRMED LIVE, keyless via the state CSV

```
https://svi.cdc.gov/Documents/Data/2018/csv/states/California.csv
```

`200`, 4.9 MB. Filed under the **full state name**, not the abbreviation.

The ArcGIS routes are dead ends: `onemap.cdc.gov/arcgis/rest/services/SVI/...` returns `404`,
and the HIFLD org that hosts the transmission service carries no SVI layer. The CSV is the
supported path.

Geometry must come from **TIGERweb of the matching vintage** — SVI 2018 is built on 2010-vintage
tracts, so `tigerWMS_ACS2018`, not `tigerWMS_ACS2022`. Join is on the 11-digit `FIPS` column
against `GEOID`. **Result: 11 tracts, 100% join.** The script prints the join rate and warns
below 99% — a silent partial join is this project's signature failure (see `B25044_E003`).

Suppressed values are `-999`, which must become `null`. Zero is a real percentile rank; `-999`
is an absence, and folding the two together makes suppressed tracts look invulnerable.

## NWS alerts — the historical archive DOES NOT reach 2018. Use IEM.

```
https://api.weather.gov/alerts?area=CA&start=2018-11-08T00:00:00Z&end=2018-11-10T00:00:00Z
```

`200`, `"features": []`, with a title that cheerfully confirms the window it found nothing in.
Empty, not an error. The live `/alerts/active` endpoint works but **rejects a `limit`
parameter outright** (`400`, `query.limit is not recognized`) — a copied paging idiom fails
here.

### IEM VTEC archive — CONFIRMED LIVE, keyless, and it has the real warning

```
https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py
  ?sts=2018-11-06T00:00Z&ets=2018-11-10T00:00Z&accept=csv
```

`200`, 644 KB, nationwide, one row per UGC zone per product.

**Trap: `limit0=yes` silently guts the result.** With it the same query returns a set with
zero fire-weather rows for California, which reads exactly like "there were no warnings." It
was the first thing tried and it cost a round of investigation. Drop the parameter.

`accept` only takes `shapefile|excel|csv|kml` — `geojson` returns `422`.

The real product in force over the Camp Fire, from the archive:

| Office | Product | Issued (UTC) | Expires (UTC) | Zones |
|--------|---------|--------------|---------------|-------|
| **STO** | **Red Flag Warning** | **2018-11-07 21:22** | **2018-11-09 15:00** | 16 |
| STO | Wind Advisory | 2018-11-08 06:00 | 2018-11-09 05:08 | 12 |
| EKA | Red Flag Warning | 2018-11-08 06:00 | 2018-11-09 06:00 | 2 |
| MTR | Red Flag Warning | 2018-11-08 06:00 | 2018-11-09 15:00 | 3 |

Product id `201811072122-KSTO-WWUS86-RFWSTO`. **A Red Flag Warning was in force over Butte
County before the fire started and through the entire evacuation.** Real, citable, keyless.

### But those warnings have NO drawable geometry

The UGC zones the 2018 products reference — `CAZ214`, `CAZ216`, `CAZ218`, `CAZ221`, `CAZ266` —
have since been retired. Every lookup fails:

| Attempt | Result |
|---------|--------|
| `api.weather.gov/zones/fire/CAZ214` | `404` |
| `api.weather.gov/zones/forecast/CAZ214` | `404` |
| `...?effectiveDate=2018-11-08T12:00:00Z` | `400` |
| `mesonet.agron.iastate.edu/api/1/nws/ugc/CAZ214.geojson` | `404` |

`api.weather.gov/zones?type=fire&area=CA` lists 216 KB of **current** zones; the retired ids
are simply not in it.

**So the archived advisories ship with real times, zones and product ids and no polygon.** The
map draws only the live alerts, which do carry geometry (5 of 7 resolvable at fetch time), and
`activeArchiveAdvisories()` surfaces the historical ones as a timeline band. Inventing a
footprint for a retired zone would be exactly the kind of untraceable number CLAUDE.md forbids.

## NIFC historical perimeters — a NEW trap, the inverse of the documented one

The section above records that querying with the wrong field names returns `400 Invalid field`,
"which reads like a dead endpoint but is a schema mismatch." **In `f=geojson` mode it does not
even do that.**

```
outFields=INCIDENT,FIRE_YEAR_INT,GIS_ACRES,UNQE_FIRE_     -> 200, 82 bytes, features: []
outFields=INCIDENT,FIRE_YEAR_INT,GIS_ACRES,UNQE_FIRE_ID   -> 200, 29 KB,   features: [...]
```

The field is `UNQE_FIRE_ID`. Requesting `UNQE_FIRE_` returns **HTTP 200 with an empty
FeatureCollection** — no error object, no message. It reads as "no fires have ever burned
here," which for this bbox is absurd but not obviously so for a bbox you do not know.

**When an Esri geojson query returns zero features, check the field names before believing
the geometry.** `returnCountOnly=true&f=json` on the same `where` clause settles it in one
request: it ignores `outFields` entirely, so a non-zero count against an empty geojson result
localises the fault immediately.

Full field list, confirmed:
`OBJECTID, IRWINID, FORID, INCIDENT, GIS_ACRES, UNQE_FIRE_ID, DATE_CUR, FIRE_YEAR_INT,
UNIT_ID, POO_RESP_I, LOCAL_NUM, FEATURE_CA, MAP_METHOD, COMMENTS, GEO_ID, SOURCE, AGENCY,
FIRE_YEAR, GlobalID`

`maxRecordCount: 2000`, `supportsPagination: true` — page on `resultOffset`, and order by
`GIS_ACRES DESC` so a truncated pull keeps the scars that matter.

**112 prior perimeters over 250 acres, 1900–2017,** in the Paradise bbox. Largest is CAMPBELL
1990 at 131,504 acres. `PENTZ` 1966, `SKYWAY` 2002 and — with no irony available —
`POWER LINE #1` 1954 all sit on the terrain the town evacuated across.

## Elevation — Open-Meteo meters by LOCATION, not by request

`api.open-meteo.com/v1/elevation` accepts 100 coordinate pairs per call and answers correctly
for a single batch. A 40×40 grid is 1,600 points across 16 calls, and it fails:

```
{"reason":"Minutely API request limit exceeded. Please try again in one minute.","error":true}
```

Spacing the batches does not help, because the quota counts **locations inside a rolling
minute**, not requests. Retrying a 429 is worth doing (it is the one 4xx that fixes itself) but
will not carry a grid this size.

**OpenTopoData is the working primary:**

```
https://api.opentopodata.org/v1/srtm30m?locations=<lat,lng|...>
```

`200`, 100 locations in ~600–1000 ms. Published limits — 100 locations per call, 1 call/sec,
1000 calls/day — fit a 1,600-point grid with room to spare. `aster30m` also responds and
agrees with `srtm30m` to within ~2 m on the sampled cells.

Slope is Horn's standard 3×3 finite difference over the sampled grid — arithmetic on measured
elevations, not a model. Paradise bbox at 40×40 (~449 × 442 m cells): **max 22.1°, 48 cells at
or above 15°.**

The `spreadFactor` field is explicitly a **rule of thumb** (head-fire spread roughly doubles
per 10° of upslope), is labelled as such in the payload note, and is not what the layer colours
by. It must never be quoted as a predicted rate of spread.

## NASA FIRMS — still unverified. No key present.

`FIRMS_MAP_KEY` is not set, so the FRP layer is **skipped cleanly**: the manifest records
`available: false` with the reason, the rail shows the row disabled rather than hiding it, and
nothing is substituted. The code path is written and activates the moment a key exists —
archive products are `VIIRS_SNPP_SP` and `MODIS_SP` (the NRT feeds hold only ~2 months, so the
NRT product names will return nothing for 2018).

Free key, instant: https://firms.modaps.eosdis.nasa.gov/api/area/

## One more trap, ours rather than an upstream's

Ramer–Douglas–Peucker **degenerates on a closed ring.** A polygon's first and last vertex are
identical, so the seeding segment has zero length, every perpendicular distance to it computes
as zero, nothing clears the tolerance, and the "simplified" ring comes back at full vertex
count. It fails silently and in the safe direction, which is why it survived a whole run.

Measured on the first build, before the fix:

| Payload | Features | Points | Size |
|---------|----------|--------|------|
| svi.json | 11 | 18,804 | 404 KB |
| burn-scars.json | 112 | 87,935 | 1,881 KB |
| fire-weather.json | 22 | 8,756 | 195 KB |

Seeding the recursion from the vertex farthest from the start splits the ring into two open
chains RDP can actually work on. Same tolerances, after:

| Payload | Size | Change |
|---------|------|--------|
| svi.json | 13.9 KB | −97% |
| burn-scars.json | 56.6 KB | −97% |
| fire-weather.json | 14.1 KB | −93% |

Total context payload **2,527 KB → 285 KB**, with no visible difference at town scale.

## Summary — camp-fire-2018 context build

| Layer | Records | Size | Provenance | Time-varying |
|-------|---------|------|------------|--------------|
| airQuality | 34 monitors | 7.6 KB | observed | yes |
| smoke | 23 plumes | 13.1 KB | observed | yes |
| transmission | 34 segments | 20.3 KB | observed | no |
| socialVulnerability | 11 tracts | 13.9 KB | observed | no |
| fireWeather | 22 products | 14.1 KB | observed | yes |
| slope | 1,600 cells | 151.0 KB | observed | no |
| burnScars | 112 perimeters | 56.6 KB | observed | no |
| fireIntensity | — | — | — | **unavailable, needs FIRMS_MAP_KEY** |

**285 KB, seven layers, zero keys, every one observed.** No layer in this build is modelled;
the `provenance: "modelled"` path exists, is carried through the manifest into the toggle
label, and is currently unused — which is the outcome to want.

---

## Building footprints: the obvious source is the wrong vintage

Microsoft's Global ML Building Footprints is the standard answer for US building
coverage, and for this scenario it is quietly wrong. **The current release (2026-02-03) is
built from post-fire imagery.** Paradise burned in 2018; the footprints reflect what is there
now, not what was there to evacuate.

Measured against Butte County's own `StructureC` field:

| Community | ML footprints | County structures | Ratio |
|-----------|--------------|-------------------|-------|
| Town of Paradise | 5,884 | 14,877 | **0.40** |
| Butte Valley (unburned control) | — | — | **1.44** |

The control is what settles it. If ML simply under-covered rural California, the unburned
community would show a similar deficit. It runs *over* 1.0. So the Paradise gap is vintage, not
coverage — and shipping ML alone would have drawn **40% of the town**, silently baking the
fire's destruction into the "before" picture of an evacuation planner.

### What we use instead

**CAL FIRE DINS** (Damage Inspection) — `POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0`, keyless,
verified live. It is the post-event inspection record, which means it enumerates structures that
*existed before* the fire, including the ones destroyed. Joined to ML outlines within 28 m so
surviving structures get a real traced footprint.

Result: **31,233 structures** — 15,796 traced outlines, 15,437 derived as 12.9 m squares from
inspection points where nothing was ever rebuilt (tagged `derived-from-point`, never presented
as surveyed geometry). 23,317 inspected, **18,762 destroyed** against a historical record of
roughly 18,800. 20,688 reached by the hazard footprint.

Paradise now cross-checks at 1.16 against the county count — DINS counts outbuildings the county
does not, plus uninspected rebuilds carried as presence `imagery`.

OSM was rejected outright: 1,533 building ways in the entire bbox. Overture was skipped because
it ingests the same Microsoft ML data and inherits the same vintage.

### The same trap in the census

Blocks use the **2010** decennial, not 2020, for exactly the same reason: the 2020 count is of a
burned Paradise. 1,482 blocks, population 47,264, 23,320 housing units, from TIGERweb
`tigerWMS_Census2010` layer 18.

**General lesson worth carrying:** for any historical disaster scenario, every "current" dataset
is a post-disaster dataset. Check the vintage of anything describing the built environment
before trusting it as the pre-event picture, and keep an unaffected control area to tell vintage
from coverage.

---

# Palisades Fire, Pacific Palisades — 7 January 2025

Verified: 2026-08-19. Same rule as everything above: every row is something that was actually
called and whose response was read. Scenario id `palisades-fire-2025`, bbox
`-118.61, 34.012, -118.505, 34.125`, T+0 = 10:00 PST.

## What came back real

| Source | Result |
|--------|--------|
| Overpass | 2,270 drivable ways → **3,070 nodes, 3,658 edges, 24 sinks**, 96.3% on one component |
| Open-Meteo ERA5 archive | 72 hourly rows for 6–8 Jan 2025, keyless |
| Census ACS 2019–2023 via data.census.gov | 6,591 LA County block groups per table, keyless; **36 inside the bbox** |
| TIGERweb `tigerWMS_ACS2023` | block groups = layer 10, counties = layer 82 |
| CAL FIRE incidents API | the incident record, including origin point and start instant |
| NIFC WFIGS Interagency Perimeters | **one** perimeter, 23,448 acres |
| LA County DPH `Evacuation_Zones_Jan_13_2025` | the Genasys zones as they stood during the fire |
| FEMA OpenFEMA IPAWS archive | **43 real CAP alerts** from LA City and LA County, 7–8 Jan |
| HIFLD (fire stations, hospitals, schools, nursing homes, mobile home parks) | 1,422 facilities in the padded query envelope, 26 strictly inside the bbox |

Zero keys were used. `CENSUS_API_KEY` and `FIRMS_MAP_KEY` are both unset; the keyless paths
carried the whole build.

---

## Los Angeles held Pacific Palisades in ONE evacuation zone

This is the finding the scenario exists for.

```
https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Evacuation_Zones_Jan_13_2025/FeatureServer/0/query
  ?where=1=1&outFields=*&outSR=4326&f=geojson
```

`HTTP 200`. 267 features statewide (each zone appears twice — **dedupe by `zone_id` before
counting anything**), 61 unique zones in the Palisades/Malibu/Topanga envelope, 21 inside the
scenario bbox. Snapshot committed at `research/snapshots/la-evac-zones-2025-01-13.geojson`.

The layer is LA County Public Health's copy of the live Genasys Protect (formerly Zonehaven)
zones, carrying `zone_id`, `zone_status`, `est_population`, `acreage`, the bounding street
names, and a `protect.genasys.com` URL per zone. It is a snapshot of operational state during
the fire, not a static boundary file — better provenance than the Butte layer, which was
fetched years after its event.

And the community sits inside a single record:

| Field | Value |
|-------|-------|
| `zone_id` | **LOS-Q0767** |
| `zone_status` | Evacuation Order |
| `acreage` | **19,634** |
| `est_population` | **30,447** |
| `north_of` / `south_of` | La Mesa Dr, Pacific Coast Hwy / Farmer Fire Rd |
| `east_of` / `west_of` | Topanga Canyon Blvd / N Kenter Ave |

Thirty thousand people, nineteen thousand acres, one release unit. The neighbouring zones are
normally sized — LOS-Q0779 is 695 acres, TOP-U007 is 815 — so this is not how the system is
built; it is how this particular community was drawn.

**Staged release was not available to the incident commander on 7 January because the zone
system had nothing to stage.** That is not an argument about software. It is a field in a
published layer.

### Why `fetch-evac-zones.ts` deliberately does not consume it

Feeding LOS-Q0767 to `build-zones.ts` would produce a map with one zone holding 65% of the load
and a release sequence with one wave — an exact reproduction of the failure, and useless as a
counterfactual. The Palisades therefore runs the **derived** path: 25 clustered sub-zones keyed
`PAC-E001`…`PAC-E025`, with ids that are deliberately ours and deliberately not `LOS-Q****`, so
nothing here can be mistaken for something the county published. The official zone is carried
alongside as a population anchor and as the honest cross-check. The reason is recorded in a
comment at `OFFICIAL_ZONE_SOURCES`.

---

## The IPAWS archive has the actual evacuation orders, timestamped

```
https://www.fema.gov/api/open/v1/IpawsArchivedAlerts
  ?$filter=sent ge '2025-01-07T18:00:00.000Z' and sent le '2025-01-08T08:00:00.000Z'
```

55 alerts nationwide in that window, **43 of them from LA City Public Alerts / LAFD and LA
County OEM**. Snapshot at `research/snapshots/ipaws-palisades-2025-01-07.json`, including the
raw CAP 1.2 XML of the order below.

Against a fire reported at **18:30Z = 10:30 PST**:

| UTC | Local | T+ | Sender | What |
|-----|-------|-----|--------|------|
| 19:12:52 | 11:12 | +4,372 s | LAFD | "Wildfire Alert: Palisades Fire" — get set, not an order |
| 19:52:48 | 11:52 | +6,768 s | LA County Fire | First **Evacuation Order** — Sunset Mesa only |
| **20:07:27** | **12:07** | **+7,647 s** | **LAFD** | **Evacuate now, order for the Palisades Area.** Polygon covers the whole community |
| 20:41:41 | 12:41 | +9,701 s | LA County Fire | Big Rock evacuation order — PCH **west** |
| 00:42:03 | 16:42 | +24,123 s | LA County Fire | Topanga Canyon evacuation orders |

The 12:07 alert carries a four-vertex polygon spanning `-118.596,34.1032` to `-118.4958,34.1038`
to `-118.5359,34.0356`. One order, one polygon, the entire Palisades. **Ninety-seven minutes
after ignition, thirty thousand people were told to leave at the same instant.**

This is the same OpenFEMA endpoint the Rockdale County CAP came from, so the alert composer can
put a real Palisades order beside a generated one on this scenario too.

---

## The perimeter archive is worse here than it was for the Camp Fire

Checked and ruled out, in order:

- **NIFC GeoMAC daily-progression layers stop at 2019.** `Historic_Geomac_Perimeters_2018`
  exists; there is no 2025 sibling.
- **`InterAgencyFirePerimeterHistory_All_Years_View` has no 2025 records at all.**
  `INCIDENT='PALISADES' AND FIRE_YEAR_INT=2025` returns `[]` — not an error, just empty.
- **NASA FEDS** (VIIRS-derived 12-hourly perimeters) is live and keyless at
  `openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive`, and it does
  cover this bbox — with **108 features from the 2021 Palisades fire**. The archive ends before
  2025 and the `_nrt` collections only carry the current year. The NASA Disasters mirror the
  ArcGIS item points at (`maps.disasters.nasa.gov/ags03/...`) is **404** — that host is now a
  static site.
- Third-party ArcGIS items exist ("Internal Draft — Palisades Fire Progression", "LA County
  Trails Overlay Heat Perimeters"). The heat-perimeter layer has **41 features and no time
  field at all**. Not usable, and not authoritative.

What does exist:

```
https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0/query
  ?where=attr_UniqueFireIdentifier='2025-CALFD-000738'&outFields=*&f=geojson
```

One feature. `poly_GISAcres` 23,448, `poly_MapMethod` "IR Image Interpretation", MultiPolygon
with 16 parts (one holds 98.7% of the area). Schema note that costs time: this service uses
`poly_*`/`attr_*`; the historic layer uses `INCIDENT`/`FIRE_YEAR_INT`. Crossing them returns
`400 Invalid field`, which reads like a dead endpoint.

### A trap in that record

`poly_PolygonDateTime` = 2025-01-08T14:31:44Z. `poly_DateCurrent` = 2025-01-21T22:23:48Z. The
**geometry is the final extent**: 23,448 acres is the fire's final size and matches
`attr_IncidentSize` on the record and `AcresBurned` on the CAL FIRE incident, both of which are
end-of-incident values, and `poly_DateCurrent` is three weeks after the instant the polygon
claims to depict. So the polygon instant and the polygon do not describe the same fire.

`fetch-hazard.ts` uses `poly_PolygonDateTime` anyway, and says why in a comment:
`poly_DateCurrent` puts the anchor two weeks out and flattens the modelled in-window fire to
about eleven acres. Neither field is right; the polygon instant is the less wrong one.

### One heuristic had to change

The wildfire frame builder prefers the **observed run bearing** — ignition to burnt-area centroid
— over the wind bearing when an observation exists, because for Paradise ERA5's surface wind
veers west while the fire is still driving southwest. For the Palisades that rule fired
backwards: the only anchor is three weeks of westward spread into Malibu, so its centroid gave a
**275° run** while the wind gave **201°**, and the fire spent the replayed eight hours running
south to the coast.

`buildWildfireFrames` now requires the anchor to lie **inside the replay window** before its
centroid is allowed to orient the fill. Camp Fire's anchor is at T+14,100 s against a 28,800 s
window and is unaffected; the Palisades anchor at T+73,904 s is not, so wind orients it. Edges
closed by T+8h went from 494 (fire running west, away from the town) to 992. Camp Fire's runs
were regenerated after the change and reproduced to the second at the time: baseline 27,600 s,
planned 13,500 s, 1,123 vehicles exposed, 42% / 79% utilisation. Those baseline figures were
later superseded by the demand-parity fix below; the planned run is unchanged at 13,500 s.

### What the payload actually says

**97 frames, 0 observed, 97 interpolated.** Worse than Camp Fire's 1-in-97, and the UI must say
so. The one observation is 20.5 hours past the end of the replay.

Modelled area over the window:

| Local | Modelled |
|-------|----------|
| 12:00 | ~240 acres |
| 14:00 | ~890 acres |
| 16:00 | ~2,230 acres |
| 18:00 | ~4,010 acres |

**There is nothing to check that against.** No archived record of this fire's acreage during the
afternoon of 7 January turned up in any of the sources above — CAL FIRE's incident API carries
final state only, and the ICS-209 fields on the WFIGS record are the closing report. Every
contemporaneous news figure for that afternoon is much larger than this curve, but those are
recalled, not retrieved, so no number from them appears here or in the payload.

What can be said without a citation is the direction of the error. Quadratic wind-run growth
toward a distant anchor is slow at the start by construction, and the fire that ran to the coast
inside the first afternoon was not. So the early frames are a **lower bound on the fire**, every
exposure and cut-off figure on this scenario is **optimistic**, and
`run_baseline.validation.note` says exactly that. A baseline that clears before the fire arrives
is the model failing to catch the fire up, not evidence that the roads were adequate.

---

## Wind — real, and correctly Santa Ana

```
https://archive-api.open-meteo.com/v1/archive
  ?latitude=34.06&longitude=-118.542&start_date=2025-01-06&end_date=2025-01-08
  &hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m
  &timezone=GMT&wind_speed_unit=ms
```

Grid cell 34.0598, -118.5750 at 198 m. Scenario window, T+0 = 2025-01-07T18:00Z:

| UTC | Local | Speed | Direction | Gust | RH |
|-----|-------|-------|-----------|------|-----|
| 18:00 | 10:00 | 6.99 m/s | 13° | 16.80 m/s | 34% |
| 19:00 | 11:00 | 7.93 | 15° | 19.00 | 29% |
| 20:00 | 12:00 | 7.89 | 27° | 19.20 | 24% |
| 21:00 | 13:00 | 8.08 | 25° | 19.70 | 18% |
| 22:00 | 14:00 | 8.04 | 24° | **19.80** | 16% |
| 02:00 | 18:00 | 6.60 | 21° | 17.00 | 12% |

Direction 13–27° is **north-northeast**: offshore, down-canyon, blowing toward 193–207°, which
is the coast. Relative humidity falls from 34% to 12% across the window. That is a textbook
Santa Ana profile and the reanalysis reproduces it without being told.

**The speeds are a floor, not the event.** Peak gust in the ERA5 cell is 19.8 m/s (44 mph). The
cell sits at 198 m elevation on a ~0.1° grid and cannot resolve a canyon jet, so it damps the
ridge-top gusts this event was known for — no station figure was fetched here, and none is
asserted. Same caveat as Paradise, larger. Use the *direction* with confidence; treat *speed*
as a lower bound.

---

## The road network, and where the funnel actually is

Road length inside the bbox, from the built network:

| Class | Length |
|-------|--------|
| residential | 216.5 km |
| service | 109.6 km |
| tertiary | 36.5 km |
| secondary | 18.6 km |
| **trunk** | **16.4 km** |
| primary | 13.5 km |
| unclassified | 2.8 km |
| **motorway** | **0 km** |

Local-to-arterial is **3.9:1**, against Paradise's 18:1 — and read naively that says the
Palisades is better served. It is not; the metric is diluted. The arterial kilometres include
Santa Monica's grid at the southeast corner and Topanga's roads at the northwest, neither of
which is Palisades egress. Every trunk kilometre in the box is one road:

- **trunk:** Pacific Coast Highway, Palisades Beach Road (its Santa Monica continuation)
- **primary:** Topanga Canyon Boulevard, California Incline
- **secondary:** West Sunset Boulevard, Temescal Canyon Road, San Vicente, Ocean Ave, Marquez

Four corridors leave the community. Their throats, from the lane counts in `network.json` and
`LANE_CAPACITY`:

| Corridor | Class | Lanes | veh/hr |
|----------|-------|-------|--------|
| Pacific Coast Highway, east toward Santa Monica — sink at -118.506, 34.020 | trunk | 3 | 5,100 |
| Pacific Coast Highway, west toward Malibu — sink at -118.608, 34.037 | trunk | 2 | 3,400 |
| West Sunset Boulevard, east toward Brentwood | secondary | 2 | 1,800 |
| N Topanga Canyon Boulevard, north | primary | 1 | 1,000 |
| **Total** | | | **11,300** |

Directions were checked against the sink node coordinates in `network.json`, not assumed: the
two-lane throat is the west edge, the three-lane throat is the east edge. PCH widens to four
lanes (6,800) in the last 200 m before the Santa Monica line, but the three-lane section is the
throat traffic actually passes through, so 5,100 is the figure used.

Palisades Drive, Temescal Canyon Road and Chautauqua Boulevard are **absent from that table on
purpose**. None of them leaves the community. All three drain into Sunset or PCH. `build-zones`
found them anyway — every derived zone's route reads *West Sunset Boulevard → Pacific Coast
Highway*, *Temescal Canyon Road → Pacific Coast Highway*, *West Sunset Boulevard → Chautauqua
Boulevard → Pacific Coast Highway*. Nobody told the pipeline those were the roads. It is the
same result as Skyway/Clark/Pentz/Neal falling out of OSM for Paradise.

### Palisades Drive

The road the footage is of. From `network.json`, south to north:

| Section | Class | Lanes | Capacity | Length |
|---------|-------|-------|----------|--------|
| Sunset up to ~34.072 | tertiary | 2–3 | 1,600–2,400 | 4.1 km |
| ~34.068 to the top of the Highlands | tertiary | **1** | **800** | **3.5 km** |

**One lane, 800 vehicles per hour, three and a half kilometres, and it is the only road out of
the Highlands.** The three derived zones keyed to it hold **2,016 households / 5,473 people**.

---

## THE ARITHMETIC OF THE PALISADES

Same method as the Paradise section: summed corridor capacity against vehicles, no simulation.
Division over open data.

### Two population anchors, and they are built differently

| Anchor | Households | Basis |
|--------|-----------|-------|
| County zone LOS-Q0767 | **12,259** | `est_population` 30,447 ÷ 2.484 persons/household |
| ACS 2019–2023, bbox | **20,846** | direct household count, 36 block groups |

They are **not symmetric**, and the asymmetry has to be stated. The county publishes a
*population* for the ordered community and no household count, so it has to be divided by the
ACS persons-per-household for the same footprint to become vehicles. The ACS anchor is a direct
household count but covers the whole bbox, including block groups that spill into Santa Monica
and Brentwood where no order was issued.

Areally apportioning the ACS cells into the LOS-Q0767 polygon gives **25,922 people / 9,910
households** — 15% below the county's own 30,447. The two anchors bracket it. Both are real,
they disagree, and reporting the pair is more honest than picking the flattering one.

### At 1.4 vehicles per evacuating household

| | Lower anchor (17,163 veh) | Upper anchor (29,184 veh) |
|---|---|---|
| Distributed across all four corridors — 11,300 veh/hr | **1.52 h** | **2.58 h** |
| **As the fire left them — PCH east + Sunset only, 6,900 veh/hr** | **2.49 h** | **4.23 h** |
| Funnelled onto PCH east alone — 5,100 veh/hr | **3.37 h** | **5.72 h** |
| Distributed, PCH east contraflowed — 16,400 veh/hr | **1.05 h** | **1.78 h** |

The second row is not hypothetical. **PCH west was under its own evacuation order (Big Rock) at
12:41 PST, two hours and eleven minutes after ignition, and Topanga Canyon was ordered evacuated
the same evening** — both from the IPAWS records above, both zones under Evacuation Order in the
Genasys snapshot. The corridor set that existed on paper was 11,300 veh/hr. What the fire and
the orders left was 6,900.

### And before any of that, the Highlands

2,016 households × 1.4 = **2,822 vehicles**, through a single-lane throat at 800 veh/hr:

**3.53 hours to get out of the Highlands and onto Sunset.** Not out of town. Onto Sunset, where
they join everyone else.

They were ordered at 12:07 PST. Three and a half hours is 15:40. The fire was in the community
long before that, and the queue on Palisades Drive is the one people walked away from.

### What the sentence is

> Pacific Palisades had four ways out and 11,300 vehicles an hour of capacity between them, and
> on paper that clears the community in an hour and a half to two and a half hours. Los Angeles
> ordered all thirty thousand people at 12:07, ninety-seven minutes after ignition, because its
> zone map gave it exactly one zone to order. Two of the four corridors were gone within another
> half hour. The three thousand vehicles behind the Highlands' single lane needed three and a
> half hours just to reach Sunset.

Nothing in that is a model. Household counts are ACS. Zone population, acreage and status are
the county's own published layer. Order times are archived federal CAP records. Lane counts are
OSM; capacity is a published per-lane figure. The rest is division.

### The simulation, for comparison

`simulate.ts` on the derived zones, 20,846 households, 1,129 of them with no vehicle:

| | Baseline | Planned |
|---|---|---|
| Clearance | 2h 55m | 2h 20m |
| Peak standing queue | **98.7 km** | 22.8 km |
| Mean egress utilisation | 80% | 79% |
| Contraflow orders | 0 | 3 |

Its own closed-form check agrees with the table above: 18,355 vehicles, 2.32 h distributed,
2.91 h with PCH binding. The simulation's contribution is *where and when* the 98.7 km of
standing queue forms — the closed-form arithmetic already settles whether it forms.

### Two corrections the scenario forced in the solver

`CORRIDOR_CAPACITY` was a flat table of the five Paradise ridge roads. On the Palisades every
name missed, so no corridor counted as `primary`, the aggregate denominator was zero, and the
run shipped **`meanEgressUtilization: 0` and a `NaN` in the closed-form check** — a silently
meaningless payload rather than a failure. It is now `CORRIDOR_CAPACITY_BY_SCENARIO`, and a
scenario with no entry prints a loud note naming exactly what will read zero.

`validationFor()` had the same shape of bug and was worse: it asserted Paradise's observed
narrative, and Paradise's 6–10 hour clearance range, onto any scenario's baseline run. It is now
keyed by scenario, and for an unknown scenario it returns `undefined` — no validation block at
all — rather than borrowing another event's facts.

---

## Ignition point — fetched twice, and the two records disagree

| Source | Point | Instant |
|--------|-------|---------|
| CAL FIRE `incidents.fire.ca.gov/umbraco/api/IncidentApi/List?year=2025` | **-118.54453, 34.07022** | 2025-01-07T18:30:00Z |
| NIFC `WFIGS_Incident_Locations` | -118.55112, 34.06778 | 2025-01-07T18:30:00Z |

The instants agree to the minute. The points are **750 m apart**, and both fall inside the
fetched final perimeter. Agency points of origin are dispatch-entered, so neither is a survey.
`IGNITION` uses the CAL FIRE point — that record also names the location, "Southeast of
Palisades Drive, Pacific Palisades" — and carries `approximate: true`, which makes the pipeline
print a loud warning naming the note.

`WFIGS_Incident_Locations_Current` and `..._YearToDate` both return `[]` for this fire; only the
unsuffixed `WFIGS_Incident_Locations` has it. And `attr_InitialLatitude` / `attr_InitialLongitude`
exist on the perimeter service but are **null** for this record, which is why the location
service is needed at all.

---

## Negative findings for the Palisades, stated plainly

- **No timestamped fire progression exists for this fire in any free archive.** Four sources
  checked, all named above. This is a harder gap than the Camp Fire's, where 28 dated perimeters
  exist even though the first is three and a half hours late.
- **`ca_evac_zones`** (`services.arcgis.com/pGfbNJoYypmNq86F`), recorded above as the best solver
  input found, returns **0 features** in this bbox. It holds 628 features statewide and is a
  stale 2023 snapshot of *active* evacuations, not a zone system. It should not be relied on.
- **`CA_EVACUATIONS_CalOESHosted_view`** also returns **0 features** here.
- **The LA County GENASYS layer** (`GENASYS_Alert_Warning_Area_NEW_view`) returns 0 in this bbox
  too; the Jan-13 DPH copy is the one that works.
- **CAL FIRE's incident API carries only final state.** `AcresBurned` is 23,448 and `Updated` is
  2026 — there is no acreage time series to anchor the hazard model against.

## Bbox choice, and the check that set it

The first candidate ran east to -118.48 and south to 34.015. Comparing ACS population inside the
deduped evacuation-zone union against outside it:

| bbox | Population | Inside an ordered/warned zone |
|------|-----------|------------------------------|
| -118.60, 34.015, -118.48, 34.125 | 80,908 | 45% |
| -118.60, 34.015, -118.49, 34.120 | 62,994 | 51% |
| **-118.61, 34.012, -118.505, 34.125** | **34,188** | **85%** |

Santa Monica's grid is dense, was never ordered, and on the derived-zone path every block group
in the box becomes a release wave. Pulling the east edge in to Santa Monica Canyon drops 50,000
residents who did not evacuate. PCH still crosses the east edge cleanly at lat 34.019 and Sunset
at 34.051, both read off the Overpass geometry rather than recalled, so no sink lands on a
corner.

(The shipped `population.json` totals 51,772 people rather than 34,188: TIGERweb returns every
block group *intersecting* the bbox, so edge cells count whole. The 34,188 figure is
centroid-in-bbox and was only ever the bbox-selection metric.)

## The wall clock, which nearly broke silently

Three places anchored T+0 and only one of them was per-scenario: `SCENARIO_START_HOUR` in
`fetch-weather.ts`, a bare `const T0_LOCAL_HOUR = 6` in `fetch-hazard.ts`, and
`formatWallClock(..., startHour = 6)` in `src/lib/format.ts`, which no caller ever overrode. A
10:30 ignition against a 06:00 hazard clock would have rotated the entire wind track four hours
against the fire and failed nothing.

`startHourLocal` now lives on `ScenarioMeta` and is the single source: the weather pull, the
hazard clock, the scrubber readout and the CAP composer's `sent` timestamp all read it.
Existing values are preserved exactly (Camp Fire 6, BioLab 5, Marshall 10), so no built payload
moved.

## Still open on this scenario

- `research/cap/generateCapEvacuationOrder` is called from the alert composer with a hardcoded
  Butte County identifier and sender. On the Palisades it emits `CA.BUTTE.OES_PAC-E0xx_…` from
  `butte-oes@buttecounty.net`, which is wrong for this scenario and needs a per-scenario issuing
  authority.
- `scripts/fetch-context-layers.ts` has no `palisades-fire-2025` entry in `SCENARIO_STATE`
  (CA / 06), so `public/data/palisades-fire-2025/context/` does not exist. That file was owned
  by another change while this one landed.


---

## The demand-parity bug — the baseline was evacuating fewer people than the plan

Found by reading `run_baseline.json` and `run_planned.json` side by side after the Palisades
scenario landed, not by any test.

`totalEvacuated` differed between the two runs of the same scenario: Camp Fire 28,310 baseline
against 33,398 planned, Palisades 37,276 against 42,162. Both runs use identical `compliance`,
`shadowEvac`, `noticeTime` and `vehiclesPerHousehold` — only the three lever booleans differ —
so the number of people who set out **must** match. Only the timing should move.

### Cause

```ts
const orderedAtZero = !params.staged || w.wave === 0;
const shadow = orderedAtZero ? 0 : hh * params.shadowEvac;
```

`BASELINE_PARAMS.staged` is `false`, so `orderedAtZero` was true for every zone in the baseline
and shadow demand collapsed to zero across the whole run. The planned run, staged, gave shadow
demand to every zone outside wave 0. Net effect: the baseline moved 72% of households while the
plan it was being scored against moved about 90%. Confirmed arithmetically before touching
anything — Palisades baseline `totalEvacuated` was 37,276 against an ordered-only hand
calculation of `20,846 hh x 0.72 x 2.48 people/hh` = 37,276 exactly.

The headline delta was therefore comparing two different evacuations, and the error flattered
the plan. Nothing in the console surfaced it: `unassigned` is computed as `evacPeople -
totalEvacuated` from the same demand array, so both runs self-consistently reported ~0 stranded
and the discrepancy cancelled out of every number on screen.

### Fix

Shadow demand is unconditional. Anyone who would leave without being told also leaves when told,
so a blanket order cannot produce *less* departure than a staged one — the old behaviour was
wrong on modelling grounds, not only on comparability grounds. Staging now changes **when**
ordered demand is released, never how much demand exists.

The release loop already had the right semantics and needed no change: shadow releases at T+0,
ordered at its wave time. So staging never gets credit for controlling people it cannot control.

A hard assert now fails the build if the two runs ever release different vehicle counts again.

### Consequences

- Camp Fire baseline 7 h 40 m -> **9 h 30 m**; planned unchanged at 3 h 45 m. Vehicles exposed
  at burnover 1,123 -> **3,797**. Peak queue 43.4 km -> 54.7 km. The argument got stronger, which
  is the direction that should make you suspicious — so it was checked against the independent
  closed-form solve, which lands at 9.23 h on the same data.
- The 8-hour scenario window was then **censoring** the Camp Fire baseline: it reported clearance
  at exactly 28,800 s, which is the horizon, not a measurement. `duration` extended to 43,200 s.
  A window has to outlast the worst run it has to score.
- Palisades baseline 2 h 55 m -> **3 h 40 m** against a closed-form 3.64 h. Planned 2 h 20 m.
  Still clears before the authored `burnoverAt`, so that scenario's exposure figures stay zero
  and its argument remains the zone-granularity one, as `validation.note` already says.

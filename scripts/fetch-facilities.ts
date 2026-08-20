/**
 * fetch-facilities.ts — builds public/data/<scenario>/facilities.json (FacilityLayer).
 *
 * Usage:  tsx scripts/fetch-facilities.ts [scenarioId]      (default camp-fire-2018)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ASSUMPTION TABLE — every number below is a stated modelling assumption, not
 * observed data. Nothing here comes from an upstream feed. The runtime prints
 * this same table so it can never drift out of the demo narrative.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FLEET (Facility.assets)
 *   fire_station     engine 2, ambulance 1, bus 0
 *                    A rural CAL FIRE / county station is a two-apparatus house
 *                    with one medic unit. Career metro houses run richer; this
 *                    is the conservative end.
 *   ems              ambulance 2
 *   hospital         ambulance 3            (hospital-based transport pool)
 *                    ambulance 1 when the record came in as OSM
 *                    amenity=clinic — clinics fold into the hospital kind (the
 *                    union has no clinic member) but a walk-in clinic or
 *                    dialysis centre runs no transport pool. An OSM
 *                    amenity=hospital still gets 3: HIFLD's current snapshot has
 *                    dropped Adventist Health Feather River in Paradise, which
 *                    closed after the 2018 fire, and OSM is the only source that
 *                    still carries the hospital this scenario evacuates.
 *   transit_depot    bus 5..12              deterministic per-id draw
 *   school           bus = clamp(3 + floor(enrollment / 150), 3, 8)
 *                    School buses ARE the evacuation fleet in a rural county —
 *                    a district's yellow fleet outnumbers every transit bus in
 *                    the region. Enrollment comes from HIFLD POPULATION when
 *                    present, otherwise a deterministic 3..8 draw.
 *                    bus 0 for non-campus school records — ROP/adult ed,
 *                    independent study, community day, court and online schools
 *                    appear in HIFLD's Public Schools layer but own no fleet.
 *   everything else  0 / 0 / 0
 *   SEATS_PER_BUS = 48   (Type C/D school bus, adult seating, 3-per-bench
 *                         derated to 2 — adults do not fit three abreast.)
 *
 * SHELTER CAPACITY (Facility.capacity — 0 for every non-shelter, non-school
 * kind, per the FacilityLayer contract)
 *   AREA_PER_PERSON = 3.7 m²  (40 sq ft, American Red Cross long-term
 *                              congregate standard; short-term allows 1.86 m²)
 *   shelter, footprint known   floor(area * 0.60 / 3.7)  clamp [120, 1200]
 *   shelter, no footprint      480      (designated congregate shelter default)
 *   school,  footprint known   floor(sum(campus building footprints) * 0.18
 *                                     / 3.7)             clamp [120,  900]
 *                              0.18 = the gym + multipurpose share of a school's
 *                              building stock. Classrooms are not shelter space.
 *   school,  no footprint      200      (one school gym)
 *
 * DERIVED KINDS
 *   shelter — NO upstream source publishes designated congregate shelters for
 *   an arbitrary bbox (FEMA's National Shelter System feed is not public and
 *   OSM amenity=shelter in rural counties is picnic shelters and bus stops).
 *   Shelters here are DERIVED from the real congregate-venue stock in OSM:
 *   fairgrounds, named community centres, named event venues, and places of
 *   worship that carry a building polygon. The method validates on Camp Fire —
 *   Silver Dollar Fairgrounds, an actual 2018 shelter site, falls straight out.
 *   Facility.source records the derivation.
 *
 * MAPPINGS
 *   OSM amenity=clinic          -> hospital        (only medical kind in the union)
 *   OSM residential=trailer_park-> mobile_home_park
 *   OSM landuse=depot / amenity=bus_station -> transit_depot
 *   Unnamed OSM elements are dropped. In practice they are campus outbuildings
 *   and wings, not distinct facilities, and "school (way/1106802741)" is not a
 *   thing an incident commander can dispatch to.
 *
 * DEDUPE RADIUS — 150 m default, widened by kind because HIFLD points the admin
 * building while OSM points the site centroid, and a campus is bigger than
 * 150 m: school 400 m, hospital 300 m, mobile_home_park 250 m. Two points only
 * merge if they share a name token (casefolded — HIFLD ships ALL CAPS) or one
 * side is unnamed, so adjacent elementary/high schools stay separate.
 *
 * BBOX PADDING
 *   PAD_DEG = 0.15 (~16 km). Queried on top of the scenario bbox because the
 *   assets that solve an evacuation live OUTSIDE the evacuation footprint —
 *   for Camp Fire the strict bbox excludes Chico entirely, and with it Enloe
 *   Medical Center, the only transit depot in the county, the fairgrounds, and
 *   most of the school-bus fleet. Dispatch origins and shelter destinations are
 *   by definition not in the burn area.
 *
 * UPSTREAM SOURCES (URLs + LAYER IDS probed live 2026-08-19; the FEMA layer ids
 * are non-zero and a /0 default silently returns the wrong layer)
 *   fire_station     services2.arcgis.com/C8EMgrsFcRFL6LrL  Fire_Stations/0
 *   hospital         services.arcgis.com/XG15cJAlne2vxtgt   Hospitals_RAPT/6
 *   school           services.arcgis.com/XG15cJAlne2vxtgt   Public_Schools/3
 *   nursing_home     services.arcgis.com/XG15cJAlne2vxtgt   Nursing_Homes_RAPT/7
 *   mobile_home_park services.arcgis.com/XG15cJAlne2vxtgt   Mobile_Home_Parks_RAPT/2
 *   eoc              services.arcgis.com/XG15cJAlne2vxtgt   EOCFacilities/0
 *   everything       overpass-api.de (+ kumi.systems, private.coffee mirrors)
 *
 *   Dead as of this writing, do not resurrect from a search index: every
 *   CA_Office_of_Emergency_Services_GIS layer (Hp6G80Pky0om7QvQ/Fire_Station,
 *   /EMS_Stations, /NursingHomes, /Local_Emergency_Operations_Centers_EOC) and
 *   maps.nccs.nasa.gov/mapping/rest/services/hifld_open. ArcGIS Online search
 *   still indexes all of them; every one 400s. Documented alternate for fire
 *   stations if the NWS mirror dies:
 *   carto.nationalmap.gov/arcgis/rest/services/structures/MapServer/51
 *   (USGS National Map, fcode 74026 = fire station, 74027 = EMS station).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Facility, FacilityKind, FacilityLayer, LngLat } from "../src/types/egress";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CACHE_DIR = join(HERE, ".cache");
const OUT_DIR = join(ROOT, "public", "data");

// ─────────────────────────────────────────────────────────────────────────────
// Assumptions, as constants so the printed table and the code cannot diverge
// ─────────────────────────────────────────────────────────────────────────────

const PAD_DEG = 0.15;
const SEATS_PER_BUS = 48;
const AREA_PER_PERSON = 3.7;
const SHELTER_USABLE_FRACTION = 0.6;
const SCHOOL_GYM_FRACTION = 0.18;
const DEFAULT_SHELTER_CAPACITY = 480;
const DEFAULT_SCHOOL_CAPACITY = 200;
const DEDUPE_METRES = 150;
/** Campus-scale kinds: HIFLD points the admin building, OSM the site centroid. */
const DEDUPE_METRES_BY_KIND: Partial<Record<FacilityKind, number>> = {
  school: 400,
  hospital: 300,
  mobile_home_park: 250,
};
/** Campus building footprints within this radius of a school point are summed. */
const CAMPUS_RADIUS_METRES = 250;

/** HIFLD's Public Schools layer includes programmes that own no yellow fleet. */
const NO_FLEET_SCHOOL =
  /\b(rop|adult|independent study|community day|court|online|virtual|home ?school|preschool|regional occupational)\b/i;

/** Mirrors src/lib/constants.ts SCENARIOS. Duplicated because pipeline scripts
 *  run outside the @/* alias and constants.ts imports through it. */
const SCENARIO_BBOX: Record<string, [number, number, number, number]> = {
  "camp-fire-2018": [-121.72, 39.68, -121.51, 39.84],
  "conyers-plume-2024": [-84.13, 33.58, -83.85, 33.76],
  "marshall-fire-2021": [-105.22, 39.9, -105.03, 40.02],
  "palisades-fire-2025": [-118.61, 34.012, -118.505, 34.125],
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing: retry with backoff, raw responses cached under scripts/.cache
// ─────────────────────────────────────────────────────────────────────────────

interface FetchOpts {
  method?: "GET" | "POST";
  body?: string;
  label: string;
}

function cacheKey(url: string, body?: string): string {
  return createHash("sha1")
    .update(url)
    .update(body ?? "")
    .digest("hex")
    .slice(0, 20);
}

async function fetchCached(url: string, opts: FetchOpts): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${cacheKey(url, opts.body)}.txt`);
  try {
    if (statSync(file).size > 0) return readFileSync(file, "utf8");
  } catch {
    // cold cache
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1200 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: {
          "User-Agent": "egress-evacuation-planner/0.1 (pipeline; contact via repo)",
          ...(opts.body ? { "Content-Type": "text/plain;charset=UTF-8" } : {}),
        },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (text.trimStart().startsWith("<")) throw new Error("HTML response (rate limited?)");
      writeFileSync(file, text, "utf8");
      return text;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${opts.label}: ${String(lastErr)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

const EARTH_R = 6378137;

function haversine(a: LngLat, b: LngLat): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** Spherical-excess ring area in m². Ring may be open; it is closed here. */
function ringArea(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const pts =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    total +=
      (((x2 - x1) * Math.PI) / 180) *
      (2 + Math.sin((y1 * Math.PI) / 180) + Math.sin((y2 * Math.PI) / 180));
  }
  return Math.abs((total * EARTH_R * EARTH_R) / 2);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Deterministic 0..1 from a string. Re-runs must not churn the JSON. */
function seeded(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

function seededInt(id: string, lo: number, hi: number): number {
  return lo + Math.floor(seeded(id) * (hi - lo + 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Names — HIFLD ships ALL CAPS, which reads as shouting in a dense panel
// ─────────────────────────────────────────────────────────────────────────────

const NAME_STOPWORDS = new Set(["of", "the", "and", "at", "for", "on", "in", "de", "a"]);
const NAME_ACRONYMS = new Set([
  "ROP",
  "EMS",
  "CDF",
  "PHF",
  "VA",
  "USFS",
  "SNF",
  "II",
  "III",
  "IV",
  "JR",
  "SR",
  "US",
  "CA",
  "CO",
  "GA",
  "YMCA",
  "YWCA",
  "LDS",
  "HQ",
  "ALF",
  "RCFE",
]);

function titleCase(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
  if (cleaned !== cleaned.toUpperCase()) return cleaned; // already mixed case, leave it
  return cleaned
    .split(" ")
    .map((word, i) => {
      const core = word.replace(/[^A-Za-z0-9']/g, "");
      if (NAME_ACRONYMS.has(core)) return word;
      const lower = word.toLowerCase();
      if (i > 0 && NAME_STOPWORDS.has(core.toLowerCase())) return lower;
      return lower.replace(/(^|[^a-z'])([a-z])/g, (_m, p, c: string) => p + c.toUpperCase());
    })
    .join(" ");
}

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Intermediate record — everything the assignment stage needs
// ─────────────────────────────────────────────────────────────────────────────

interface Raw {
  id: string;
  kind: FacilityKind;
  name: string;
  position: LngLat;
  source: string;
  /** true = HIFLD/authoritative, wins every dedupe against OSM. */
  authoritative: boolean;
  /** Building footprint m², when the upstream element carried a polygon. */
  footprint?: number;
  /** HIFLD POPULATION: enrollment for schools, beds for hospitals/nursing homes. */
  population?: number;
  /** Mobile home park pad count. */
  units?: number;
  /** OSM amenity=clinic folded into the hospital kind — no transport pool. */
  minorMedical?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// ArcGIS FeatureServer
// ─────────────────────────────────────────────────────────────────────────────

interface AgsSpec {
  kind: FacilityKind;
  label: string;
  url: string;
  /** Field holding the stable upstream identifier. */
  idField: string;
}

const AGS_SOURCES: AgsSpec[] = [
  {
    kind: "fire_station",
    label: "HIFLD Fire Stations",
    url: "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Fire_Stations/FeatureServer/0",
    idField: "ID",
  },
  {
    kind: "hospital",
    label: "HIFLD Hospitals (FEMA RAPT)",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6",
    idField: "ID",
  },
  {
    kind: "school",
    label: "HIFLD Public Schools (FEMA RAPT)",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Public_Schools/FeatureServer/3",
    idField: "NCESID",
  },
  {
    kind: "nursing_home",
    label: "HIFLD Nursing Homes (FEMA RAPT)",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Nursing_Homes_RAPT/FeatureServer/7",
    idField: "ID",
  },
  {
    kind: "mobile_home_park",
    label: "HIFLD Mobile Home Parks (FEMA RAPT)",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Mobile_Home_Parks_RAPT/FeatureServer/2",
    idField: "MHPID",
  },
  {
    kind: "eoc",
    label: "HIFLD Emergency Operations Centers",
    url: "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/EOCFacilities/FeatureServer/0",
    idField: "OBJECTID",
  },
];

type GeoJsonFeature = {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
};

async function queryArcgis(spec: AgsSpec, bbox: number[]): Promise<Raw[]> {
  const out: Raw[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const qs = new URLSearchParams({
      where: "1=1",
      geometry: bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "*",
      returnGeometry: "true",
      f: "geojson",
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
    });
    const text = await fetchCached(`${spec.url}/query?${qs}`, { label: spec.label });
    const json = JSON.parse(text) as {
      features?: GeoJsonFeature[];
      error?: { message?: string };
      exceededTransferLimit?: boolean;
    };
    if (json.error) throw new Error(`${spec.label}: ${json.error.message ?? "ArcGIS error"}`);
    const feats = json.features ?? [];
    for (const f of feats) {
      const raw = toRawFromArcgis(spec, f);
      if (raw) out.push(raw);
    }
    if (feats.length < pageSize && !json.exceededTransferLimit) break;
  }
  return out;
}

function toRawFromArcgis(spec: AgsSpec, f: GeoJsonFeature): Raw | null {
  const geom = f.geometry;
  if (geom?.type !== "Point") return null;
  const coords = geom.coordinates as [number, number];
  if (!Number.isFinite(coords?.[0]) || !Number.isFinite(coords?.[1])) return null;

  const p = f.properties ?? {};
  const status = String(p.STATUS ?? "OPEN").toUpperCase();
  if (status.includes("CLOSED")) return null;

  const rawName = String(p.NAME ?? "").trim();
  const upstreamId = String(p[spec.idField] ?? p.OBJECTID ?? p.FID ?? "");
  if (!upstreamId) return null;

  const pop = Number(p.POPULATION);
  const units = Number(p.UNITS);

  return {
    id: `${spec.kind}:hifld:${upstreamId}`,
    kind: spec.kind,
    name: titleCase(rawName) || `${spec.kind.replace(/_/g, " ")} ${upstreamId}`,
    position: [coords[0], coords[1]],
    source: `HIFLD via ${new URL(spec.url).hostname}`,
    authoritative: true,
    population: Number.isFinite(pop) && pop > 0 ? pop : undefined,
    units: Number.isFinite(units) && units > 0 ? units : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overpass
// ─────────────────────────────────────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

function overpassQL(bbox: number[]): string {
  const [w, s, e, n] = bbox;
  const b = `${s},${w},${n},${e}`;
  const selectors = [
    '["amenity"="fire_station"]',
    '["amenity"="hospital"]',
    '["amenity"="clinic"]',
    '["emergency"="ambulance_station"]',
    '["amenity"="ambulance_station"]',
    '["amenity"="school"]',
    '["amenity"="shelter"]',
    '["social_facility"="nursing_home"]',
    '["amenity"="nursing_home"]',
    '["residential"="trailer_park"]',
    '["amenity"="bus_station"]',
    '["landuse"="depot"]',
    '["amenity"="community_centre"]',
    '["amenity"="events_venue"]',
    '["amenity"="place_of_worship"]["building"]',
    '["building"="school"]',
    '["name"~"[Ff]airground"]',
  ];
  return [
    "[out:json][timeout:180];",
    "(",
    ...selectors.map((sel) => `  nwr${sel}(${b});`),
    ");",
    "out tags geom;",
  ].join("\n");
}

async function queryOverpass(bbox: number[]): Promise<OsmElement[]> {
  const ql = overpassQL(bbox);
  let lastErr: unknown;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const text = await fetchCached(mirror, {
        method: "POST",
        body: ql,
        label: `Overpass ${new URL(mirror).hostname}`,
      });
      const json = JSON.parse(text) as { elements?: OsmElement[] };
      if (!json.elements) throw new Error("no elements array");
      return json.elements;
    } catch (err) {
      lastErr = err;
      console.warn(`  overpass mirror ${new URL(mirror).hostname} failed, trying next`);
    }
  }
  throw new Error(`Overpass: all mirrors failed: ${String(lastErr)}`);
}

function osmCentre(el: OsmElement): LngLat | null {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
    return [el.lon as number, el.lat as number];
  }
  if (el.bounds) {
    return [(el.bounds.minlon + el.bounds.maxlon) / 2, (el.bounds.minlat + el.bounds.maxlat) / 2];
  }
  if (el.geometry?.length) {
    const pts = el.geometry;
    let x = 0;
    let y = 0;
    for (const p of pts) {
      x += p.lon;
      y += p.lat;
    }
    return [x / pts.length, y / pts.length];
  }
  return null;
}

function osmRing(el: OsmElement): LngLat[] | null {
  if (!el.geometry || el.geometry.length < 3) return null;
  return el.geometry.map((p) => [p.lon, p.lat] as LngLat);
}

/** OSM amenity=shelter is overwhelmingly picnic shelters and bus stops; it is a
 *  congregate shelter only when explicitly tagged as one. */
function isRealEmergencyShelter(t: Record<string, string>): boolean {
  if (t.amenity !== "shelter") return false;
  return (
    t.emergency === "shelter" ||
    t.social_facility === "shelter" ||
    t.shelter_type === "emergency" ||
    t.shelter_type === "public_shelter"
  );
}

interface OsmHarvest {
  facilities: Raw[];
  /** building=school footprints, used to size school shelter capacity. */
  schoolBuildings: { position: LngLat; area: number }[];
  rejectedShelters: number;
  unnamedDropped: number;
}

function harvestOsm(elements: OsmElement[]): OsmHarvest {
  const facilities: Raw[] = [];
  const schoolBuildings: { position: LngLat; area: number }[] = [];
  let rejectedShelters = 0;
  let unnamedDropped = 0;

  for (const el of elements) {
    const t = el.tags;
    if (!t) continue;
    const pos = osmCentre(el);
    if (!pos) continue;

    const ring = osmRing(el);
    const footprint = ring && t.building ? ringArea(ring) : undefined;

    if (t.building === "school" && !t.amenity) {
      if (footprint) schoolBuildings.push({ position: pos, area: footprint });
      continue; // a campus building is not itself a facility
    }

    let kind: FacilityKind | null = null;
    let derivedNote = "";
    const minorMedical = t.amenity === "clinic";

    if (t.amenity === "fire_station") kind = "fire_station";
    else if (t.emergency === "ambulance_station" || t.amenity === "ambulance_station") kind = "ems";
    else if (t.amenity === "hospital") kind = "hospital";
    else if (t.amenity === "clinic") kind = "hospital";
    else if (t.amenity === "school") kind = "school";
    else if (t.social_facility === "nursing_home" || t.amenity === "nursing_home") {
      kind = "nursing_home";
    } else if (t.residential === "trailer_park") kind = "mobile_home_park";
    else if (t.amenity === "bus_station" || t.landuse === "depot") kind = "transit_depot";
    else if (isRealEmergencyShelter(t)) kind = "shelter";
    else if (t.amenity === "shelter") {
      rejectedShelters++;
      continue;
    } else if (/fairground/i.test(t.name ?? "")) {
      kind = "shelter";
      derivedNote = "fairground";
    } else if (t.amenity === "community_centre" && t.name) {
      kind = "shelter";
      derivedNote = "community centre";
    } else if (t.amenity === "events_venue" && t.name) {
      kind = "shelter";
      derivedNote = "event venue";
    } else if (t.amenity === "place_of_worship" && t.building && t.name) {
      kind = "shelter";
      derivedNote = "place of worship";
    }

    if (!kind) continue;
    // A bare landuse=depot with no bus operator is a works yard, not a bus barn.
    if (kind === "transit_depot" && t.landuse === "depot" && !t.operator) continue;
    // Unnamed OSM elements are campus wings and outbuildings, not facilities.
    if (!t.name) {
      unnamedDropped++;
      continue;
    }

    facilities.push({
      id: `${kind}:osm:${el.type}/${el.id}`,
      kind,
      name: t.name,
      position: pos,
      source: derivedNote
        ? `derived: OpenStreetMap ${derivedNote} — congregate-venue stock, NOT a designated shelter list`
        : "OpenStreetMap contributors",
      authoritative: false,
      footprint,
      minorMedical,
    });
  }

  return { facilities, schoolBuildings, rejectedShelters, unnamedDropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe — within kind only, authoritative wins, name-token overlap required
// unless one side is unnamed
// ─────────────────────────────────────────────────────────────────────────────

function dedupe(records: Raw[]): { kept: Raw[]; merged: number } {
  // Authoritative first so HIFLD anchors every cluster.
  const ordered = [...records].sort((a, b) => {
    if (a.authoritative !== b.authoritative) return a.authoritative ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const kept: Raw[] = [];
  let merged = 0;

  for (const rec of ordered) {
    const recTokens = nameTokens(rec.name);
    const radius = DEDUPE_METRES_BY_KIND[rec.kind] ?? DEDUPE_METRES;
    const twin = kept.find((k) => {
      if (k.kind !== rec.kind) return false;
      if (haversine(k.position, rec.position) > radius) return false;
      const kTokens = nameTokens(k.name);
      if (kTokens.size === 0 || recTokens.size === 0) return true; // one side unnamed
      for (const tok of recTokens) if (kTokens.has(tok)) return true;
      return false;
    });

    if (twin) {
      merged++;
      // Keep the survivor's identity, absorb whatever detail it lacks.
      twin.footprint ??= rec.footprint;
      twin.population ??= rec.population;
      twin.units ??= rec.units;
      continue;
    }
    kept.push(rec);
  }

  return { kept, merged };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assets and capacity
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_ASSETS = { bus: 0, ambulance: 0, engine: 0 };

function assetsFor(rec: Raw): Facility["assets"] {
  switch (rec.kind) {
    case "fire_station":
      return { bus: 0, ambulance: 1, engine: 2 };
    case "ems":
      return { bus: 0, ambulance: 2, engine: 0 };
    case "hospital":
      // OSM folds clinics into this kind; a dialysis centre runs no transport pool.
      return { bus: 0, ambulance: rec.minorMedical ? 1 : 3, engine: 0 };
    case "transit_depot":
      return { bus: seededInt(rec.id, 5, 12), ambulance: 0, engine: 0 };
    case "school": {
      if (NO_FLEET_SCHOOL.test(rec.name)) return { ...ZERO_ASSETS };
      const bus = rec.population
        ? clamp(3 + Math.floor(rec.population / 150), 3, 8)
        : seededInt(rec.id, 3, 8);
      return { bus, ambulance: 0, engine: 0 };
    }
    default:
      return { ...ZERO_ASSETS };
  }
}

function capacityFor(rec: Raw, campusArea: number): number {
  if (rec.kind === "shelter") {
    if (rec.footprint && rec.footprint > 0) {
      return clamp(
        Math.floor((rec.footprint * SHELTER_USABLE_FRACTION) / AREA_PER_PERSON),
        120,
        1200,
      );
    }
    return DEFAULT_SHELTER_CAPACITY;
  }
  if (rec.kind === "school") {
    const area = campusArea || rec.footprint || 0;
    if (area > 0) {
      return clamp(Math.floor((area * SCHOOL_GYM_FRACTION) / AREA_PER_PERSON), 120, 900);
    }
    return DEFAULT_SCHOOL_CAPACITY;
  }
  return 0; // FacilityLayer contract: capacity is shelter capacity or 0
}

function campusAreaNear(pos: LngLat, buildings: { position: LngLat; area: number }[]): number {
  let total = 0;
  for (const b of buildings) {
    if (haversine(pos, b.position) <= CAMPUS_RADIUS_METRES) total += b.area;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fallback — only when EVERY upstream source failed
// ─────────────────────────────────────────────────────────────────────────────

function synthesize(scenarioId: string, bbox: number[]): Raw[] {
  const [w, s, e, n] = bbox;
  const plan: [FacilityKind, number][] = [
    ["fire_station", 6],
    ["school", 8],
    ["hospital", 1],
    ["shelter", 3],
    ["nursing_home", 3],
    ["transit_depot", 1],
    ["mobile_home_park", 5],
  ];
  const out: Raw[] = [];
  for (const [kind, count] of plan) {
    for (let i = 0; i < count; i++) {
      const id = `${kind}:synthetic:${scenarioId}-${i}`;
      const fx = seeded(`${id}#x`);
      const fy = seeded(`${id}#y`);
      out.push({
        id,
        kind,
        name: `SYNTHETIC ${kind.replace(/_/g, " ")} ${i + 1}`,
        position: [w + (e - w) * (0.1 + 0.8 * fx), s + (n - s) * (0.1 + 0.8 * fy)],
        source: "SYNTHETIC — all upstream sources unreachable",
        authoritative: false,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? "camp-fire-2018";
  const base = SCENARIO_BBOX[scenarioId];
  if (!base) {
    console.error(
      `unknown scenario "${scenarioId}" — known: ${Object.keys(SCENARIO_BBOX).join(", ")}`,
    );
    process.exit(1);
  }
  const bbox = [base[0] - PAD_DEG, base[1] - PAD_DEG, base[2] + PAD_DEG, base[3] + PAD_DEG];

  console.log(`[1/6] scenario ${scenarioId}`);
  console.log(
    `      scenario bbox ${base.map((v) => v.toFixed(3)).join(",")} -> queried bbox ` +
      `${bbox.map((v) => v.toFixed(3)).join(",")} (PAD ${PAD_DEG}deg: dispatch origins and ` +
      `shelter destinations sit outside the evacuation footprint)`,
  );

  const sourceReport: { name: string; ok: boolean; count: number; note?: string }[] = [];
  const records: Raw[] = [];

  console.log("[2/6] HIFLD FeatureServers");
  for (const spec of AGS_SOURCES) {
    try {
      const got = await queryArcgis(spec, bbox);
      records.push(...got);
      sourceReport.push({ name: spec.label, ok: true, count: got.length });
      console.log(`      ok   ${spec.label}: ${got.length}`);
    } catch (err) {
      sourceReport.push({ name: spec.label, ok: false, count: 0, note: String(err) });
      console.warn(`      FAIL ${spec.label}: ${String(err)}`);
    }
  }

  console.log("[3/6] Overpass (OpenStreetMap)");
  let schoolBuildings: { position: LngLat; area: number }[] = [];
  let overpassOk = false;
  try {
    const elements = await queryOverpass(bbox);
    const harvest = harvestOsm(elements);
    records.push(...harvest.facilities);
    schoolBuildings = harvest.schoolBuildings;
    overpassOk = true;
    sourceReport.push({
      name: "Overpass / OpenStreetMap",
      ok: true,
      count: harvest.facilities.length,
      note:
        `${elements.length} elements, ${harvest.schoolBuildings.length} school building ` +
        `footprints, ${harvest.rejectedShelters} amenity=shelter rejected as picnic/transit ` +
        `shelters, ${harvest.unnamedDropped} unnamed dropped`,
    });
    console.log(
      `      ok   Overpass: ${elements.length} elements -> ${harvest.facilities.length} facilities, ` +
        `${harvest.schoolBuildings.length} school footprints, ` +
        `${harvest.rejectedShelters} picnic/transit "shelters" rejected, ` +
        `${harvest.unnamedDropped} unnamed dropped`,
    );
  } catch (err) {
    sourceReport.push({ name: "Overpass / OpenStreetMap", ok: false, count: 0, note: String(err) });
    console.warn(`      FAIL Overpass: ${String(err)}`);
  }

  const anyUpstream = sourceReport.some((s) => s.ok && s.count > 0);
  let synthetic = false;
  if (!anyUpstream) {
    synthetic = true;
    console.warn(
      "!!! LOUD WARNING: every upstream source (HIFLD FeatureServers AND Overpass) failed or " +
        "returned nothing. SYNTHESIZING the entire facility set: 6 fire stations, 8 schools, " +
        "1 hospital, 3 shelters, 3 nursing homes, 1 transit depot, 5 mobile home parks, placed " +
        "on a deterministic jittered lattice inside the scenario bbox. Positions are FICTIONAL. " +
        'Every record carries source "SYNTHETIC — all upstream sources unreachable".',
    );
    records.push(...synthesize(scenarioId, base));
  }

  console.log("[4/6] deduplicating");
  const { kept, merged } = dedupe(records);
  console.log(
    `      ${records.length} raw -> ${kept.length} unique (${merged} merged within kind, ` +
      `${DEDUPE_METRES} m default / school 400 m / hospital 300 m / mobile_home_park 250 m)`,
  );

  console.log("[5/6] assigning assets and capacity (assumptions, printed below)");
  const facilities: Facility[] = kept
    .map((rec) => {
      const campusArea = rec.kind === "school" ? campusAreaNear(rec.position, schoolBuildings) : 0;
      return {
        id: rec.id,
        kind: rec.kind,
        name: rec.name,
        position: [
          Number(rec.position[0].toFixed(6)),
          Number(rec.position[1].toFixed(6)),
        ] as LngLat,
        capacity: capacityFor(rec, campusArea),
        assets: assetsFor(rec),
        source: rec.source,
      };
    })
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));

  const layer: FacilityLayer = {
    scenarioId,
    facilities,
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(OUT_DIR, scenarioId);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "facilities.json");
  const payload = JSON.stringify(layer, null, 2);
  writeFileSync(outPath, payload, "utf8");
  console.log(`[6/6] wrote ${outPath} (${Buffer.byteLength(payload)} bytes)`);

  report(facilities, sourceReport, synthetic, overpassOk);
}

function report(
  facilities: Facility[],
  sources: { name: string; ok: boolean; count: number; note?: string }[],
  synthetic: boolean,
  overpassOk: boolean,
): void {
  const byKind = new Map<FacilityKind, number>();
  for (const f of facilities) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);

  const buses = facilities.reduce((n, f) => n + f.assets.bus, 0);
  const ambulances = facilities.reduce((n, f) => n + f.assets.ambulance, 0);
  const engines = facilities.reduce((n, f) => n + f.assets.engine, 0);
  const shelterSeats = facilities.reduce((n, f) => n + f.capacity, 0);

  console.log("\n─── counts by kind ───");
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(17)} ${String(n).padStart(4)}`);
  }
  console.log(`  ${"TOTAL".padEnd(17)} ${String(facilities.length).padStart(4)}`);

  console.log("\n─── fleet ───");
  console.log(
    `  buses              ${buses}  ->  ${buses * SEATS_PER_BUS} seats @ ${SEATS_PER_BUS}/bus`,
  );
  console.log(`  ambulances         ${ambulances}`);
  console.log(`  engines            ${engines}`);
  console.log(`  shelter capacity   ${shelterSeats} people (shelters + school gyms)`);

  console.log("\n─── assumptions applied (none of this is observed data) ───");
  console.log("  fire_station  engine 2, ambulance 1");
  console.log("  ems           ambulance 2");
  console.log("  hospital      ambulance 3");
  console.log("  transit_depot bus 5..12, deterministic per facility id");
  console.log("  school        bus = clamp(3 + floor(enrollment/150), 3, 8)");
  console.log(`  bus seats     ${SEATS_PER_BUS} adults per Type C/D school bus`);
  console.log(
    `  shelter cap   floor(footprint * ${SHELTER_USABLE_FRACTION} / ${AREA_PER_PERSON} m2pp) ` +
      `clamp[120,1200], else ${DEFAULT_SHELTER_CAPACITY}`,
  );
  console.log(
    `  school cap    floor(campus footprint * ${SCHOOL_GYM_FRACTION} / ${AREA_PER_PERSON} m2pp) ` +
      `clamp[120,900], else ${DEFAULT_SCHOOL_CAPACITY}`,
  );
  console.log("  capacity is 0 for every kind that is not shelter or school");

  console.log("\n─── upstream sources ───");
  for (const s of sources) {
    console.log(
      `  ${s.ok ? "ok  " : "FAIL"} ${s.name.padEnd(38)} ${String(s.count).padStart(4)}` +
        (s.note ? `  ${s.note}` : ""),
    );
  }

  const zeroKinds = (["eoc", "ems", "shelter", "transit_depot"] as FacilityKind[]).filter(
    (k) => (byKind.get(k) ?? 0) === 0,
  );
  if (zeroKinds.length && !synthetic) {
    console.warn(
      `\n!!! LOUD WARNING: zero facilities for kind(s) ${zeroKinds.join(", ")}. ` +
        "These are HONEST ZEROES, not failures — nothing was synthesized to fill them. " +
        "HIFLD's EOC layer has no coverage in this bbox, and EMS stations in rural counties are " +
        "co-located with fire stations — ambulance capacity still flows through " +
        "fire_station{ambulance:1} and hospital{ambulance:3}.",
    );
  }

  const derived = facilities.filter((f) => f.source.startsWith("derived:")).length;
  if (derived > 0) {
    console.warn(
      `\n!!! LOUD WARNING: ${derived} shelter facilities are DERIVED, not fetched. No upstream ` +
        "source publishes designated congregate shelters for an arbitrary bbox, so shelters are " +
        "inferred from real OSM congregate-venue stock (fairgrounds, community centres, event " +
        "venues, places of worship with a building polygon). The positions and names are real " +
        "OSM features; the SHELTER DESIGNATION is ours. Each record says so in its source field.",
    );
  }

  if (!overpassOk) {
    console.warn(
      "\n!!! LOUD WARNING: Overpass returned nothing, so shelters, transit depots, EMS stations " +
        "and school building footprints are all missing or defaulted.",
    );
  }
}

main().catch((err) => {
  console.error("fetch-facilities failed:", err);
  process.exit(1);
});

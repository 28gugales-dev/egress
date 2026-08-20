/**
 * Street-, block- and structure-level detail.
 *
 * A third contract alongside src/types/egress.ts and src/types/context-layers.ts.
 * Everything here exists for one reason: the zone polygon is the coarsest useful
 * unit an incident commander works in, and it is the ONLY unit the console had.
 * Zoom past it and the map went blank. These payloads are what fills that in —
 * individual structures, decennial census blocks, and the street names already
 * carried on the road network.
 *
 * Three rules the shapes enforce rather than merely document:
 *
 *  1. **Vintage is a first-class field, not a footnote.** The Camp Fire is the
 *     reason. Machine-learned building footprints are extracted from whatever
 *     imagery the vendor last flew, and for Paradise that imagery post-dates a
 *     fire which destroyed most of the town. A footprint set is therefore a
 *     statement about a DATE, and a structure layer that does not say which
 *     date is lying about 9,000 buildings. `BuildingsPayload.imageryVintage`
 *     and `BlocksPayload.vintage` are required.
 *
 *  2. **Existence at event time is recorded, not assumed.** `presence` says
 *     whether a structure is *known* to have been standing when the scenario
 *     starts (a CAL FIRE damage inspection record proves it) or is merely
 *     visible in later imagery. The UI may count the first and must qualify the
 *     second.
 *
 *  3. **Derived geometry is tagged.** A destroyed structure has an inspection
 *     record but no surviving footprint. Drawing it as a small square is a
 *     reasonable thing to do and a dishonest thing to hide, so `footprint`
 *     carries which of the two it is.
 *
 * Coordinate convention, as everywhere: [lng, lat], GeoJSON order, WGS84.
 * Time convention, as everywhere: seconds since scenario T+0 (`Tick`).
 */

import type { LngLat, Tick } from "@/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Buildings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CAL FIRE DINS damage categories, condensed from the published coded-value
 * domain. "inaccessible" is retained rather than folded into "none": the
 * inspector could not reach the structure, which is not the same as finding it
 * intact.
 */
export type StructureDamage =
  | "destroyed"
  | "major"
  | "minor"
  | "affected"
  | "none"
  | "inaccessible";

/** Where the drawn polygon came from. See rule 3 above. */
export type FootprintSource =
  /** Real machine-learned outline traced from satellite imagery. */
  | "imagery"
  /** Square of median local footprint area, centred on an inspection point. */
  | "derived-from-point";

/**
 * Whether this structure is known to have existed at scenario T+0.
 *
 * `inspected` is the strong claim: a damage inspector stood at this address
 * after the event, which means the structure was there before it. `imagery`
 * is the weak one: something is standing there in post-event imagery, and it
 * may be a rebuild.
 */
export type StructurePresence = "inspected" | "imagery";

/**
 * One structure. Field names are short because there are tens of thousands of
 * these in one payload and the key strings would otherwise outweigh the
 * coordinates.
 */
export interface DetailBuilding {
  /**
   * Outer ring as a flat [lng, lat, lng, lat, …] run, 6 decimal places (~11 cm).
   * Flat rather than nested for deck.gl's `positionFormat: "XY"` fast path,
   * which skips the per-vertex array allocation entirely.
   */
  ring: number[];
  /** Centroid. Drives the hazard containment test and anchors the hover. */
  c: LngLat;
  /** Footprint area, square metres, rounded. */
  a: number;
  /** Containing zone id from zones.json, or null when outside every zone. */
  z: string | null;
  /**
   * First hazard frame tick whose rings contain the centroid; null when the
   * hazard never reaches it. Precomputed in the pipeline — 20k structures
   * against 97 frames is not a thing to do in a render pass.
   */
  h: Tick | null;
  /** Which claim we can make about this structure existing at T+0. */
  p: StructurePresence;
  /** Real outline, or a square standing in for one. */
  f: FootprintSource;
  /** Observed outcome. Present only when `p` is "inspected". */
  d?: StructureDamage;
  /** Inspected structure class, condensed ("Single Family", "Mobile Home", …). */
  s?: string;
}

/**
 * Per-community reconciliation against the county's own published structure
 * count. This is the honest cross-check, and it is in the payload rather than
 * a log line because the UI should be able to show it.
 */
export interface StructureCrossCheck {
  community: string;
  /** Sum of the county evacuation zone layer's own StructureC field. */
  official: number;
  /** What we ended up with inside the same polygons. */
  ours: number;
  /** Structures with a damage inspection record. */
  inspected: number;
}

export interface BuildingsPayload {
  scenarioId: string;
  buildings: DetailBuilding[];
  /**
   * Release date of the footprint product, ISO. The imagery behind it is older
   * still — this is the upper bound on how current the outlines are, and for a
   * scenario that replays a past event it is the number that matters.
   */
  imageryVintage: string;
  counts: {
    total: number;
    /** Drawn from a real machine-learned outline. */
    fromImagery: number;
    /** Drawn as a square around an inspection point. */
    fromPoint: number;
    inspected: number;
    destroyed: number;
    /** Structures the hazard footprint reaches before the run ends. */
    everInHazard: number;
  };
  crossCheck: StructureCrossCheck[];
  /** Every upstream that contributed, so any count can be re-derived. */
  sources: { name: string; url: string; role: string; count: number }[];
  /** What the layer means and what it does NOT mean. Always populated. */
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Census blocks — summary level 100, one step finer than the block groups the
// population layer already carries
// ─────────────────────────────────────────────────────────────────────────────

export interface DetailBlock {
  /** 15-digit block GEOID. */
  id: string;
  /** Flat [lng, lat, …] outer ring, same convention as DetailBuilding.ring. */
  ring: number[];
  c: LngLat;
  /** Decennial P1 total population. A count, not an estimate — no margin. */
  pop: number;
  /** Decennial H1 housing units. */
  hu: number;
  z: string | null;
  h: Tick | null;
}

export interface BlocksPayload {
  scenarioId: string;
  /**
   * Decennial census year the counts and geometry come from. Chosen per
   * scenario as the last census BEFORE the event — 2020 counts a Paradise that
   * had already burned, and using it here would quietly halve the town.
   */
  vintage: number;
  blocks: DetailBlock[];
  totals: {
    blocks: number;
    population: number;
    housingUnits: number;
    /** Blocks with zero population. Kept visible: a zero is a real count. */
    unpopulated: number;
  };
  source: string;
  sourceUrl: string;
  note: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Both members independently nullable. Detail is an enhancement; a missing
 * payload disables one toggle and never touches the rest of the map.
 */
export interface DetailBundle {
  buildings: BuildingsPayload | null;
  blocks: BlocksPayload | null;
}

/** Render-time hazard state of one structure at the current playhead. */
export type BuildingHazardState = "safe" | "threatened" | "overrun";

/** Files under public/data/<scenario>/detail/. */
export const DETAIL_FILES = {
  buildings: "buildings.json",
  blocks: "blocks.json",
} as const;

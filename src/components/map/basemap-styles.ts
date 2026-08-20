import type { StyleSpecification, TerrainSpecification } from "maplibre-gl";
import {
  ATTRIBUTION_CARTO,
  ATTRIBUTION_ESRI,
  CARTO_DARK_TILES,
  ESRI_IMAGERY_TILES,
  TERRAIN_DEM_TILES,
} from "@/lib/constants";
import type { BasemapId } from "@/types/egress";

// ─────────────────────────────────────────────────────────────────────────────
// Stable ids. Exported so the deck.gl overlay can target a `beforeId` when it
// runs interleaved, instead of hard-coding strings in two places.
// ─────────────────────────────────────────────────────────────────────────────

export const IMAGERY_SOURCE_ID = "esri-imagery";
export const BASEMAP_SOURCE_ID = "carto-dark";
export const DEM_SOURCE_ID = "terrarium-dem";
/** MapLibre warns when one raster-dem source backs both 3D terrain and a
 *  hillshade layer — they want different tile neighbourhoods and the shared
 *  cache seams the shading. Same URLs, so the HTTP cache absorbs the second
 *  read. */
export const HILLSHADE_SOURCE_ID = "terrarium-dem-hillshade";

export const IMAGERY_LAYER_ID = "esri-imagery-raster";
export const BASEMAP_LAYER_ID = "carto-dark-raster";
export const SCRIM_LAYER_ID = "basemap-scrim";
export const HILLSHADE_LAYER_ID = "terrain-hillshade";

/** The last basemap layer in every style. Anything the overlay inserts with
 *  this as `beforeId` still lands above imagery but below nothing else. */
export const BASEMAP_TOP_LAYER_ID: Record<BasemapId, string> = {
  satellite: SCRIM_LAYER_ID,
  dark: BASEMAP_LAYER_ID,
  terrain: HILLSHADE_LAYER_ID,
};

export const ATTRIBUTION_TERRAIN =
  'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (AWS Open Data)';

export const TERRAIN_EXAGGERATION = 1.35;

/** Fresh object every call: MapLibre stores the spec it is handed on the live
 *  stylesheet, so a shared singleton would leak between two mounted maps. */
export function terrainSpec(exaggeration = TERRAIN_EXAGGERATION): TerrainSpecification {
  return { source: DEM_SOURCE_ID, exaggeration };
}

/**
 * MapLibre's tile template dialect is `{ratio}`; the Carto URL in constants
 * carries Leaflet's `{r}`. Left unreplaced it is requested literally and every
 * tile 404s. Normalised here rather than in constants so the constant stays the
 * verbatim upstream URL — including its axis order, which is deliberate.
 */
function toMapLibreTemplate(url: string): string {
  return url.replace(/\{r\}/g, "{ratio}");
}

/** Terrarium DEM. Present in every style so the 3D toggle works over any
 *  basemap; MapLibre issues no requests for a source no layer and no terrain
 *  references, so an unused DEM costs nothing. */
function demSource() {
  return {
    type: "raster-dem" as const,
    tiles: [toMapLibreTemplate(TERRAIN_DEM_TILES)],
    tileSize: 256,
    minzoom: 0,
    // AWS terrarium thins out past z14 in rural coverage; overzoom instead of 404.
    maxzoom: 14,
    encoding: "terrarium" as const,
    attribution: ATTRIBUTION_TERRAIN,
  };
}

function cartoDarkSource() {
  return {
    type: "raster" as const,
    tiles: [toMapLibreTemplate(CARTO_DARK_TILES)],
    tileSize: 256,
    maxzoom: 20,
    attribution: ATTRIBUTION_CARTO,
  };
}

function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    name: "Egress satellite",
    sources: {
      [IMAGERY_SOURCE_ID]: {
        type: "raster",
        // Esri's ArcGIS tile REST path is {z}/{y}/{x}. Swapping the last two
        // returns plausible imagery from the wrong place, which reads as a
        // working map. Do not "correct" this.
        tiles: [ESRI_IMAGERY_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: ATTRIBUTION_ESRI,
      },
      [DEM_SOURCE_ID]: demSource(),
    },
    layers: [
      { id: IMAGERY_LAYER_ID, type: "raster", source: IMAGERY_SOURCE_ID },
      // A `background` layer placed after the imagery paints over it — the only
      // full-viewport fill that needs no geometry source. Knocks the imagery
      // back so ember and cyan data layers stay legible on top.
      {
        id: SCRIM_LAYER_ID,
        type: "background",
        paint: { "background-color": "rgba(6, 10, 16, 0.28)" },
      },
    ],
  };
}

function darkStyle(): StyleSpecification {
  return {
    version: 8,
    name: "Egress dark",
    sources: {
      [BASEMAP_SOURCE_ID]: cartoDarkSource(),
      [DEM_SOURCE_ID]: demSource(),
    },
    layers: [{ id: BASEMAP_LAYER_ID, type: "raster", source: BASEMAP_SOURCE_ID }],
  };
}

function terrainStyle(): StyleSpecification {
  return {
    version: 8,
    name: "Egress terrain",
    sources: {
      [BASEMAP_SOURCE_ID]: cartoDarkSource(),
      [DEM_SOURCE_ID]: demSource(),
      [HILLSHADE_SOURCE_ID]: demSource(),
    },
    layers: [
      { id: BASEMAP_LAYER_ID, type: "raster", source: BASEMAP_SOURCE_ID },
      {
        id: HILLSHADE_LAYER_ID,
        type: "hillshade",
        source: HILLSHADE_SOURCE_ID,
        paint: {
          "hillshade-exaggeration": 0.45,
          "hillshade-shadow-color": "rgba(4, 7, 12, 0.9)",
          "hillshade-highlight-color": "rgba(190, 205, 224, 0.28)",
          "hillshade-accent-color": "rgba(10, 16, 24, 0.6)",
        },
      },
    ],
    // Ridgelines are the whole point of this basemap — the canyon walls are why
    // Paradise has four ways out. Shipped on the style so switching to it tilts
    // into 3D without a second round-trip.
    terrain: terrainSpec(),
  };
}

const BUILDERS: Record<BasemapId, () => StyleSpecification> = {
  satellite: satelliteStyle,
  dark: darkStyle,
  terrain: terrainStyle,
};

/**
 * Build the style for a basemap. Returns a NEW object each call — MapLibre
 * mutates the stylesheet it is given, and react-map-gl compares `mapStyle` by
 * reference, so callers must memoise per map instance (see map-shell).
 */
export function basemapStyle(id: BasemapId): StyleSpecification {
  return (BUILDERS[id] ?? satelliteStyle)();
}

/** True when the style for this basemap already carries a terrain spec. */
export function basemapHasTerrain(id: BasemapId): boolean {
  return id === "terrain";
}

import type { EvacPlan, EvacZone, VehicleManifest, ZoneLayer } from "@/types/egress";

/**
 * The town-wide no-vehicle answer, which exists nowhere else in the console.
 *
 * Pure, argument-in: the SITUATION band renders it and the WORK band's badge
 * reads `late.length` off the same call, so the two can never disagree about
 * how many vehicles are behind the fire.
 *
 * Deliberately NOT computing an "uncovered households" figure. On
 * camp-fire-2018 every zone with no-vehicle households has a manifest —
 * coverage is 100% — so a subtraction against a mismatched denominator would
 * put a fabricated number in the most prominent band on screen. The honest and
 * more alarming finding is `late`.
 */
export interface DispatchSummary {
  vehicles: number;
  seats: number;
  wheelchairSlots: number;
  passengers: number;
  /** Zones with no-vehicle households that have at least one manifest. */
  zonesCovered: number;
  /** Zones with no-vehicle households at all. */
  zonesNeeding: number;
  /**
   * Manifests whose drop lands after the hazard reaches the zone they serve.
   * `slack` is written by the solver as hazard-arrival minus drop, so negative
   * is late — this is read, never re-derived from two other fields.
   */
  late: VehicleManifest[];
}

const EMPTY: DispatchSummary = {
  vehicles: 0,
  seats: 0,
  wheelchairSlots: 0,
  passengers: 0,
  zonesCovered: 0,
  zonesNeeding: 0,
  late: [],
};

export function dispatchSummary(plan: EvacPlan | null, zones: ZoneLayer | null): DispatchSummary {
  if (!plan) return EMPTY;

  const served = new Set<string>();
  let seats = 0;
  let wheelchairSlots = 0;
  let passengers = 0;
  const late: VehicleManifest[] = [];

  for (const m of plan.manifests) {
    seats += m.seats;
    wheelchairSlots += m.wheelchairSlots;
    for (const s of m.stops) passengers += s.passengers;
    for (const id of m.assignedZoneIds) served.add(id);
    if (m.slack < 0) late.push(m);
  }

  const needing: EvacZone[] = (zones?.zones ?? []).filter((z) => z.noVehicleHouseholds > 0);

  return {
    vehicles: plan.manifests.length,
    seats,
    wheelchairSlots,
    passengers,
    zonesCovered: needing.filter((z) => served.has(z.id)).length,
    zonesNeeding: needing.length,
    late,
  };
}

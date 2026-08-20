import type { Tick } from "@/types/egress";

/** T+HH:MM:SS — the operational clock. Always padded, always monospace. */
export function formatTick(t: Tick, withSeconds = true): string {
  const sign = t < 0 ? "-" : "+";
  const a = Math.abs(Math.round(t));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  if (!withSeconds) return `T${sign}${hh}:${mm}`;
  return `T${sign}${hh}:${mm}:${String(s).padStart(2, "0")}`;
}

/** 2:54 — for headline durations where T+ prefix would be noise. */
export function formatDuration(t: Tick): string {
  const a = Math.max(0, Math.round(t));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** 41m / 2h 14m — compact, for countdowns in dense rows. */
export function formatShort(t: Tick): string {
  const a = Math.max(0, Math.round(t));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Wall-clock for a scenario, given its event date and an offset. */
export function formatWallClock(eventDate: string, t: Tick, startHour = 6): string {
  const base = new Date(`${eventDate}T00:00:00Z`);
  base.setUTCHours(startHour);
  const d = new Date(base.getTime() + t * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${eventDate} ${hh}:${mm}`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatPercent(f: number, digits = 0): string {
  return `${(f * 100).toFixed(digits)}%`;
}

/** Signed delta for the "vs baseline" tile. Negative is good here. */
export function formatDelta(t: Tick): string {
  const sign = t <= 0 ? "−" : "+";
  return `${sign}${formatDuration(Math.abs(t))}`;
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Urgency band from time-to-hazard. Drives colour in lists and on the map. */
export function urgencyBand(secondsToHazard: Tick): 0 | 1 | 2 | 3 {
  if (secondsToHazard <= 1800) return 3;
  if (secondsToHazard <= 3600) return 2;
  if (secondsToHazard <= 7200) return 1;
  return 0;
}

export const URGENCY_VAR = ["var(--faint)", "var(--subtle)", "var(--warn)", "var(--hazard)"];
export const URGENCY_LABEL = ["Routine", "Watch", "Warning", "Critical"];

/** Bucket a 0..1+ load fraction into the congestion ramp index. */
export function loadBucket(load: number, buckets: number): number {
  if (!Number.isFinite(load) || load <= 0) return 0;
  const i = Math.floor(load * (buckets - 1));
  return Math.min(buckets - 1, Math.max(0, i));
}

/** Linear interpolation between two run summaries, for slider readouts that
 *  land between precomputed grid nodes. */
export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Nearest value in a sorted axis, plus the interpolation weight to the next. */
export function axisPosition(
  axis: readonly number[],
  v: number,
): { i: number; j: number; f: number } {
  if (v <= axis[0]) return { i: 0, j: 0, f: 0 };
  const last = axis.length - 1;
  if (v >= axis[last]) return { i: last, j: last, f: 0 };
  for (let k = 0; k < last; k++) {
    if (v >= axis[k] && v <= axis[k + 1]) {
      const span = axis[k + 1] - axis[k];
      return { i: k, j: k + 1, f: span === 0 ? 0 : (v - axis[k]) / span };
    }
  }
  return { i: last, j: last, f: 0 };
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

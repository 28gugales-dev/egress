"use client";

import { AlertTriangle, Check, Code2, DoorClosed, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { useBundle } from "@/lib/bundle-context";
import { hazardFrameAt } from "@/lib/derive";
import { cx, formatCount, formatShort, formatWallClock, urgencyBand } from "@/lib/format";
import type {
  CapCertainty,
  CapSeverity,
  CapUrgency,
  EvacZone,
  Facility,
  LngLat,
  ReleaseWave,
  ScenarioMeta,
  Tick,
} from "@/types/egress";
// The generator is verified research, modelled on a real archived IPAWS order
// (Rockdale County GA, 2024). Reused rather than reimplemented so the XML this
// screen shows is the same XML the research artifact validates.
import { generateCapEvacuationOrder } from "../../../research/cap/generateCapEvacuationOrder";

// ─────────────────────────────────────────────────────────────────────────────
// Language pack
//
// The message has to survive a panicked eight-second read, so every language
// carries the same six beats in the same order: verb, time, direction, ONE
// prohibition, shelter, no-car fallback. Nothing else is allowed in.
// ─────────────────────────────────────────────────────────────────────────────

export type LangCode = "en" | "es" | "tl" | "hmn" | "zh";

const LANG_CHIPS: { code: LangCode; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "es", label: "ES", name: "Spanish" },
  { code: "tl", label: "TL", name: "Tagalog" },
  { code: "hmn", label: "HMN", name: "Hmong" },
  { code: "zh", label: "ZH", name: "Chinese" },
];

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
type Compass = (typeof COMPASS)[number];

const COMPASS_WORDS: Record<LangCode, Record<Compass, string>> = {
  en: {
    N: "north",
    NE: "northeast",
    E: "east",
    SE: "southeast",
    S: "south",
    SW: "southwest",
    W: "west",
    NW: "northwest",
  },
  es: {
    N: "norte",
    NE: "noreste",
    E: "este",
    SE: "sureste",
    S: "sur",
    SW: "suroeste",
    W: "oeste",
    NW: "noroeste",
  },
  tl: {
    N: "hilaga",
    NE: "hilagang-silangan",
    E: "silangan",
    SE: "timog-silangan",
    S: "timog",
    SW: "timog-kanluran",
    W: "kanluran",
    NW: "hilagang-kanluran",
  },
  hmn: {
    N: "sab qaum teb",
    NE: "sab qaum teb hnub tuaj",
    E: "sab hnub tuaj",
    SE: "sab qab teb hnub tuaj",
    S: "sab qab teb",
    SW: "sab qab teb hnub poob",
    W: "sab hnub poob",
    NW: "sab qaum teb hnub poob",
  },
  zh: { N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" },
};

/** The six beats, kept apart so the verb and the prohibition can be coloured. */
export interface MessageParts {
  verb: string;
  time: string;
  direction: string;
  prohibition: string;
  shelter: string;
  fallback: string;
}

interface MessageInput {
  zoneId: string;
  /** Wall clock the hazard is expected at the zone, HH:MM. */
  clock: string;
  route: string;
  /** Corridor reserved for another wave. Null when there is no sibling wave. */
  prohibitRoute: string | null;
  shelterName: string;
  dir: Compass;
}

const COMPOSE: Record<LangCode, (m: MessageInput) => MessageParts> = {
  en: (m) => ({
    verb: "EVACUATE NOW.",
    time: `Fire reaches ${m.zoneId} by ${m.clock}.`,
    direction: `Drive ${COMPASS_WORDS.en[m.dir]} on ${m.route}.`,
    prohibition: m.prohibitRoute
      ? `Do not use ${m.prohibitRoute}.`
      : "Do not go back for anything.",
    shelter: `Go to ${m.shelterName}.`,
    fallback: "No car? Call 2-1-1. A bus will come for you.",
  }),
  es: (m) => ({
    verb: "EVACÚE AHORA.",
    time: `El fuego llega a ${m.zoneId} a las ${m.clock}.`,
    direction: `Conduzca hacia el ${COMPASS_WORDS.es[m.dir]} por ${m.route}.`,
    prohibition: m.prohibitRoute ? `No use ${m.prohibitRoute}.` : "No regrese por nada.",
    shelter: `Vaya a ${m.shelterName}.`,
    fallback: "¿No tiene carro? Llame al 2-1-1. Un autobús irá por usted.",
  }),
  tl: (m) => ({
    verb: "LUMIKAS NA NGAYON.",
    time: `Aabot ang apoy sa ${m.zoneId} bago mag-${m.clock}.`,
    direction: `Dumaan sa ${m.route} papuntang ${COMPASS_WORDS.tl[m.dir]}.`,
    prohibition: m.prohibitRoute
      ? `Huwag gamitin ang ${m.prohibitRoute}.`
      : "Huwag nang bumalik para sa kahit ano.",
    shelter: `Pumunta sa ${m.shelterName}.`,
    fallback: "Walang sasakyan? Tumawag sa 2-1-1. May bus na susundo sa inyo.",
  }),
  hmn: (m) => ({
    verb: "KHIAV TAM SIM NO.",
    time: `Hluav taws yuav tuaj txog ${m.zoneId} thaum ${m.clock}.`,
    direction: `Tsav mus ${COMPASS_WORDS.hmn[m.dir]} rau ${m.route}.`,
    prohibition: m.prohibitRoute
      ? `Tsis txhob siv ${m.prohibitRoute}.`
      : "Tsis txhob rov qab mus nqa ib yam dab tsi.",
    shelter: `Mus rau ${m.shelterName}.`,
    fallback: "Tsis muaj tsheb? Hu rau 2-1-1. Yuav muaj npav tuaj tos koj.",
  }),
  zh: (m) => ({
    verb: "立即撤离。",
    time: `火势将于 ${m.clock} 到达 ${m.zoneId}。`,
    direction: `沿 ${m.route} 向${COMPASS_WORDS.zh[m.dir]}行驶。`,
    prohibition: m.prohibitRoute ? `请勿使用 ${m.prohibitRoute}。` : "不要回去拿任何东西。",
    shelter: `前往 ${m.shelterName}。`,
    fallback: "没有车？拨打 2-1-1，将有巴士接您。",
  }),
};

function partsToText(p: MessageParts): string {
  return [p.verb, p.time, p.direction, p.prohibition, p.shelter, p.fallback].join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry + readability helpers
// ─────────────────────────────────────────────────────────────────────────────

const RAD = Math.PI / 180;

function compassTo(from: LngLat, to: LngLat): Compass {
  const p1 = from[1] * RAD;
  const p2 = to[1] * RAD;
  const dl = (to[0] - from[0]) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/** Equirectangular approximation — adequate at county scale, no dependency. */
function roughDistance(a: LngLat, b: LngLat): number {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const y = b[1] - a[1];
  return Math.sqrt(x * x + y * y);
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return w.length > 0 ? 1 : 0;
  const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch–Kincaid grade. English only; other scripts have no comparable index. */
function readingGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const g = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
  return Math.max(0, Math.round(g * 10) / 10);
}

/** Mirrors formatWallClock's T+0 convention so the two agree. */
function wallDate(eventDate: string, t: Tick, startHour = 6): Date {
  // Parsed as LOCAL time on purpose: the generator's capDate() formats local,
  // so a UTC epoch here would print a shifted clock in the XML next to the
  // on-screen one. Same digits in both panes on any machine timezone.
  return new Date(Date.parse(`${eventDate}T00:00:00`) + (startHour * 3600 + t) * 1000);
}

function clockOf(eventDate: string, t: Tick, startHour?: number): string {
  return formatWallClock(eventDate, t, startHour).slice(-5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export interface AlertComposerProps {
  wave: ReleaseWave;
  onClose: () => void;
}

export function AlertComposer({ wave, onClose }: AlertComposerProps) {
  const bundle = useBundle();
  const [zoneId, setZoneId] = useState<string>(wave.zoneIds[0] ?? "");
  const [lang, setLang] = useState<LangCode>("en");
  const [showXml, setShowXml] = useState(false);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta: ScenarioMeta | null = bundle?.meta ?? null;
  const zone: EvacZone | null = useMemo(
    () => bundle?.zones.zones.find((z) => z.id === zoneId) ?? null,
    [bundle, zoneId],
  );

  /** Nearest shelter with real capacity. Named in the message, so it must exist. */
  const shelter: Facility | null = useMemo(() => {
    if (!bundle || !zone) return null;
    let best: Facility | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const f of bundle.facilities.facilities) {
      if (f.kind !== "shelter" || f.capacity <= 0) continue;
      const d = roughDistance(zone.centroid, f.position);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }, [bundle, zone]);

  /** The corridor another wave is holding right now — that is the prohibition. */
  const prohibitRoute: string | null = useMemo(() => {
    const waves = bundle?.planned?.plan.waves ?? [];
    const sibling = waves.find(
      (w) =>
        w.wave !== wave.wave && w.routeLabel !== wave.routeLabel && w.departAt <= wave.departAt,
    );
    return sibling?.routeLabel ?? null;
  }, [bundle, wave]);

  const parts: MessageParts | null = useMemo(() => {
    if (!zone || !meta || !shelter) return null;
    return COMPOSE[lang]({
      zoneId: zone.id,
      clock: clockOf(meta.eventDate, zone.hazardEta, meta.startHourLocal),
      route: zone.primaryRouteLabel,
      prohibitRoute,
      shelterName: shelter.name,
      dir: compassTo(zone.centroid, shelter.position),
    });
  }, [zone, meta, shelter, lang, prohibitRoute]);

  const band = zone ? urgencyBand(zone.hazardEta) : 0;
  const urgency: CapUrgency = band >= 3 ? "Immediate" : band >= 2 ? "Expected" : "Future";
  const severity: CapSeverity = band >= 3 ? "Extreme" : band >= 2 ? "Severe" : "Moderate";
  // Certainty is not a vibe: it tracks whether the hazard frame driving this
  // order is an observed perimeter or an interpolation between observations.
  const frame = bundle && meta ? hazardFrameAt(bundle.hazard, wave.departAt) : null;
  const certainty: CapCertainty = frame?.provenance === "observed" ? "Observed" : "Likely";

  const xml = useMemo(() => {
    if (!bundle || !meta || !parts || !zone) return "";
    const en = COMPOSE.en({
      zoneId: zone.id,
      clock: clockOf(meta.eventDate, zone.hazardEta, meta.startHourLocal),
      route: zone.primaryRouteLabel,
      prohibitRoute,
      shelterName: shelter?.name ?? "the nearest shelter",
      dir: shelter ? compassTo(zone.centroid, shelter.position) : "W",
    });
    const sent = wallDate(meta.eventDate, wave.departAt, meta.startHourLocal);
    const zones = wave.zoneIds
      .map((id) => bundle.zones.zones.find((z) => z.id === id))
      .filter((z): z is EvacZone => Boolean(z));
    try {
      return generateCapEvacuationOrder({
        identifier: `CA.BUTTE.OES_${zone.id}_${sent.toISOString()}`,
        sender: "butte-oes@buttecounty.net",
        senderName: "Butte County Sheriff / OES",
        status: "Exercise",
        msgType: "Alert",
        sent,
        effective: sent,
        expires: new Date(sent.getTime() + 6 * 3600_000),
        event: "immediate evacuation order",
        urgency,
        severity,
        certainty,
        headline: `Evacuation order — wave ${wave.wave} — ${wave.zoneIds.join(", ")}`,
        description: partsToText(en),
        instruction: `${en.direction} ${en.prohibition} ${en.shelter} ${en.fallback}`,
        weaShortText: `Evacuation Order ${zone.id}: leave now via ${zone.primaryRouteLabel}.`,
        weaLongText: partsToText(en),
        areas: zones.map((z) => ({
          areaDesc: `${z.id} — ${z.label}`,
          geometry: { type: "Polygon", coordinates: z.geometry },
          sameGeocodes: ["006007"],
        })),
      });
    } catch (err) {
      return `<!-- generator refused this payload: ${String(err)} -->`;
    }
  }, [bundle, meta, parts, zone, shelter, prohibitRoute, wave, urgency, severity, certainty]);

  // The badge tracks the generator, not our hopes: a payload it refused comes
  // back as an XML comment, and claiming VALID over that is the exact failure
  // this project bans.
  const capValid = xml !== "" && !xml.startsWith("<!--");

  const plain = parts ? partsToText(parts) : "";
  const grade = lang === "en" && plain ? readingGrade(plain) : null;
  const vertices = zone ? zone.geometry.reduce((n, ring) => n + ring.length, 0) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Close composer"
        onClick={onClose}
        className="glass-scrim absolute cursor-default"
      />
      <LiquidGlass
        className="sheet relative flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={`Release order ${zoneId}`}
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="label-mono">Release order</div>
            <div className="panel-title truncate">
              Release order — <span className="readout text-hazard-text">{zoneId || "—"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "readout rounded-sm px-2 py-1 text-[10px]",
                capValid ? "bg-ok-dim text-ok" : "bg-hazard-dim text-hazard-text",
              )}
            >
              {capValid ? "CAP 1.2 · VALID" : "CAP 1.2 · INVALID"}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-sm p-1 text-faint transition-colors hover:bg-glass-hover hover:text-foreground"
            >
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto px-5 py-4">
          {!bundle || !zone || !parts ? (
            <div className="glass-inset px-4 py-6 text-center text-[12px] text-faint">
              Zone geometry and shelter assignments are not loaded yet.
            </div>
          ) : (
            <>
              {/* zone switcher — a wave can order several zones at once */}
              {wave.zoneIds.length > 1 && (
                <div className="mb-3">
                  <div className="label-mono mb-1.5">Zones in wave {wave.wave}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {wave.zoneIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setZoneId(id)}
                        data-on={id === zoneId}
                        className={cx(
                          "readout rounded-sm border px-2 py-1 text-[10.5px] transition-colors",
                          id === zoneId
                            ? "border-hairline-strong bg-glass-active text-foreground"
                            : "border-hairline bg-glass-inset text-faint hover:text-subtle",
                        )}
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* language */}
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="label-mono">Language</div>
                <div className="seg w-auto">
                  {LANG_CHIPS.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      data-on={c.code === lang}
                      onClick={() => setLang(c.code)}
                      title={c.name}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* message body */}
              <div className="glass-inset px-4 py-3.5 font-mono text-[13px] leading-[1.75]">
                <span className="font-semibold text-hazard-text">{parts.verb}</span>{" "}
                <span className="text-foreground">{parts.time}</span>{" "}
                <span className="text-foreground">{parts.direction}</span>{" "}
                <span className="font-semibold text-hazard-text">{parts.prohibition}</span>{" "}
                <span className="text-foreground">{parts.shelter}</span>{" "}
                <span className="text-subtle">{parts.fallback}</span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-faint">
                <span>
                  <span className="label-mono">Chars</span>{" "}
                  <span className="readout text-subtle">{plain.length}</span>
                </span>
                <span>
                  <span className="label-mono">Reading grade</span>{" "}
                  <span className="readout text-subtle">
                    {grade === null ? "n/a" : grade.toFixed(1)}
                  </span>
                </span>
                {lang !== "en" && (
                  <span className="readout rounded-xs bg-warn-dim px-1.5 py-0.5 text-[10px] text-warn">
                    DRAFT — NEEDS BILINGUAL REVIEW
                  </span>
                )}
              </div>

              {/* CAP fields */}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <CapField label="Urgency" value={urgency} />
                <CapField label="Severity" value={severity} />
                <CapField
                  label="Certainty"
                  value={certainty}
                  note={frame ? `hazard frame ${frame.provenance}` : undefined}
                />
                <CapField
                  label="Area"
                  value={zone.label}
                  note={`${formatCount(vertices)} polygon vertices · SAME 006007`}
                />
              </div>

              {/* door knock */}
              <div className="mt-3 flex items-center gap-3 rounded-md border border-hairline bg-warn-dim px-3 py-2.5">
                <DoorClosed size={15} strokeWidth={1.75} className="shrink-0 text-warn" />
                <div className="min-w-0 flex-1 text-[11.5px] leading-snug text-subtle">
                  <span className="readout text-warn">{formatCount(zone.noVehicleHouseholds)}</span>{" "}
                  households in {zone.id} have no vehicle and no reliable push channel. Someone has
                  to knock.
                </div>
                <div className="readout shrink-0 text-[11px] text-warn">
                  {formatShort(zone.hazardEta)} to hazard
                </div>
              </div>

              {/* actions */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQueued(true)}
                  disabled={queued}
                  className={cx(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] font-medium transition-colors",
                    queued
                      ? "border-hairline bg-ok-dim text-ok"
                      : "border-hairline-strong bg-glass-inset text-foreground hover:bg-glass-hover",
                  )}
                >
                  {queued ? (
                    <Check size={14} strokeWidth={2} />
                  ) : (
                    <AlertTriangle size={14} strokeWidth={1.75} />
                  )}
                  {queued ? "Queued — awaiting duty officer approval" : "Queue for approval"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowXml((v) => !v)}
                  className="flex items-center gap-1.5 rounded-md border border-hairline bg-glass-inset px-3 py-1.5 text-[11.5px] font-medium text-subtle transition-colors hover:bg-glass-hover hover:text-foreground"
                >
                  <Code2 size={14} strokeWidth={1.75} />
                  {showXml ? "Hide raw CAP XML" : "View raw CAP XML"}
                </button>
              </div>

              {showXml && (
                <pre className="thin-scroll glass-inset mt-3 max-h-[260px] overflow-auto px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-subtle">
                  {xml}
                </pre>
              )}
            </>
          )}
        </div>

        {/* PERSISTENT. IPAWS-OPEN has no unauthenticated send path — volunteering
            that seam is what makes everything above it credible. Never hide it. */}
        <div className="flex items-center gap-2 border-t border-hairline bg-warn-dim px-5 py-2.5">
          <AlertTriangle size={13} strokeWidth={1.75} className="shrink-0 text-warn" />
          <span className="label-mono !text-warn">DEMO BUILD — NOT CONNECTED TO IPAWS</span>
          <span className="ml-auto text-[10.5px] text-faint">
            status=Exercise · a credentialed COG and an authenticated IPAWS-OPEN session are
            required to send
          </span>
        </div>
      </LiquidGlass>
    </div>
  );
}

function CapField({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="glass-inset px-3 py-2">
      <div className="label-mono">{label}</div>
      <div className="readout truncate text-[12.5px] text-foreground">{value}</div>
      {note && <div className="mt-0.5 truncate text-[10px] text-faint">{note}</div>}
    </div>
  );
}

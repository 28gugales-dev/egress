/**
 * CAP 1.2 evacuation-order generator.
 *
 * Structure mirrors a real IPAWS-delivered WEA evacuation order
 * (GA.001_199_2024-09-29T16:06:20-04:00, Rockdale County GA, BioLab plume)
 * pulled live from https://www.fema.gov/api/open/v1/IpawsArchivedAlerts
 *
 * Spec: https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html
 */

export type CapStatus = "Actual" | "Exercise" | "System" | "Test" | "Draft";
export type CapMsgType = "Alert" | "Update" | "Cancel" | "Ack" | "Error";
export type CapScope = "Public" | "Restricted" | "Private";
export type CapCategory =
  | "Geo" | "Met" | "Safety" | "Security" | "Rescue" | "Fire"
  | "Health" | "Env" | "Transport" | "Infra" | "CBRNE" | "Other";
export type CapResponseType =
  | "Shelter" | "Evacuate" | "Prepare" | "Execute" | "Avoid"
  | "Monitor" | "Assess" | "AllClear" | "None";
export type CapUrgency = "Immediate" | "Expected" | "Future" | "Past" | "Unknown";
export type CapSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
export type CapCertainty = "Observed" | "Likely" | "Possible" | "Unlikely" | "Unknown";

/** One evacuation zone -> one CAP <area> block. */
export interface CapArea {
  areaDesc: string;
  /** GeoJSON Polygon or MultiPolygon geometry, WGS84 [lon,lat]. Axis order is
   *  swapped to CAP's lat,lon internally. */
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  /** SAME code: "0" + 5-digit county FIPS. Butte CA = 006007. */
  sameGeocodes?: string[];
}

export interface CapEvacuationOrderInput {
  identifier: string;
  sender: string;
  senderName: string;
  /** Defaults to "Exercise". Only a credentialed COG may emit "Actual". */
  status?: CapStatus;
  msgType?: CapMsgType;
  sent?: Date;
  effective?: Date;
  onset?: Date;
  expires?: Date;
  event?: string;
  urgency?: CapUrgency;
  severity?: CapSeverity;
  certainty?: CapCertainty;
  headline: string;
  description: string;
  instruction: string;
  web?: string;
  /** <= 90 chars. Truncated with a warning if longer. */
  weaShortText: string;
  /** <= 360 chars. */
  weaLongText: string;
  areas: CapArea[];
}

const MAX_CMAM_SHORT = 90;
const MAX_CMAM_LONG = 360;
/** IPAWS rejects polygons above this vertex count; simplify upstream. */
export const IPAWS_MAX_POLYGON_VERTICES = 100;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CAP requires local time with a UTC offset, never a bare "Z". */
function capDate(d: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/**
 * GeoJSON ring ([lon,lat]) -> CAP polygon string ("lat,lon" pairs).
 * THE axis swap. Enforces CAP's closure rule and 4-pair minimum.
 */
export function ringToCapPolygon(ring: number[][]): string {
  const pairs = ring.map(([lon, lat]) => `${lat},${lon}`);
  if (pairs.length && pairs[0] !== pairs[pairs.length - 1]) pairs.push(pairs[0]);
  if (pairs.length < 4) {
    throw new Error(`CAP polygon needs >= 4 coordinate pairs, got ${pairs.length}`);
  }
  if (pairs.length > IPAWS_MAX_POLYGON_VERTICES) {
    console.warn(
      `Polygon has ${pairs.length} vertices; IPAWS caps at ${IPAWS_MAX_POLYGON_VERTICES}. ` +
        `Simplify with turf.simplify() before sending.`
    );
  }
  return pairs.join(" ");
}

/** Outer rings only — CAP has no hole concept. MultiPolygon yields several. */
function geometryToCapPolygons(
  g: GeoJSON.Polygon | GeoJSON.MultiPolygon
): string[] {
  if (g.type === "Polygon") return [ringToCapPolygon(g.coordinates[0])];
  return g.coordinates.map((poly) => ringToCapPolygon(poly[0]));
}

export function generateCapEvacuationOrder(
  input: CapEvacuationOrderInput
): string {
  const sent = input.sent ?? new Date();
  const effective = input.effective ?? sent;
  const expires = input.expires ?? new Date(sent.getTime() + 4 * 3600_000);

  if (input.weaShortText.length > MAX_CMAM_SHORT) {
    console.warn(
      `CMAMtext is ${input.weaShortText.length} chars, max ${MAX_CMAM_SHORT}. Truncating.`
    );
  }
  if (input.weaLongText.length > MAX_CMAM_LONG) {
    console.warn(
      `CMAMlongtext is ${input.weaLongText.length} chars, max ${MAX_CMAM_LONG}. Truncating.`
    );
  }

  const areaXml = input.areas
    .map((a) => {
      const polys = a.geometry ? geometryToCapPolygons(a.geometry) : [];
      return [
        `    <area>`,
        `      <areaDesc>${xmlEscape(a.areaDesc)}</areaDesc>`,
        ...polys.map((p) => `      <polygon>${p}</polygon>`),
        ...(a.sameGeocodes ?? []).map(
          (g) =>
            `      <geocode><valueName>SAME</valueName><value>${xmlEscape(
              g
            )}</value></geocode>`
        ),
        `    </area>`,
      ].join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${xmlEscape(input.identifier)}</identifier>
  <sender>${xmlEscape(input.sender)}</sender>
  <sent>${capDate(sent)}</sent>
  <status>${input.status ?? "Exercise"}</status>
  <msgType>${input.msgType ?? "Alert"}</msgType>
  <scope>Public</scope>
  <code>IPAWSv1.0</code>
  <info>
    <language>en-US</language>
    <category>Safety</category>
    <event>${xmlEscape(input.event ?? "immediate evacuation order")}</event>
    <responseType>Evacuate</responseType>
    <urgency>${input.urgency ?? "Immediate"}</urgency>
    <severity>${input.severity ?? "Severe"}</severity>
    <certainty>${input.certainty ?? "Likely"}</certainty>
    <eventCode><valueName>SAME</valueName><value>EVI</value></eventCode>
    <effective>${capDate(effective)}</effective>${
    input.onset ? `\n    <onset>${capDate(input.onset)}</onset>` : ""
  }
    <expires>${capDate(expires)}</expires>
    <senderName>${xmlEscape(input.senderName)}</senderName>
    <headline>${xmlEscape(input.headline)}</headline>
    <description>${xmlEscape(input.description)}</description>
    <instruction>${xmlEscape(input.instruction)}</instruction>${
    input.web ? `\n    <web>${xmlEscape(input.web)}</web>` : ""
  }
    <parameter><valueName>WEAHandling</valueName><value>Imminent Threat</value></parameter>
    <parameter><valueName>CMAMtext</valueName><value>${xmlEscape(
      input.weaShortText.slice(0, MAX_CMAM_SHORT)
    )}</value></parameter>
    <parameter><valueName>CMAMlongtext</valueName><value>${xmlEscape(
      input.weaLongText.slice(0, MAX_CMAM_LONG)
    )}</value></parameter>
    <parameter><valueName>EAS-ORG</valueName><value>CIV</value></parameter>
${areaXml}
  </info>
</alert>`;
}

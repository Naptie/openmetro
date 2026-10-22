/**
 * Network layer for Taiyuan Metro.
 *
 * Three public sources, all keyless:
 *
 * 1. **Official site** — `https://www.tymetro.ltd/api/lines` (Spring Boot
 *    REST behind the operator's Vue SPA) publishes the full line topology,
 *    the per-stop first/last trains (second precision) and the station
 *    records (exits, facilities, photos, 3D models, art descriptions).
 * 2. **AMap subway dataset** — `https://webapi.amap.com/subway/data/1401_drw_taiyuan.json`
 *    (adcode 1401 / spell `taiyuan`, the same file the operator's own site
 *    renders through the AMap metro map) supplies GCJ-02 coordinates, English
 *    names, schematic pixels and the line colours.
 * 3. **Official route planner** — `https://webapi.amap.com/subway/service/navigation/busExt`
 *    is the backend behind the operator's "路线查询" page. It returns the OD
 *    fare, the run time and distance of every ride leg, the ride geometry and
 *    the in-station transfer walk.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const SITE = 'https://www.tymetro.ltd';
const OFFICIAL_LINES_API = `${SITE}/api/lines`;
const TICKET_GUIDE_API = `${SITE}/api/contents/uid/ticket-guide`;
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/1401_drw_taiyuan.json';
const AMAP_PLANNER = 'https://webapi.amap.com/subway/service/navigation/busExt';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer?: string, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer ?? SITE }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, referer?: string): Promise<T> {
  return JSON.parse(await getText(url, referer)) as T;
}

// ── Official site ────────────────────────────────────────────────────────────

export interface TyOfficialStation {
  id: number;
  name: string;
  transfer: boolean;
  transferLines: number[];
  status: string;
  upFirstTime: string | null;
  upLatestTime: string | null;
  downFirstTime: string | null;
  downLatestTime: string | null;
  description: string | null;
  threeDsrc: string;
  threeDimg: string | null;
  siteDesc: string | null;
  exits: { seq: number | null; name: string; photoSrc: string; description: string }[];
  facilities: { type: string; enabled: boolean; description: string }[];
  photos: unknown[];
  nearbies: unknown[];
  /** `"lon,lat"` — published for 2号线, missing on 1号线 except 大南门. */
  position: string | null;
}

export interface TyOfficialStop {
  id: number;
  seq: number;
  line: { id: number; name: string; route: number; status: string };
  station: TyOfficialStation;
  upFirstTime: string | null;
  upLastTime: string | null;
  downFirstTime: string | null;
  downLastTime: string | null;
}

export interface TyOfficialLine {
  id: number;
  name: string;
  route: number;
  status: string;
  description: string;
  mapImg: string;
  stops: TyOfficialStop[];
}

interface TyOfficialLinesEnvelope {
  totalElements?: number;
  results?: TyOfficialLine[];
}

/** `GET /api/lines` — the operator's authoritative topology + timetable. */
export async function fetchOfficialLines(): Promise<TyOfficialLine[]> {
  const env = await getJson<TyOfficialLinesEnvelope>(OFFICIAL_LINES_API);
  const lines = env.results ?? [];
  if (lines.length === 0) throw new Error('tymetro /api/lines returned no lines');
  for (const l of lines) {
    if (!l.stops?.length) throw new Error(`tymetro /api/lines: ${l.name} has no stops`);
  }
  return lines;
}

/** `GET /api/contents/uid/ticket-guide` — the published fare policy text. */
export async function fetchTicketGuide(): Promise<{ name: string; content: string } | undefined> {
  try {
    const doc = await getJson<{ name?: string; content?: string }>(TICKET_GUIDE_API);
    if (!doc?.content) return undefined;
    return { name: doc.name ?? '太原市轨道交通票务规则', content: doc.content };
  } catch (err) {
    console.log(`  ticket-guide unavailable: ${err}`);
    return undefined;
  }
}

// ── AMap subway dataset ─────────────────────────────────────────────────────

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  sl?: string;
  p?: string;
  udpx?: string;
  poiid?: string;
  sid?: string;
  multilang?: { n?: { en?: string; 'zh-Hant-HK'?: string; 'zh-Hant-TW'?: string } };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  cl?: string;
  /** Schematic polyline, "x y" pairs. */
  c?: string[];
  /** Line id, sometimes two ids separated by "|". */
  li?: string;
  st?: AmapStation[];
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

/** AMap subway dataset for Taiyuan (GCJ-02 coordinates, no API key). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  const doc = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, 'https://map.amap.com/');
  if (!doc.l?.length) throw new Error('amap subway 1401 returned no lines');
  return doc;
}

// ── Official route planner ───────────────────────────────────────────────────

export interface PlannerStation {
  name: string;
  lon: number;
  lat: number;
  poiid: string;
}

export interface PlannerWalkInfo {
  dir?: string;
  infolist?: { distance?: string; coord?: string; walktype_orgn?: string; indoor?: string }[];
}

export interface PlannerSegment {
  startname: string;
  endname: string;
  startid: string;
  endid: string;
  busname: string;
  bus_key_name: string;
  busid: string;
  /** Ride length in metres. */
  driverlength: string;
  /** Ride time incl. the headway wait. */
  drivertime: string;
  /** Pure in-vehicle run time, excluding the headway wait. */
  busDriveTime: string;
  /** Scheduled headway wait at the boarding station. */
  busWaitTime: string;
  /** Fare of this leg; -1 when the leg continues an earlier ticket. */
  price: string;
  color: string;
  interval_desc: string;
  directionName: string;
  starttime: string;
  endtime: string;
  transfertype: string;
  transfertip: string;
  footlength: string;
  foottime: string;
  walk: PlannerWalkInfo;
  /** Ride geometry, "lon,lat" pairs. */
  drivercoord: string;
  passdepotcount: string;
  passdepotname: string;
}

export interface PlannerRoute {
  busindex: string;
  /** Total OD fare in yuan. */
  expense: string;
  expensetime: string;
  allLength: string;
  allfootlength: string;
  routeType: string;
  segmentlist: PlannerSegment[];
}

export interface PlannerResponse {
  code: string;
  message: string;
  routing_date?: string;
  buslist?: PlannerRoute[];
}

/**
 * One OD query against the operator's route planner.
 *
 * `type=6` selects the metro dataset, `Ver=3` the current response shape.
 * The `uuid` is the planner's own request correlation id.
 */
export async function fetchPlannerRoute(
  from: PlannerStation,
  to: PlannerStation,
  retries = 3
): Promise<PlannerResponse | undefined> {
  const params = new URLSearchParams({
    x1: from.lon.toFixed(6),
    y1: from.lat.toFixed(6),
    x2: to.lon.toFixed(6),
    y2: to.lat.toFixed(6),
    poiid1: from.poiid,
    poiid2: to.poiid,
    uuid: `openmetro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type: '6',
    Ver: '3'
  });
  const url = `${AMAP_PLANNER}?${params.toString()}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: `${SITE}/service/map` }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`GET planner -> ${res.status}`);
      const body = (await res.json()) as PlannerResponse;
      if (body.code !== '1') return undefined;
      return body;
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** attempt);
    }
  }
  console.log(`  planner ${from.name}->${to.name} failed: ${lastErr}`);
  return undefined;
}

/** Parse a `"lon,lat,lon,lat,…"` geometry string into points. */
export function parseCoordPairs(raw: string | undefined): { lon: number; lat: number }[] {
  if (!raw) return [];
  const out: { lon: number; lat: number }[] = [];
  for (const pair of raw.split(',')) {
    const parts = pair.trim().split(' ');
    if (parts.length !== 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
  }
  return out;
}

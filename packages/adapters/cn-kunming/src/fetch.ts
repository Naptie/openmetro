/**
 * Network layer for Kunming Rail Transit.
 *
 * Two keyless public sources:
 *
 * 1. **AMap subway dataset** — `https://webapi.amap.com/subway/data/5301_drw_kunming.json`
 *    (adcode 5301, spell `kunming`; confirmed against AMap's own
 *    `subway/data/citylist.json`). Supplies the line roster, the ordered
 *    station list of every alignment, GCJ-02 coordinates, English names,
 *    pinyin, line colours and the schematic pixels.
 * 2. **AMap metro route planner** — `https://webapi.amap.com/subway/service/navigation/busExt`
 *    is the endpoint behind the metro "路线查询" widget. One OD query returns
 *    the fare, the in-vehicle run time, the ride length, the ride geometry,
 *    the first/last train at the boarding station, the scheduled headway, the
 *    service pattern the train belongs to and the intermediate stops.
 *
 * The operator's own site (`www.kmgdgs.com`) is gone — see `lines.ts` — so the
 * planner is the only live source for run times, fares and first/last trains.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

export const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/5301_drw_kunming.json';
export const AMAP_PLANNER = 'https://webapi.amap.com/subway/service/navigation/busExt';

/** AMap subway adcode / spell for 昆明. */
export const AMAP_CITY_CODE = '5301';
export const AMAP_CITY_SPELL = 'kunming';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, referer: string, retries = 4): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
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

// ── AMap subway dataset ──────────────────────────────────────────────────────

export interface AmapStation {
  /** Chinese station name, sometimes with a disambiguating suffix. */
  n?: string;
  /** English name (legacy field; the current one lives in `multilang`). */
  en?: string;
  /** CamelCase pinyin. */
  sp?: string;
  /** GCJ-02 `lon,lat`. */
  sl?: string;
  /** Schematic pixel `x y`. */
  p?: string;
  /** Up/down schematic pixels `x y;x y`. */
  udpx?: string;
  /** AMap POI id — the planner's station key. */
  poiid?: string;
  /** Station id (network-wide). */
  sid?: string;
  /** Per-line station code. */
  si?: string;
  /** Ids of the alignments this station belongs to. */
  r?: string;
  /** Transfer flag. */
  t?: string;
  multilang?: { n?: { en?: string; 'zh-Hant-HK'?: string; 'zh-Hant-TW'?: string } };
}

export interface AmapLine {
  /** Line name, e.g. `1号线`. */
  ln?: string;
  /** Full line name, e.g. `地铁1号线`. */
  kn?: string;
  /** Line colour hex. */
  cl?: string;
  /** Route label of the alignment, e.g. `环城南路-大学城南`. */
  la?: string;
  /** Line-set id. */
  ls?: string;
  /** Line ids, `up|down`. */
  li?: string;
  /** Up/down alignment ids. */
  udli?: string;
  /** Up/down line ids. */
  udsi?: string;
  /** Schematic polyline vertices, `x y` pairs. */
  c?: string[];
  /** Up/down schematic polylines. */
  f?: { c?: string[]; li?: string }[];
  /** Ordered stations of the alignment. */
  st?: AmapStation[];
}

export interface AmapSubwayDoc {
  /** City name. */
  s?: string;
  /** City adcode. */
  i?: string;
  l?: AmapLine[];
}

/** AMap subway dataset for 昆明 (GCJ-02 coordinates, no API key). */
export async function fetchAmapSubway(): Promise<AmapSubwayDoc> {
  const doc = JSON.parse(await getText(AMAP_SUBWAY, 'https://map.amap.com/')) as AmapSubwayDoc;
  const lines = doc.l ?? [];
  if (lines.length < 6)
    throw new Error(`amap subway ${AMAP_CITY_CODE} returned ${lines.length} lines`);
  const stations = lines.reduce((acc, l) => acc + (l.st?.length ?? 0), 0);
  if (stations < 100)
    throw new Error(`amap subway ${AMAP_CITY_CODE} returned only ${stations} stations`);
  return doc;
}

// ── AMap metro route planner ─────────────────────────────────────────────────

/** A station the planner can be asked about. */
export interface PlannerStation {
  name: string;
  lon: number;
  lat: number;
  /** AMap POI id — the planner's station key. */
  poiid: string;
}

/** A ride leg of a planner route. */
export interface PlannerSegment {
  /** Origin station name as the planner knows it. */
  startname?: string;
  /** Destination station name. */
  endname?: string;
  /** Origin station id. */
  startid?: string;
  /** Destination station id. */
  endid?: string;
  /**
   * Service pattern label, e.g. `地铁1号线(环城南路(北部汽车站)--大学城南·云南开放大学)`.
   * This is what identifies the 交路 a train belongs to.
   */
  busname?: string;
  /** Line name without the route label, e.g. `地铁1号线`. */
  bus_key_name?: string;
  /** Line id of the alignment. */
  busid?: string;
  /** First train at the boarding station, `HH:MM`. */
  stationStartTime?: string;
  /** Last train at the boarding station, `HH:MM`. */
  stationEndTime?: string;
  /** Pure in-vehicle run time in seconds (excludes the headway wait). */
  busDriveTime?: string;
  /** Scheduled headway wait at the boarding station, in seconds. */
  busWaitTime?: string;
  /** Ride time including the headway wait, in seconds. */
  drivertime?: string;
  /** Ride length in metres. */
  driverlength?: string;
  /** Ride geometry, `lon,lat,lon,lat,…` (GCJ-02). */
  drivercoord?: string;
  /** Line colour hex. */
  color?: string;
  /** Headway description, e.g. `首站发车约10分钟/趟`. */
  interval_desc?: string;
  /** Destination of the service, e.g. `大学城南·云南开放大学`. */
  directionName?: string;
  /** `1` when this leg starts after an in-station interchange. */
  transfertype?: string;
  /** Intermediate stations of the ride, space separated. */
  passdepotname?: string;
  /** Intermediate station ids, space separated. */
  passdepotid?: string;
  /** Intermediate station coordinates, `lon,lat,lon,lat,…`. */
  passdepotcoord?: string;
}

export interface PlannerRoute {
  /** Total OD fare in yuan. */
  expense?: string;
  /** Total OD duration in seconds (including the headway wait). */
  expensetime?: string;
  /** Total OD length in metres. */
  allLength?: string;
  /** Number of intermediate stations. */
  passdepotcount?: string;
  segmentlist?: PlannerSegment[];
}

export interface PlannerResponse {
  code?: string;
  message?: string;
  /** The day the planner answered for — it ignores any date parameter. */
  routing_date?: string;
  buslist?: PlannerRoute[];
}

/**
 * One OD query against the AMap metro planner.
 *
 * `type=6` selects the metro dataset, `Ver=3` the current response shape.
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
        headers: officialFetchHeaders({ Referer: 'https://map.amap.com/' }),
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

/**
 * Parse the planner's `lon,lat,lon,lat,…` geometry string.
 *
 * Note the format differs from other cities: Kunming's planner emits
 * comma-separated pairs with no inner separator, while the Taiyuan planner
 * emits space-separated pairs.
 */
export function parsePlannerCoordPairs(raw: string | undefined): { lon: number; lat: number }[] {
  if (!raw) return [];
  const parts = raw.split(',');
  const out: { lon: number; lat: number }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const lon = Number(parts[i]);
    const lat = Number(parts[i + 1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
  }
  return out;
}

/**
 * Split a service pattern label into its origin and destination.
 *
 * `地铁1号线(环城南路(北部汽车站)--大学城南·云南开放大学)` →
 * `{ line: '地铁1号线', origin: '环城南路(北部汽车站)', destination: '大学城南·云南开放大学' }`
 */
export function parseServicePattern(busname: string | undefined): {
  line: string;
  origin: string;
  destination: string;
} | null {
  if (!busname) return null;
  const open = busname.indexOf('(');
  const close = busname.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const line = busname.slice(0, open).trim();
  const body = busname.slice(open + 1, close);
  const sep = body.indexOf('--');
  if (sep < 0) return null;
  return {
    line,
    origin: body.slice(0, sep).trim(),
    destination: body.slice(sep + 2).trim()
  };
}

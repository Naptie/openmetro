/**
 * Baidu Direction v2 transit client for the Changchun adapter.
 *
 * The operator publishes its per-station first/last-train sheet only as JPEG
 * images (`/1hx4` … `/8hx4` and the combined 首末班及换乘时间表 notice), so —
 * like cn-jinan, cn-urumqi, cn-xian and cn-shijiazhuang — everything those
 * images carry is harvested live from the Baidu planner instead. There is no
 * OCR path.
 *
 * `direction/v2/transit` is used rather than the older `directionlite/v1`
 * because its `vehicle_info.detail` carries the **boarding station's** own
 * first/last departures:
 *
 * - `detail.first_time` = first departure at the boarding station.
 * - `detail.last_time`  = last departure at the boarding station.
 *
 * Verified 2026-10-22 against the operator's published timetable sheets:
 * 北环城路 05:50/22:35, 人民广场 06:02/22:48, 长春站 05:57/22:43,
 * 红嘴子 05:15/22:35 — the planner agrees with the sheets on every probed
 * pair, for all eight lines (including 5号线, which opened 2026-09-28 and is
 * absent from the `directionlite` dataset).
 *
 * `directionlite/v1`'s `end_info.end_time` instead means "arrival at the
 * destination", which is why this adapter does not use that endpoint — and
 * why `core.lastDepartureFromArrival()` must not be applied to these values.
 *
 * The operator's own route planner (`POST /api/v1/getTicketFee`) returns an
 * empty result for every parameter form, so it is never used as a data
 * source here.
 */
import { foldStationName, proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner (长春), per the Baidu transit contract. */
export const BAIDU_CITY = '长春';

/** A rail leg (轨道交通) of a planner route. */
export interface BaiduTransitLeg {
  /** Operator line name as the planner knows it, e.g. `轨道交通1号线`. */
  lineName: string;
  /** Direction label, e.g. `红嘴子方向`. */
  direction: string;
  /** Boarding stop name with exit suffix, e.g. `北环城路站(C口)`. */
  onStation: string;
  /** Alighting stop name with exit suffix. */
  offStation: string;
  firstTime: string | null;
  lastTime: string | null;
  /** In-vehicle seconds for this leg (planner measurement). */
  durationSeconds: number | null;
  /** In-vehicle meters for this leg (planner measurement). */
  distanceMeters: number | null;
  /** Number of stations the leg runs through. */
  stopCount: number | null;
  lineId: string | null;
}

/** A walking leg of a planner route (access, station-hall transfer, egress). */
export interface BaiduWalkLeg {
  instruction: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  /** Walk start point (BD-09 as the planner reports it, for hub scoring). */
  startLocation?: { lon: number; lat: number };
  /** Walk end point. */
  endLocation?: { lon: number; lat: number };
}

/** One ordered step of a planner route. */
export interface BaiduRouteStep {
  kind: 'rail' | 'walk';
  /** Present on `kind: 'rail'` steps. */
  leg?: BaiduTransitLeg;
  /** Present on `kind: 'walk'` steps. */
  walk?: BaiduWalkLeg;
}

export interface BaiduRoute {
  /** Total route meters including walking. */
  distanceMeters: number | null;
  /** Total route seconds including walking. */
  durationSeconds: number | null;
  /** Route-level fare quote in yuan (operator's shortest-path pricing). */
  price: number | null;
  legs: BaiduTransitLeg[];
  walks: BaiduWalkLeg[];
  /** Rail and walk steps in travel order. */
  steps: BaiduRouteStep[];
}

interface V2Step {
  distance?: number;
  duration?: number;
  instructions?: string;
  start_location?: { lng?: number; lat?: number };
  end_location?: { lng?: number; lat?: number };
  vehicle_info?: {
    type?: number;
    detail?: {
      name?: string;
      direct_text?: string;
      first_time?: string;
      last_time?: string;
      on_station?: string;
      off_station?: string;
      line_id?: string;
      type?: number;
      stop_num?: number;
    } | null;
  } | null;
}

interface V2Route {
  distance?: number;
  duration?: number;
  price?: number | string | null;
  steps?: V2Step[][];
}

interface V2Response {
  status?: number;
  message?: string;
  result?: {
    routes?: V2Route[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fold a planner stop name to the operator's station name.
 *
 * The planner appends the boarding exit (`北环城路站(C口)`,
 * `解放大路站(地铁B通道口-长春万象城)`) and may carry a parenthetical
 * qualifier that belongs to the station name itself
 * (`南湖广场(吉大南湖校区)站(B口)`). Only the exit group — the one that
 * directly follows `站` — is dropped, so a station whose name ends in a
 * qualifier (`硅谷广场(吉大中心校区)`) keeps it.
 */
export function foldStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = raw.trim();
  // Strip the boarding-exit group: `站(...)`.
  const exit = /站[(（][^)）]*[)）]$/.exec(s);
  if (exit) s = s.slice(0, exit.index).trim();
  if (s.endsWith('站')) s = s.slice(0, -1);
  return foldStationName(s);
}

/** True when the planner's vehicle name is a rail line of this network. */
export function isRailLeg(detail: { name?: string; type?: number } | undefined): boolean {
  if (!detail) return false;
  if (detail.type === 1) return true;
  const name = String(detail.name ?? '');
  return name.startsWith('轨道交通') || name.includes('地铁');
}

/** Read a planner geo point (`{lng, lat}`) into `{lon, lat}`. */
function readPoint(
  p: { lng?: number; lat?: number } | undefined
): { lon: number; lat: number } | undefined {
  if (!p) return undefined;
  const lon = Number(p.lng);
  const lat = Number(p.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { lon, lat };
}

function transitUrl(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): string {
  const params = new URLSearchParams({
    origin: `${origin.lat.toFixed(6)},${origin.lon.toFixed(6)}`,
    destination: `${destination.lat.toFixed(6)},${destination.lon.toFixed(6)}`,
    coord_type: 'gcj02',
    ret_coordtype: 'gcj02',
    // 5 = 地铁优先 — the strongest public rail preference; there is no hard
    // "rail only" switch.
    tactics_incity: '5',
    city: BAIDU_CITY,
    ak
  });
  return proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`);
}

/** One planner OD query, returning every route the planner offers. */
async function fetchBaiduRoutes(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<V2Route[]> {
  const url = transitUrl(ak, origin, destination);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'openmetro/0.1' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as V2Response;
      if (typeof j.status === 'number' && j.status !== 0) return [];
      return j.result?.routes ?? [];
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** The rail and walking legs of one planner route. */
function parseRoute(route: V2Route): {
  legs: BaiduTransitLeg[];
  walks: BaiduWalkLeg[];
  steps: BaiduRouteStep[];
} {
  const legs: BaiduTransitLeg[] = [];
  const walks: BaiduWalkLeg[] = [];
  const steps: BaiduRouteStep[] = [];
  for (const group of route.steps ?? []) {
    for (const step of group) {
      const detail = step.vehicle_info?.detail;
      if (detail) {
        if (!isRailLeg(detail)) continue;
        const leg: BaiduTransitLeg = {
          lineName: String(detail.name ?? ''),
          direction: String(detail.direct_text ?? ''),
          onStation: String(detail.on_station ?? ''),
          offStation: String(detail.off_station ?? ''),
          firstTime: detail.first_time ?? null,
          lastTime: detail.last_time ?? null,
          durationSeconds: step.duration ?? null,
          distanceMeters: step.distance ?? null,
          stopCount: detail.stop_num ?? null,
          lineId: detail.line_id ?? null
        };
        legs.push(leg);
        steps.push({ kind: 'rail', leg });
        continue;
      }
      // Walk leg (access / station-hall transfer / egress).
      const instruction = String(step.instructions ?? '');
      if (!instruction) continue;
      const walk: BaiduWalkLeg = {
        instruction,
        distanceMeters: step.distance ?? null,
        durationSeconds: step.duration ?? null,
        startLocation: readPoint(step.start_location),
        endLocation: readPoint(step.end_location)
      };
      walks.push(walk);
      steps.push({ kind: 'walk', walk });
    }
  }
  return { legs, walks, steps };
}

/** One planner OD query, returning the best route's rail and walking legs. */
export async function fetchBaiduRoute(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRoute | null> {
  const routes = await fetchBaiduRoutes(ak, origin, destination, retries);
  const route = routes[0];
  if (!route) return null;
  const { legs, walks, steps } = parseRoute(route);
  const price = Number(route.price);
  return {
    distanceMeters:
      typeof route.distance === 'number' && Number.isFinite(route.distance) ? route.distance : null,
    durationSeconds:
      typeof route.duration === 'number' && Number.isFinite(route.duration) ? route.duration : null,
    price: Number.isFinite(price) && price > 0 ? price : null,
    legs,
    walks,
    steps
  };
}

/**
 * Every rail leg across every route of one planner OD.
 *
 * The planner returns up to five routes and the one it ranks first is not
 * always the one that uses the wanted line — the 2号线 hop 双丰→长春西站 comes
 * back as 6号线 first and 2号线 second — so all routes are scanned.
 */
export async function fetchBaiduTransitLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduTransitLeg[]> {
  const routes = await fetchBaiduRoutes(ak, origin, destination, retries);
  const out: BaiduTransitLeg[] = [];
  for (const route of routes) out.push(...parseRoute(route).legs);
  return out;
}

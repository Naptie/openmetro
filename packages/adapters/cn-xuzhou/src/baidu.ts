/**
 * Baidu Direction v2 transit client for the Xuzhou adapter.
 *
 * The operator publishes the official first/last sheet and the official
 * station-to-station fare table itself (see `./timetables.ts` and
 * `./fares.ts`), so this client is used only for what the operator does not
 * publish: **in-vehicle segment durations, in-vehicle distances, transfer
 * walks and the track geometry**.
 *
 * `direction/v2/transit` is used because its `vehicle_info.detail` carries
 * the boarding station's first/last departure (`first_time` / `last_time`),
 * the boarding and alighting stops, the stop count and the intermediate
 * stops with their own coordinates. Verified 2026-10-23: the planner's
 * `first_time`/`last_time` agree with the operator's published sheet on every
 * probed pair (路窝 06:00/22:30, 徐州东站 06:00/22:30, …), which makes the
 * planner usable as an independent cross-check of the timetable layer.
 *
 * `directionlite/v1` is deliberately not used: its `end_info.end_time` means
 * "arrival at the destination" rather than "last departure at the boarding
 * station", which is the opposite of what a first/last sheet means.
 */
import { foldStationName, proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner (Xuzhou), per the Baidu transit contract. */
export const BAIDU_CITY = '徐州';

/** A rail leg (地铁) of a planner route. */
export interface BaiduTransitLeg {
  /** Operator line name as the planner knows it, e.g. `地铁1号线`. */
  lineName: string;
  /** Direction label, e.g. `徐州东站方向`. */
  direction: string;
  /** Boarding stop name with exit suffix, e.g. `路窝站(3口)`. */
  onStation: string;
  /** Alighting stop name with exit suffix. */
  offStation: string;
  firstTime: string | null;
  lastTime: string | null;
  /** In-vehicle seconds for this leg (planner measurement). */
  durationSeconds: number | null;
  /** In-vehicle meters for this leg (planner measurement). */
  distanceMeters: number | null;
  /** Intermediate stops with the planner's own coordinates. */
  stopNames: string[];
  lineId: string | null;
  /** The planner's line colour, e.g. `#a32c36`. */
  lineColor: string | null;
}

/** A walking leg of a planner route (access, station-hall transfer, egress). */
export interface BaiduWalkLeg {
  instruction: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
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
  /** Route-level fare quote in yuan (the operator's shortest-path pricing). */
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
  /** The track polyline of this step (`lng,lat;…`). */
  path?: string;
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
      line_color?: string;
      bus_type?: number;
      type?: number;
      stop_num?: number;
      stop_info?: { stop_name?: string }[];
    } | null;
  } | null;
}

interface V2Response {
  status?: number;
  message?: string;
  result?: {
    routes?: {
      distance?: number;
      duration?: number;
      price?: number | string | null;
      steps?: V2Step[][];
    }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Planner stop names carry exit suffixes and a 站 suffix; fold both away. */
export function foldStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  const bare = raw
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/站$/, '')
    .replace(/\s+/g, '')
    .trim();
  return foldStationName(bare);
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

/** One planner OD query, returning the response for every offered route. */
async function fetchPlannerResponse(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<V2Response | null> {
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
      if (typeof j.status === 'number' && j.status !== 0) return null;
      return j;
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One planner route as the v2 payload carries it. */
type V2Route = NonNullable<NonNullable<V2Response['result']>['routes']>[number];

/** Parse one planner route into its rail and walking legs. */
function parseRoute(route: V2Route): {
  legs: BaiduTransitLeg[];
  walks: BaiduWalkLeg[];
  steps: BaiduRouteStep[];
  distanceMeters: number | null;
  durationSeconds: number | null;
  price: number | null;
} {
  const legs: BaiduTransitLeg[] = [];
  const walks: BaiduWalkLeg[] = [];
  const steps: BaiduRouteStep[] = [];
  for (const group of route.steps ?? []) {
    for (const step of group) {
      const detail = step.vehicle_info?.detail;
      if (detail) {
        const name = String(detail.name ?? '');
        // Rail-class legs only: 地铁* vehicle names. Walk steps carry no
        // detail; bus legs name their route (…路).
        if (!name.includes('地铁') && !name.includes('轨道')) continue;
        const leg: BaiduTransitLeg = {
          lineName: name,
          direction: String(detail.direct_text ?? ''),
          onStation: String(detail.on_station ?? ''),
          offStation: String(detail.off_station ?? ''),
          firstTime: detail.first_time ?? null,
          lastTime: detail.last_time ?? null,
          durationSeconds: step.duration ?? null,
          distanceMeters: step.distance ?? null,
          stopNames: (detail.stop_info ?? [])
            .map((s) => String(s.stop_name ?? ''))
            .filter((s) => s.length > 0),
          lineId: detail.line_id ?? null,
          lineColor: detail.line_color ?? null
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
        durationSeconds: step.duration ?? null
      };
      walks.push(walk);
      steps.push({ kind: 'walk', walk });
    }
  }
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

/** One planner OD query, returning the best route's rail and walking legs. */
export async function fetchBaiduRoute(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRoute | null> {
  const j = await fetchPlannerResponse(ak, origin, destination, retries);
  const route = j?.result?.routes?.[0];
  if (!route) return null;
  return parseRoute(route);
}

/**
 * Every rail leg across every route of one planner OD.
 *
 * All routes are scanned, not just the first: the planner often offers a
 * detour before the direct hop (无名山公园 → 玉泉河 comes back as
 * 铜山中医院 → 玉泉河 on Line 6 first, and the direct Line 3 hop second),
 * and a one-hop pair must be measured on the route that actually boards at
 * the pair's two stations.
 */
export async function fetchBaiduTransitLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduTransitLeg[]> {
  const j = await fetchPlannerResponse(ak, origin, destination, retries);
  const out: BaiduTransitLeg[] = [];
  for (const route of j?.result?.routes ?? []) {
    out.push(...parseRoute(route).legs);
  }
  return out;
}

/**
 * One planner OD fare quote (route-level `price`).
 *
 * The planner prices on its own chosen path, which can differ from the
 * operator's shortest-path price — so this is only ever a cross-check of the
 * official fare matrix, never the matrix itself.
 */
export async function fetchBaiduFare(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 1
): Promise<number | null> {
  const route = await fetchBaiduRoute(ak, origin, destination, retries);
  if (!route || route.legs.length === 0) return null;
  return route.price;
}

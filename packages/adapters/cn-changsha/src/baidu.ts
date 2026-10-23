/**
 * Baidu Direction v2 transit client for the Changsha adapter.
 *
 * The operator's own data covers the network topology, the per-station
 * per-direction first/last trains, the line colours and the interchange map,
 * but it publishes **no** transfer walk times, **no** per-segment distances
 * and **no** fare matrix — those three layers are measured from the planner.
 *
 * `direction/v2/transit` is used (not the older `directionlite/v1`) because
 * its `vehicle_info.detail` carries `first_time` / `last_time` **at the
 * boarding station**, the same convention the operator's own table uses, and
 * its `detail.name` names the operator line exactly (`轨道交通2号线`,
 * `磁浮快线`) so a leg can be matched to a canonical line.
 *
 * The planner is also the source of the OD fare quotes used to cross-check the
 * official tariff (see `fares.ts`).
 */
import { foldStationName, proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner (Changsha), per the Baidu transit contract. */
export const BAIDU_CITY = '长沙';

/** Vehicle-name fragments that identify a rail leg of a Changsha route. */
const RAIL_NAME_FRAGMENTS = ['轨道交通', '地铁', '磁浮', '捷运'];

/** A rail leg (轨道交通) of a planner route. */
export interface BaiduTransitLeg {
  /** Operator line name as the planner knows it, e.g. `轨道交通2号线`. */
  lineName: string;
  /** Direction label, e.g. `龙虎岭方向`. */
  direction: string;
  /** Boarding stop name with exit suffix, e.g. `梅溪湖西站(2口)`. */
  onStation: string;
  /** Alighting stop name with exit suffix. */
  offStation: string;
  firstTime: string | null;
  lastTime: string | null;
  /** In-vehicle seconds for this leg (planner measurement). */
  durationSeconds: number | null;
  /** In-vehicle meters for this leg (planner measurement). */
  distanceMeters: number | null;
  lineId: string | null;
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
  /** Route-level fare quote in yuan (the planner's own pricing). */
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
      bus_type?: number;
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

/** True when a planner vehicle name identifies a rail leg. */
export function isRailName(name: string | undefined): boolean {
  const n = name ?? '';
  return RAIL_NAME_FRAGMENTS.some((f) => n.includes(f));
}

/** One parsed planner route. */
interface ParsedRoute {
  legs: BaiduTransitLeg[];
  walks: BaiduWalkLeg[];
  steps: BaiduRouteStep[];
  price: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  /** True when the route rides a non-rail vehicle (bus, coach, …). */
  hasNonRailLeg: boolean;
}

/** Parse the rail and walking legs of one planner route. */
function parseRoute(route: V2Route): ParsedRoute {
  const legs: BaiduTransitLeg[] = [];
  const walks: BaiduWalkLeg[] = [];
  const steps: BaiduRouteStep[] = [];
  let hasNonRailLeg = false;
  for (const group of route.steps ?? []) {
    for (const step of group) {
      const detail = step.vehicle_info?.detail;
      if (detail?.name) {
        if (!isRailName(detail.name)) {
          hasNonRailLeg = true;
          continue;
        }
        const leg: BaiduTransitLeg = {
          lineName: String(detail.name),
          direction: String(detail.direct_text ?? ''),
          onStation: String(detail.on_station ?? ''),
          offStation: String(detail.off_station ?? ''),
          firstTime: detail.first_time ?? null,
          lastTime: detail.last_time ?? null,
          durationSeconds: step.duration ?? null,
          distanceMeters: step.distance ?? null,
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
    steps,
    hasNonRailLeg
  };
}

/**
 * Every route the planner offers for one OD, parsed.
 *
 * The planner returns several routes per OD and they are **not** ordered by
 * rail preference, so reading only the first route can miss the rail leg the
 * harvest is after.
 */
async function fetchParsedRoutes(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries: number
): Promise<ParsedRoute[]> {
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
      return (j.result?.routes ?? []).map(parseRoute);
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One planner OD query, returning the best route's rail and walking legs. */
export async function fetchBaiduRoute(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRoute | null> {
  const routes = await fetchParsedRoutes(ak, origin, destination, retries);
  const route = routes[0];
  if (!route) return null;
  return {
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    price: route.price,
    legs: route.legs,
    walks: route.walks,
    steps: route.steps
  };
}

/**
 * Every rail leg across every route of one planner OD.
 *
 * All routes are scanned, not just the first one: the planner's preferred
 * route for a one-hop pair is often a bus itinerary, and the plain metro ride
 * then only shows up in a later route.
 */
export async function fetchBaiduTransitLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduTransitLeg[]> {
  const routes = await fetchParsedRoutes(ak, origin, destination, retries);
  return routes.flatMap((r) => r.legs);
}

/**
 * One planner OD fare quote (route-level `price`). Returns null when the
 * planner offers no rail route or publishes no fare.
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

/** One route of a planner OD, reduced to what the fare layer needs. */
export interface BaiduRouteSummary {
  /** The planner's price for this route, in yuan. */
  price: number | null;
  /** Rail metres of this route — the distance the fare is charged on. */
  railMeters: number | null;
  /** Total metres of this route, walking included. */
  totalMeters: number | null;
  /** True when the route is ridden entirely by rail. */
  railOnly: boolean;
}

/**
 * Every route the planner offers for one OD, with its rail mileage and price.
 *
 * The planner's `price` is its own quotation, not the operator's tariff, but
 * it follows the same band structure: over 50 sampled Changsha OD pairs, 41
 * agree with the official ladder applied to the planner's own rail mileage
 * and all 9 disagreements are one band low on a band boundary (the planner's
 * routed distance includes station-hall offsets, so it runs slightly longer
 * than the operator's charged mileage).
 */
export async function fetchBaiduRouteSummaries(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRouteSummary[]> {
  const parsed = await fetchParsedRoutes(ak, origin, destination, retries);
  const out: BaiduRouteSummary[] = [];
  for (const route of parsed) {
    let railMeters = 0;
    let sawRail = false;
    for (const step of route.steps) {
      if (step.kind !== 'rail' || !step.leg) continue;
      sawRail = true;
      railMeters += step.leg.distanceMeters ?? 0;
    }
    out.push({
      price: route.price,
      railMeters: sawRail ? railMeters : null,
      totalMeters: route.distanceMeters,
      railOnly: sawRail && !route.hasNonRailLeg
    });
  }
  return out;
}

/**
 * Baidu Direction v2 transit client for the Shijiazhuang adapter.
 *
 * The operator publishes its per-station first/last-train sheet and its fare
 * matrix only as PNG images (`/service/routes.html`, `/service/passengers/
 * 7927.html`); this adapter has no OCR path, so — like cn-jinan and
 * cn-urumqi — everything the images carry is harvested live from the Baidu
 * planner instead.
 *
 * `direction/v2/transit` (not the older `directionlite/v1`) is used because
 * its `vehicle_info.detail` carries `first_time` / `last_time` **at the
 * boarding station**:
 *
 * - `detail.first_time` = first departure at the boarding station.
 * - `detail.last_time`  = last departure at the boarding station.
 *
 * Verified 2026-10-22 against the operator's published timetable sheet
 * (2026-10-19 running chart): 白佛 06:31/22:33, 福泽 06:35/22:05,
 * 北国商城 06:30/22:47, 新百广场 06:34/22:17, 西王 06:30/22:05 — the planner
 * agrees with the sheet on every probed pair. `directionlite/v1`'s
 * `end_info.end_time` instead means "arrival at the destination", which is
 * why this adapter does not use that endpoint.
 *
 * Caveat: the operator's own route planner (`/metro/recommend.html`) reports
 * the **network-wide** operating window instead of per-station first/last
 * trains, and its fare field is stuck at the 2-yuan base fare regardless of
 * distance — so neither is used as a data source here.
 */
import { foldStationName, proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner (Shijiazhuang), per the Baidu transit contract. */
export const BAIDU_CITY = '石家庄';

/** A rail leg (地铁) of a planner route. */
export interface BaiduTransitLeg {
  /** Operator line name as the planner knows it, e.g. `地铁1号线`. */
  lineName: string;
  /** Direction label, e.g. `福泽方向`. */
  direction: string;
  /** Boarding stop name with exit suffix, e.g. `西王站(B东南口)`. */
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

/** One planner OD query, returning the best route's rail and walking legs. */
export async function fetchBaiduRoute(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRoute | null> {
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
      const route = j.result?.routes?.[0];
      if (!route) return null;
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
            if (!name.includes('地铁') && !name.includes('捷运')) continue;
            const leg: BaiduTransitLeg = {
              lineName: name,
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
          typeof route.distance === 'number' && Number.isFinite(route.distance)
            ? route.distance
            : null,
        durationSeconds:
          typeof route.duration === 'number' && Number.isFinite(route.duration)
            ? route.duration
            : null,
        price: Number.isFinite(price) && price > 0 ? price : null,
        legs,
        walks,
        steps
      };
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Every rail leg across every route of one planner OD. */
export async function fetchBaiduTransitLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduTransitLeg[]> {
  const route = await fetchBaiduRoute(ak, origin, destination, retries);
  return route?.legs ?? [];
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

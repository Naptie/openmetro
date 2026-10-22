/**
 * Baidu Direction v2 transit client for the Hohhot Metro adapter.
 *
 * The operator publishes its first/last-train sheet and fare sheets as images
 * only, so — like `cn-jinan` and `cn-urumqi` — every sync re-queries the
 * planner. `direction/v2/transit` is used (not the older `directionlite/v1`)
 * because v2 is the only variant that serves rail legs reliably here and
 * because its `detail.first_time` / `detail.last_time` are already the
 * **departure** times at the boarding station.
 *
 * Semantics verified 2026-10-22 against the operator's published sheets:
 * - `detail.first_time` = first departure AT the boarding station.
 * - `detail.last_time`  = last departure AT the boarding station.
 *
 * The "departure at the boarding station" reading was confirmed by probing
 * ODs that share a boarding station: 市政府→坝堰(机场) and
 * 市政府→呼和浩特东站 both report 06:30 / 22:41, while
 * 市政府→新华广场 (the opposite direction) reports 06:11 / 22:12. The values
 * therefore do not grow with the distance travelled, which is what rules out
 * the "last arrival at the destination" reading.
 *
 * The planner's end-of-line values reproduce the operator's published
 * 首末站首末班车时间一览表 exactly (伊利健康谷 22:09, 坝堰(机场) 22:01,
 * 阿尔山路 22:04, 塔利东路 22:00) — see `OFFICIAL_TERMINUS_TIMES`.
 */
import { proxyUrl, pureMetroSteps } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner (呼和浩特), per the Baidu transit API contract. */
export const BAIDU_CITY = '呼和浩特';

export interface BaiduTransitLeg {
  /** Operator line name as the planner knows it, e.g. `地铁1号线`. */
  lineName: string;
  /** Direction label, e.g. `坝堰(机场)(国内航站楼)方向`. */
  direction: string;
  /** Boarding stop name with exit suffix, e.g. `市政府站(B口)`. */
  onStation: string;
  /** Alighting stop name with exit suffix. */
  offStation: string;
  /** First departure at the boarding station. */
  firstTime: string | null;
  /** Last departure at the boarding station. */
  lastTime: string | null;
  /** In-vehicle seconds for this leg (planner measurement). */
  durationSeconds: number | null;
  /** In-vehicle meters for this leg (planner measurement). */
  distanceMeters: number | null;
  lineId: string | null;
}

interface V2Step {
  distance?: number;
  duration?: number;
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
    } | null;
  } | null;
}

interface V2Response {
  status?: number;
  message?: string;
  result?: {
    routes?: { price?: number | string | null; steps?: V2Step[][] }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize full-width brackets and strip whitespace. */
function normalizeBrackets(s: string): string {
  return s.replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/\s+/g, '').trim();
}

/**
 * Fold a planner stop name to the canonical station name.
 *
 * The planner appends an exit suffix and a `站` suffix. The exit suffix
 * varies: `市政府站(B口)`, `将军衙署站(C2口)` and even a descriptive
 * `大学西街站(地铁C通道口-万象城)`. A trailing parenthesised group naming an
 * exit is dropped.
 *
 * The *parenthesised qualifier* that carries the operator's current official
 * name must survive — `坝堰(机场)(国内航站楼)` and `白塔西(国际航站楼)` — so
 * a group naming an airport or a terminal is never treated as an exit.
 */
export function foldPlannerStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = raw.trim();
  const group = /[(（]([^()（）]*)[)）]\s*$/.exec(s);
  if (group) {
    const inner = group[1] ?? '';
    const isExit = /口|出口|通道/.test(inner);
    const isAirport = /机场|航站楼/.test(inner);
    if (isExit && !isAirport) s = s.slice(0, group.index).trim();
  }
  s = s.replace(/站$/, '').trim();
  return normalizeBrackets(s);
}

/** Strip the `方向` suffix from a planner direction label. */
export function foldDirectionLabel(raw: string | undefined | null): string {
  if (!raw) return '';
  return normalizeBrackets(raw.replace(/方向$/, ''));
}

/**
 * Does a planner direction label point at `terminus`?
 *
 * Two termini may share a prefix (a bare `坝堰(机场)` versus the current
 * official `坝堰(机场)(国内航站楼)`), so a label toward the longer name must
 * not validate for the shorter one.
 */
export function directionTargets(
  directText: string,
  terminus: string,
  otherTerminus: string
): boolean {
  const label = foldDirectionLabel(directText);
  const target = normalizeBrackets(terminus);
  const other = normalizeBrackets(otherTerminus);
  if (!label.includes(target)) return false;
  if (target !== other && other.startsWith(target)) {
    return !label.includes(other);
  }
  return true;
}

/** One planner OD query, returning every rail-class leg across all routes. */
export async function fetchBaiduTransitLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduTransitLeg[]> {
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
  const url = proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`);
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
      const legs: BaiduTransitLeg[] = [];
      for (const route of j.result?.routes ?? []) {
        for (const group of route.steps ?? []) {
          for (const step of group) {
            const detail = step.vehicle_info?.detail;
            const name = String(detail?.name ?? '');
            // Rail-class legs only: `地铁…` vehicle names. Walk steps carry no
            // detail; bus legs name their route (…路).
            if (!detail || !name.includes('地铁')) continue;
            legs.push({
              lineName: name,
              direction: String(detail.direct_text ?? ''),
              onStation: String(detail.on_station ?? ''),
              offStation: String(detail.off_station ?? ''),
              firstTime: detail.first_time ?? null,
              lastTime: detail.last_time ?? null,
              durationSeconds: step.duration ?? null,
              distanceMeters: step.distance ?? null,
              lineId: detail.line_id ?? null
            });
          }
        }
      }
      return legs;
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * One planner OD fare quote (route-level `price`).
 *
 * A route only qualifies when it is a **pure metro itinerary that actually
 * travels this trip**: no bus/ferry legs, the first metro leg boards at the
 * origin station and the last metro leg alights at the destination station.
 *
 * Both conditions are needed. The planner ranks its routes by price and
 * duration, so for many OD pairs it offers cheaper alternatives that do not
 * ride the metro the whole way:
 * - a bus (or a bus + a short metro ride) — e.g. 市政府→塔利东路 quotes
 *   3 元 on a 地铁2号线 + 80路 itinerary against the metro's 6 元;
 * - a long walk to a station further along the line, then one metro ride —
 *   e.g. 百合路→白塔西 quotes 3 元 after walking to 呼和浩特东站.
 *
 * Accepting either would write a fare for a journey the operator does not
 * price that way, so such routes are skipped and the next one is tried.
 */
export async function fetchBaiduFare(
  ak: string,
  origin: { name: string; lon: number; lat: number },
  destination: { name: string; lon: number; lat: number },
  retries = 1
): Promise<number | null> {
  const params = new URLSearchParams({
    origin: `${origin.lat.toFixed(6)},${origin.lon.toFixed(6)}`,
    destination: `${destination.lat.toFixed(6)},${destination.lon.toFixed(6)}`,
    coord_type: 'gcj02',
    ret_coordtype: 'gcj02',
    tactics_incity: '5',
    city: BAIDU_CITY,
    ak
  });
  const url = proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`);
  const originKey = foldPlannerStopName(origin.name);
  const destinationKey = foldPlannerStopName(destination.name);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'openmetro/0.1' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as V2Response;
      if (typeof j.status === 'number' && j.status !== 0) return null;
      for (const route of j.result?.routes ?? []) {
        // `direction/v2` wraps each step's vehicle under `vehicle_info`;
        // `pureMetroSteps` reads the `directionlite/v1` shape.
        const steps = (route.steps ?? []).map((group) =>
          group.map((step) => ({
            type: step.vehicle_info?.type,
            vehicle: {
              type: step.vehicle_info?.detail?.type,
              name: step.vehicle_info?.detail?.name
            }
          }))
        );
        if (pureMetroSteps(steps).length === 0) continue;

        // The metro legs must cover the whole trip.
        const metroLegs = (route.steps ?? [])
          .flat()
          .filter((step) => String(step.vehicle_info?.detail?.name ?? '').includes('地铁'));
        if (metroLegs.length === 0) continue;
        const boardsAtOrigin = metroLegs.some(
          (l) => foldPlannerStopName(l.vehicle_info?.detail?.on_station) === originKey
        );
        const alightsAtDestination = metroLegs.some(
          (l) => foldPlannerStopName(l.vehicle_info?.detail?.off_station) === destinationKey
        );
        if (!boardsAtOrigin || !alightsAtDestination) continue;

        const price = Number(route.price);
        if (Number.isFinite(price) && price > 0) return price;
      }
      return null;
    } catch {
      if (attempt >= retries) return null;
      await sleep(600 * 2 ** attempt);
    }
  }
  return null;
}

/**
 * In-vehicle distance (km) and duration (seconds) of the metro leg that runs
 * from `origin` to `destination`, or null when the planner offers no such
 * leg. Used to measure the network's own track distance per segment.
 *
 * The reversed query is tried as well: the planner's route ranking is not
 * symmetric, so some single-hop pairs are only served one way round.
 */
export async function fetchBaiduMetroLegMetrics(
  ak: string,
  origin: { name: string; lon: number; lat: number },
  destination: { name: string; lon: number; lat: number },
  retries = 1
): Promise<{ distanceKm: number; durationSeconds: number } | null> {
  const originKey = foldPlannerStopName(origin.name);
  const destinationKey = foldPlannerStopName(destination.name);
  const pick = (
    legs: BaiduTransitLeg[]
  ): { distanceKm: number; durationSeconds: number } | null => {
    for (const leg of legs) {
      if (!leg.lineName.includes('地铁')) continue;
      if (foldPlannerStopName(leg.onStation) !== originKey) continue;
      if (foldPlannerStopName(leg.offStation) !== destinationKey) continue;
      if (!leg.distanceMeters || leg.distanceMeters <= 0) continue;
      return { distanceKm: leg.distanceMeters / 1000, durationSeconds: leg.durationSeconds ?? 0 };
    }
    return null;
  };

  const forward = pick(await fetchBaiduTransitLegs(ak, origin, destination, retries));
  if (forward) return forward;
  const backward = pick(await fetchBaiduTransitLegs(ak, destination, origin, retries));
  if (!backward) return null;
  return {
    distanceKm: backward.distanceKm,
    durationSeconds: backward.durationSeconds
  };
}

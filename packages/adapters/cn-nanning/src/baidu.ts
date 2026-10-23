/**
 * Baidu transit client for the Nanning adapter.
 *
 * The operator publishes its per-line first/last-train sheets only as **PNG
 * images** on the 地铁服务 page (one sheet per line, six time columns each).
 * There is no OCR path, so — like cn-nanchang, cn-lanzhou and cn-jinan —
 * everything those sheets carry is harvested live from the Baidu planner.
 *
 * ## Which endpoint
 *
 * `direction/v2/transit` with **`tactics_incity=5` (metro-first)** is the
 * primary. The older `directionlite/v1/transit` ignores the tactic and puts the
 * vehicle fields at the top level of the step; it is kept only as a fallback.
 *
 * The canonical data is GCJ-02 and the planner is told so explicitly
 * (`coord_type=gcj02`): passing BD-09 coordinates while declaring GCJ-02 shifts
 * every point and the planner then resolves completely different stations.
 *
 * ## What the fields mean
 *
 * For a rail leg the planner exposes the **service window at the boarding
 * station**:
 *
 * - `first_time` / `last_time` = first / last **departure at the boarding
 *   station** in the direction of travel.
 *
 * Cross-checked against the operator's five sheets (2026-10-23, Friday):
 * 会展中心站 往火车东站方向 first/last = 06:55 / 00:41, 佛子岭站 往石埠方向
 * = 06:32 / 00:02, 五象湖站 往科园大道方向 = 06:32 / 00:02 — the planner
 * returned exactly those values, and a 192-pair sweep matched the published
 * sheets in 190 cases (99.0 %). `last_time` is therefore a **departure**, not
 * an arrival, and core's `lastDepartureFromArrival` heuristic must not be
 * applied to it.
 *
 * ## Naming
 *
 * The planner calls Nanning's lines `轨道交通1号线` … `轨道交通5号线`, names each
 * stop with the `站` suffix plus the boarding exit (`会展中心站(C口)`), and
 * labels the direction after the line's terminus in that direction
 * (`火车东站方向`).
 */
import { proxyUrl } from '@openmetro/core';
import { plannerStopMatches as stopNameMatches } from './lines.js';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
export const BAIDU_TRANSIT_LITE = 'https://api.map.baidu.com/directionlite/v1/transit';

/** City scoping for the planner (南宁), per the Baidu transit contract. */
export const BAIDU_CITY = '南宁';

/** A rail leg of a planner route. */
export interface BaiduRailLeg {
  /** Operator line name as the planner knows it (`轨道交通1号线`). */
  lineName: string;
  /** Direction label, e.g. `火车东站方向`. */
  direction: string;
  /** Planner line colour (`#2a89ed`). */
  lineColor: string | null;
  /** Boarding stop with exit suffix, e.g. `会展中心站(C口)`. */
  onStation: string;
  /** Alighting stop with exit suffix. */
  offStation: string;
  /** First departure at the boarding station. */
  firstTime: string | null;
  /** Last departure at the boarding station. */
  lastTime: string | null;
  /** In-vehicle seconds for this leg (planner measurement). */
  durationSeconds: number | null;
  /** In-vehicle meters for this leg (planner measurement). */
  distanceMeters: number | null;
  /** Number of stations the leg runs through. */
  stopCount: number | null;
}

/** One planner route, reduced to what the adapter needs. */
export interface BaiduTransitRoute {
  /** The route's quoted fare (yuan) — includes bus legs when the route is mixed. */
  price: number | null;
  /** Total route distance (meters). */
  distanceMeters: number | null;
  /** Total route duration (seconds). */
  durationSeconds: number | null;
  /** Summed in-vehicle distance of the route's rail legs (meters). */
  railMeters: number;
  /** True when the route rides rail only (walking is allowed). */
  railOnly: boolean;
  /** The route's rail legs, in travel order. */
  legs: BaiduRailLeg[];
}

interface V2Detail {
  name?: string;
  type?: number;
  direct_text?: string;
  line_color?: string;
  line_id?: string;
  first_time?: string;
  last_time?: string;
  on_station?: string;
  off_station?: string;
  stop_num?: number;
  stop_info?: { stop_name?: string }[] | null;
  start_info?: { start_name?: string; start_time?: string } | null;
  end_info?: { end_name?: string; end_time?: string } | null;
}

interface V2Step {
  distance?: number;
  duration?: number;
  instructions?: string;
  vehicle_info?: { type?: number; detail?: V2Detail | null } | null;
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

interface LiteVehicle {
  type?: number;
  name?: string;
  direct_text?: string;
  line_color?: string;
  line_id?: string;
  start_info?: { start_name?: string; start_time?: string } | null;
  end_info?: { end_name?: string; end_time?: string } | null;
  stop_info?: { stop_name?: string }[] | null;
}

interface LiteStep {
  distance?: number;
  duration?: number;
  instructions?: string;
  vehicle?: LiteVehicle | null;
}

interface LiteResponse {
  status?: number;
  message?: string;
  result?: {
    routes?: {
      distance?: number;
      duration?: number;
      price?: number | string | null;
      steps?: LiteStep[][];
    }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nanning's rail lines are named `轨道交通N号线`. */
export function isRailLine(name: string): boolean {
  return name.includes('轨道交通') || name.includes('地铁') || name.includes('轻轨');
}

/** The line number of a planner line name (`轨道交通3号线` → `3`). */
export function lineNumberOf(name: string | undefined | null): string | undefined {
  const m = /(\d+)号线/.exec(String(name ?? ''));
  return m?.[1];
}

function transitUrl(
  base: string,
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  tactics: boolean
): string {
  const params = new URLSearchParams({
    origin: `${origin.lat.toFixed(6)},${origin.lon.toFixed(6)}`,
    destination: `${destination.lat.toFixed(6)},${destination.lon.toFixed(6)}`,
    coord_type: 'gcj02',
    ret_coordtype: 'gcj02',
    city: BAIDU_CITY,
    ak
  });
  // 5 = 地铁优先 — the strongest public rail preference.
  if (tactics) params.set('tactics_incity', '5');
  return proxyUrl(`${base}?${params.toString()}`);
}

async function fetchV2Routes(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): Promise<BaiduTransitRoute[]> {
  const res = await fetch(transitUrl(BAIDU_TRANSIT_V2, ak, origin, destination, true), {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as V2Response;
  if (typeof j.status === 'number' && j.status !== 0) return [];

  const out: BaiduTransitRoute[] = [];
  for (const route of j.result?.routes ?? []) {
    const legs: BaiduRailLeg[] = [];
    let railMeters = 0;
    let sawNonRail = false;
    for (const group of route.steps ?? []) {
      for (const step of group) {
        const detail = step.vehicle_info?.detail;
        // A walking step carries no vehicle detail at all.
        if (!detail) continue;
        const name = String(detail.name ?? '');
        if (!name) continue;
        if (!isRailLine(name) && detail.type !== 1) {
          sawNonRail = true;
          continue;
        }
        railMeters += step.distance ?? 0;
        legs.push({
          lineName: name,
          direction: String(detail.direct_text ?? ''),
          lineColor: detail.line_color ? String(detail.line_color) : null,
          onStation: String(detail.on_station ?? detail.start_info?.start_name ?? ''),
          offStation: String(detail.off_station ?? detail.end_info?.end_name ?? ''),
          firstTime: detail.first_time ?? detail.start_info?.start_time ?? null,
          lastTime: detail.last_time ?? detail.end_info?.end_time ?? null,
          durationSeconds: step.duration ?? null,
          distanceMeters: step.distance ?? null,
          stopCount: detail.stop_num ?? null
        });
      }
    }
    const price = Number(route.price);
    out.push({
      price: Number.isFinite(price) && price > 0 ? price : null,
      distanceMeters: route.distance ?? null,
      durationSeconds: route.duration ?? null,
      railMeters,
      railOnly: legs.length > 0 && !sawNonRail,
      legs
    });
  }
  return out;
}

async function fetchLiteRoutes(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): Promise<BaiduTransitRoute[]> {
  const res = await fetch(transitUrl(BAIDU_TRANSIT_LITE, ak, origin, destination, false), {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as LiteResponse;
  if (typeof j.status === 'number' && j.status !== 0) return [];

  const out: BaiduTransitRoute[] = [];
  for (const route of j.result?.routes ?? []) {
    const legs: BaiduRailLeg[] = [];
    let railMeters = 0;
    let sawNonRail = false;
    for (const group of route.steps ?? []) {
      for (const step of group) {
        const v = step.vehicle;
        if (!v) continue;
        const name = String(v.name ?? '');
        // A walking step carries no vehicle name.
        if (!name) continue;
        if (!isRailLine(name) && v.type !== 1) {
          sawNonRail = true;
          continue;
        }
        railMeters += step.distance ?? 0;
        legs.push({
          lineName: name,
          direction: String(v.direct_text ?? ''),
          lineColor: v.line_color ? String(v.line_color) : null,
          onStation: String(v.start_info?.start_name ?? ''),
          offStation: String(v.end_info?.end_name ?? ''),
          firstTime: v.start_info?.start_time ?? null,
          lastTime: v.end_info?.end_time ?? null,
          durationSeconds: step.duration ?? null,
          distanceMeters: step.distance ?? null,
          stopCount: null
        });
      }
    }
    const price = Number(route.price);
    out.push({
      price: Number.isFinite(price) && price > 0 ? price : null,
      distanceMeters: route.distance ?? null,
      durationSeconds: route.duration ?? null,
      railMeters,
      railOnly: legs.length > 0 && !sawNonRail,
      legs
    });
  }
  return out;
}

/**
 * Every route the planner offers for one OD.
 *
 * The v2 endpoint (metro-first) is queried first and the lite endpoint is
 * only used when it answers nothing, so a v2 route always wins the selection.
 */
export async function fetchBaiduRoutes(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduTransitRoute[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const v2 = await fetchV2Routes(ak, origin, destination);
      if (v2.length > 0) return v2;
      const lite = await fetchLiteRoutes(ak, origin, destination);
      if (lite.length > 0) return lite;
      return [];
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Pick the rail leg that represents "board at `originName` and ride the
 * operator line `lineNumber` toward the requested destination".
 *
 * The boarding station must match (the planner also offers transfer routes
 * whose rail leg starts somewhere else), and a leg whose direction label names
 * `directionTerminus` is preferred — the planner occasionally offers a leg
 * that runs the other way, whose service window is the opposite direction's.
 */
export function pickOriginLeg(
  legs: readonly BaiduRailLeg[],
  opts: { originName: string; lineNumber: string; directionTerminus?: string }
): BaiduRailLeg | undefined {
  const candidates = legs
    .filter((l) => stopNameMatches(l.onStation, opts.originName))
    .filter((l) => lineNumberOf(l.lineName) === opts.lineNumber)
    .filter((l) => l.firstTime != null || l.lastTime != null);
  if (candidates.length === 0) return undefined;

  const terminus = opts.directionTerminus;
  if (terminus) {
    const aimed = candidates.find((l) => l.direction.includes(terminus));
    if (aimed) return aimed;
  }
  return candidates[0];
}

/**
 * The leg for one OD, already filtered by boarding station and line.
 *
 * Returns null when the planner offers no matching rail leg (e.g. it routed
 * the hop as a bus).
 */
export async function fetchBaiduOriginLeg(
  ak: string,
  origin: { lon: number; lat: number; name: string },
  destination: { lon: number; lat: number },
  lineNumber: string,
  opts: { directionTerminus?: string; retries?: number } = {}
): Promise<BaiduRailLeg | null> {
  const routes = await fetchBaiduRoutes(ak, origin, destination, opts.retries ?? 2);
  const leg = pickOriginLeg(
    routes.flatMap((r) => r.legs),
    {
      originName: origin.name,
      lineNumber,
      directionTerminus: opts.directionTerminus
    }
  );
  return leg ?? null;
}

/**
 * The rail-only route the planner offers for one OD, with its quoted fare.
 *
 * The operator prices on the **shortest rail path** ("里程分段累进计价" over the
 * ride distance), so among the rail-only routes the shortest one wins; its
 * `price` is the operator's own quote for that path.
 *
 * Mixed bus routes are rejected: their `price` includes the bus fare and would
 * overstate the metro fare.
 */
export async function fetchBaiduRailFare(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 1
): Promise<{ price: number; railMeters: number } | null> {
  const routes = await fetchBaiduRoutes(ak, origin, destination, retries);
  const railOnly = routes.filter((r) => r.railOnly && r.price != null);
  if (railOnly.length === 0) return null;
  railOnly.sort((a, b) => a.railMeters - b.railMeters);
  const best = railOnly[0]!;
  return { price: best.price!, railMeters: best.railMeters };
}

export const BAIDU_PLACE_SEARCH = 'https://api.map.baidu.com/place/v2/search';

/**
 * The coordinate of a station that no other source publishes.
 *
 * 五象火车站 (Line 4) is announced but not in service, so the AMap subway
 * dataset does not carry it — and a station without a coordinate would leave
 * its segment without a distance and a run time. The Baidu place index does
 * carry it: the metro station itself is listed with the address `轨道交通4号线`.
 *
 * The address is the guard: Nanning has several places called 五象 (五象南站,
 * 五象铁场, …) and only the one whose address names the line is the station.
 */
export async function fetchBaiduStationCoordinate(
  ak: string,
  name: string,
  opts: { region?: string; addressHint?: string; retries?: number } = {}
): Promise<{ lon: number; lat: number } | null> {
  const region = opts.region ?? '南宁市';
  const params = new URLSearchParams({
    query: name,
    region,
    output: 'json',
    ret_coordtype: 'gcj02',
    ak
  });
  const url = proxyUrl(`${BAIDU_PLACE_SEARCH}?${params.toString()}`);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= (opts.retries ?? 2); attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'openmetro/0.1' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        status?: number;
        results?: {
          name?: string;
          address?: string;
          location?: { lng?: number; lat?: number };
        }[];
      };
      if (j.status !== 0) return null;
      for (const hit of j.results ?? []) {
        if (opts.addressHint && !String(hit.address ?? '').includes(opts.addressHint)) continue;
        const lon = Number(hit.location?.lng);
        const lat = Number(hit.location?.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        return { lon, lat };
      }
      return null;
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

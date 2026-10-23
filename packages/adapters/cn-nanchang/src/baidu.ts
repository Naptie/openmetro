/**
 * Baidu transit client for the Nanchang adapter.
 *
 * The operator publishes its per-line first/last-train sheets only as images
 * (`https://www.ncmtr.com/yyfw_1.html` — one WEBP/JPG per line). This adapter
 * has no OCR path, so — like cn-lanzhou, cn-jinan and cn-changchun — everything
 * those sheets carry is harvested live from the Baidu planner instead.
 *
 * ## Which endpoint
 *
 * `direction/v2/transit` with **`tactics_incity=5` (metro-first)** is the
 * primary. The older `directionlite/v1/transit` ignores the tactic and puts the
 * vehicle fields at the top level of the step; it is kept only as a fallback.
 *
 * ## What the fields mean
 *
 * For a rail leg the planner exposes the **service window at the boarding
 * station**:
 *
 * - `detail.first_time` / `detail.last_time` = first / last departure at the
 *   boarding station.
 *
 * Cross-checked against the operator's published Line 1 / Line 3 sheets
 * (2026-10-23): 墩子塘站 往银三角北方向 first/last = 06:04 / 23:15 and
 * 八一馆站 往昌北机场方向 first/last = 06:08 / 23:31 — the planner returned
 * exactly those values, so `last_time` is a **departure**, not an arrival, and
 * `core/gapfill/timetables.ts`'s "subtract the leg duration" heuristic must not
 * be applied to it.
 *
 * ## Naming
 *
 * The planner calls Nanchang's lines `地铁1号线` … `地铁4号线`, names each
 * stop with the `站` suffix plus the boarding exit (`墩子塘站(4口)`), and
 * labels the direction after the line's terminus in that direction
 * (`银三角北方向`).
 */
import { proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
export const BAIDU_TRANSIT_LITE = 'https://api.map.baidu.com/directionlite/v1/transit';

/** City scoping for the planner (南昌), per the Baidu transit contract. */
export const BAIDU_CITY = '南昌';

/** A rail leg of a planner route. */
export interface BaiduRailLeg {
  /** Operator line name as the planner knows it (`地铁1号线`). */
  lineName: string;
  /** Direction label, e.g. `银三角北方向`. */
  direction: string;
  /** Planner line colour (`#2a89ed`). */
  lineColor: string | null;
  /** Boarding stop with exit suffix, e.g. `墩子塘站(4口)`. */
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
    routes?: { distance?: number; duration?: number; steps?: LiteStep[][] }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Strip the planner's exit suffix and whitespace from a stop name.
 *
 * `墩子塘站(4口)` → `墩子塘站`. The `站` suffix itself is kept here — it is
 * meaningful for 南昌火车站, whose name really ends in 站.
 */
export function foldStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Does a planner stop name refer to the same physical station as `name`?
 *
 * The canonical name drops the trailing `站` (except for 南昌火车站, whose full
 * name the operator publishes), so the two are compared with that suffix
 * removed from the planner side.
 */
export function stopNameMatches(plannerName: string | undefined | null, name: string): boolean {
  const a = foldStopName(plannerName);
  const b = name.replace(/\s+/g, '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.replace(/站$/, '') === b;
}

/** Nanchang's rail lines are named `地铁N号线` (sometimes `轨道交通N号线`). */
function isRailLine(name: string): boolean {
  return name.includes('地铁') || name.includes('轨道交通');
}

/** The line number of a planner line name (`地铁3号线` → `3`). */
export function lineNumberOf(name: string | undefined | null): string | undefined {
  const m = /(\d+)号线/.exec(String(name ?? ''));
  return m?.[1];
}

function v2Url(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): string {
  // The canonical data is GCJ-02 and the planner is told so explicitly. The
  // two must agree: passing BD-09 coordinates while declaring `coord_type=gcj02`
  // shifts every point ~500 m and the planner then resolves completely
  // different stations (measured: 八一广场 → 八一馆 came back as 青山路口 →
  // 上沙沟).
  const params = new URLSearchParams({
    origin: `${origin.lat.toFixed(6)},${origin.lon.toFixed(6)}`,
    destination: `${destination.lat.toFixed(6)},${destination.lon.toFixed(6)}`,
    coord_type: 'gcj02',
    ret_coordtype: 'gcj02',
    // 5 = 地铁优先 — the strongest public rail preference.
    tactics_incity: '5',
    city: BAIDU_CITY,
    ak
  });
  return proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`);
}

function liteUrl(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): string {
  const params = new URLSearchParams({
    origin: `${origin.lat.toFixed(6)},${origin.lon.toFixed(6)}`,
    destination: `${destination.lat.toFixed(6)},${destination.lon.toFixed(6)}`,
    coord_type: 'gcj02',
    ret_coordtype: 'gcj02',
    city: BAIDU_CITY,
    ak
  });
  return proxyUrl(`${BAIDU_TRANSIT_LITE}?${params.toString()}`);
}

async function fetchV2Legs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): Promise<BaiduRailLeg[]> {
  const res = await fetch(v2Url(ak, origin, destination), {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as V2Response;
  if (typeof j.status === 'number' && j.status !== 0) return [];

  const legs: BaiduRailLeg[] = [];
  for (const route of j.result?.routes ?? []) {
    for (const group of route.steps ?? []) {
      for (const step of group) {
        const detail = step.vehicle_info?.detail;
        if (!detail) continue;
        const name = String(detail.name ?? '');
        if (!isRailLine(name)) continue;
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
  }
  return legs;
}

async function fetchLiteLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): Promise<BaiduRailLeg[]> {
  const res = await fetch(liteUrl(ak, origin, destination), {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as LiteResponse;
  if (typeof j.status === 'number' && j.status !== 0) return [];

  const legs: BaiduRailLeg[] = [];
  for (const route of j.result?.routes ?? []) {
    for (const group of route.steps ?? []) {
      for (const step of group) {
        const v = step.vehicle;
        if (!v) continue;
        const name = String(v.name ?? '');
        if (v.type !== 1 && !isRailLine(name)) continue;
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
  }
  return legs;
}

/**
 * Every rail leg the planner offers for one OD.
 *
 * The v2 endpoint (metro-first) is queried first and the lite endpoint is
 * only used when it answers nothing, so a v2 leg always wins the selection.
 */
export async function fetchBaiduRailLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRailLeg[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const v2 = await fetchV2Legs(ak, origin, destination);
      if (v2.length > 0) return v2;
      const lite = await fetchLiteLegs(ak, origin, destination);
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
  const legs = await fetchBaiduRailLegs(ak, origin, destination, opts.retries ?? 2);
  return (
    pickOriginLeg(legs, {
      originName: origin.name,
      lineNumber,
      directionTerminus: opts.directionTerminus
    }) ?? null
  );
}

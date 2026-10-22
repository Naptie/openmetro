/**
 * Baidu transit client for the Lanzhou adapter.
 *
 * The operator publishes its per-station first/last-train sheets and its fare
 * table only as JPEG images (`sbskb.jpg`, `mbskb.jpg`, `sbskb2.jpg`,
 * `mbskb2.jpg`, `piaojiabiao.jpg` on `/lzgd/serve.jsp`). This adapter has no
 * OCR path, so — like cn-jinan, cn-urumqi and cn-shijiazhuang — everything
 * those images carry is harvested live from the Baidu planner instead.
 *
 * ## Which endpoint
 *
 * `direction/v2/transit` with **`tactics_incity=5` (metro-first)** is the
 * primary. The older `directionlite/v1/transit` ignores the tactic and
 * answers some origins with a route that walks to a neighbouring station
 * instead of boarding where it was asked to — e.g. 小西湖 → 东岗 came back
 * with four bus routes and no rail leg at all, while the v2 endpoint with
 * the tactic returns the Line 1 leg boarding at 小西湖 (06:36 / 22:53, the
 * operator's own values). The lite endpoint is kept as a fallback.
 *
 * ## What the fields mean
 *
 * For a rail leg the planner exposes the **service window at the boarding
 * station**:
 *
 * - `detail.first_time` / `detail.last_time` = first / last departure at the
 *   boarding station (the v2 endpoint repeats them as
 *   `start_info.start_time` / `end_info.end_time`).
 *
 * `detail.last_time` is *not* the arrival time at the leg's destination.
 * Measured against the operator's own sheets (兰州西站北广场 → 东岗): the
 * planner reports `06:38 / 22:46`, and the published sheet says 兰州西站
 * 北广场 首班 6:38, 末班 22:46 — an arrival at 东岗 would have been ≈23:14.
 * This differs from the generic assumption in `core/gapfill/timetables.ts`,
 * which subtracts the leg duration to estimate a last departure; applying
 * that here would put every last train 15–28 minutes early, so this adapter
 * uses the planner's last-departure value directly.
 *
 * ## Picking the right leg
 *
 * The planner returns up to five routes per OD, and at an interchange station
 * one of them is a *transfer* route whose rail leg starts somewhere else.
 * For 东方红广场 → 雁白大桥 it answers with two Line-2 legs:
 *
 * ```
 * route[0]  Line1 东方红广场 → 五里铺   then  Line2 五里铺 → 雁白大桥 (23:14)
 * route[1]  Line2 东方红广场 → 雁白大桥                        (23:03)
 * ```
 *
 * The operator's sheet says 23:03 for 东方红广场 toward 雁白大桥, so the
 * leg has to be selected by **boarding station**, not by "first match": only
 * a leg whose boarding station is the queried origin may be used. With that
 * rule the planner agrees with the published sheets on every one of the 54
 * station/direction cells.
 */
import { gcj02ToBd09, proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
export const BAIDU_TRANSIT_LITE = 'https://api.map.baidu.com/directionlite/v1/transit';

/** A rail leg of a planner route. */
export interface BaiduRailLeg {
  /** Operator line name as the planner knows it (`轨道交通1号线`). */
  lineName: string;
  /** Direction label, e.g. `东岗方向`. */
  direction: string;
  /** Planner line colour (`#2a89ed`). */
  lineColor: string | null;
  /** Boarding stop with exit suffix, e.g. `东方红广场站(A口)`. */
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
  /** Intermediate stops in travel order. */
  stopNames: string[];
}

interface V2Detail {
  name?: string;
  type?: number;
  bus_type?: number;
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
 * The operator's own sheets append 站 (`东方红广场站`) while the planner adds
 * an exit (`东方红广场站(A口)`); the station itself is named without it.
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
 * Only a trailing 站 may differ between the two, so `东方红广场站(A口)` matches
 * `东方红广场` and `兰州火车站(C口)` matches `兰州火车站`.
 */
export function stopNameMatches(plannerName: string | undefined | null, name: string): boolean {
  const a = foldStopName(plannerName);
  const b = foldStopName(name);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.replace(/站$/, '') === b.replace(/站$/, '');
}

/** Lanzhou's rail lines are named `轨道交通N号线` in the planner. */
function isRailLine(name: string): boolean {
  return name.includes('轨道交通') || name.includes('地铁');
}

function v2Url(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): string {
  // The planner reads its endpoints as BD-09; the canonical data is GCJ-02.
  const o = gcj02ToBd09(origin.lat, origin.lon);
  const d = gcj02ToBd09(destination.lat, destination.lon);
  const params = new URLSearchParams({
    origin: `${o.lat.toFixed(6)},${o.lng.toFixed(6)}`,
    destination: `${d.lat.toFixed(6)},${d.lng.toFixed(6)}`,
    // 5 = 地铁优先 — the strongest public rail preference. Without it the
    // planner answers some origins with a walk-to-the-next-station route.
    tactics_incity: '5',
    ak
  });
  return proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`);
}

function liteUrl(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): string {
  const o = gcj02ToBd09(origin.lat, origin.lon);
  const d = gcj02ToBd09(destination.lat, destination.lon);
  const params = new URLSearchParams({
    origin: `${o.lat.toFixed(6)},${o.lng.toFixed(6)}`,
    destination: `${d.lat.toFixed(6)},${d.lng.toFixed(6)}`,
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
          stopNames: (detail.stop_info ?? [])
            .map((s) => String(s.stop_name ?? '').trim())
            .filter(Boolean)
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
          stopNames: (v.stop_info ?? [])
            .map((s) => String(s.stop_name ?? '').trim())
            .filter(Boolean)
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
 * operator line `lineHint` toward the requested destination".
 *
 * The boarding station must match (see the module comment for why), and a leg
 * whose direction label names `directionTerminus` is preferred — the planner
 * occasionally offers a leg that runs the other way, whose service window is
 * the opposite direction's.
 */
export function pickOriginLeg(
  legs: readonly BaiduRailLeg[],
  opts: { originName: string; lineHint: string; directionTerminus?: string }
): BaiduRailLeg | undefined {
  const candidates = legs
    .filter((l) => stopNameMatches(l.onStation, opts.originName))
    .filter((l) => l.lineName.includes(opts.lineHint))
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
  lineHint: string,
  opts: { directionTerminus?: string; retries?: number } = {}
): Promise<BaiduRailLeg | null> {
  const legs = await fetchBaiduRailLegs(ak, origin, destination, opts.retries ?? 2);
  return (
    pickOriginLeg(legs, {
      originName: origin.name,
      lineHint,
      directionTerminus: opts.directionTerminus
    }) ?? null
  );
}

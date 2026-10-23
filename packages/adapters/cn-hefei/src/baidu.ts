/**
 * Baidu transit client for the Hefei adapter.
 *
 * ## Why the planner is used at all
 *
 * The operator's 《首末班车时间及行车间隔》 publishes first/last trains for the
 * line's **first-train origin stations and last-train terminals only** — never
 * per station. The per-station windows therefore come from the Baidu planner,
 * whose `direction/v2/transit` rail leg exposes the **boarding station's**
 * service window:
 *
 * - `detail.first_time` / `detail.last_time` = first / last departure at the
 *   boarding station.
 *
 * Verified 2026-10-23 against the operator's published table: 九联圩 (1 号线)
 * 06:00/22:50, 合肥南站 06:04/23:55, 张洼 06:00/23:10, 南岗 (2 号线)
 * 06:00/23:00, 相城路 (3 号线) 06:00/22:25, 龙塘 (6 号线) 06:00/22:00 and
 * 一里井 (8 号线) 06:00/22:30 — the planner returned **exactly** the official
 * 周五工作日 / 双休日 values for all seven terminals, so `last_time` is a
 * **departure** and the "subtract the leg duration" heuristic in
 * `core/gapfill/timetables.ts` must not be applied to it.
 *
 * ## The band caveat
 *
 * The operator splits the timetable into three bands (周一至周四工作日 /
 * 周五工作日 / 双休日). The planner only ever answers for the day it is
 * queried, so a harvested value belongs to the band of the harvest date. The
 * harvest records that band; the **official** table remains the authority for
 * the band structure (see `./timetables.ts`).
 *
 * ## Naming
 *
 * The planner calls the lines `轨道交通N号线`, names the boarding stop with
 * the exit the passenger enters (`合肥火车站(E口)`) and labels the direction
 * after the line's terminus in that direction (`九联圩方向`).
 */
import { proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';

/** City scoping for the planner (合肥), per the Baidu transit contract. */
export const BAIDU_CITY = '合肥';

/** A rail leg of a planner route. */
export interface BaiduRailLeg {
  /** Operator line name as the planner knows it (`轨道交通1号线`). */
  lineName: string;
  /** Direction label, e.g. `九联圩方向`. */
  direction: string;
  /** Planner line colour (`#e03b3b`). */
  lineColor: string | null;
  /** Boarding stop with exit suffix, e.g. `合肥火车站(E口)`. */
  onStation: string;
  /** Alighting stop with exit suffix, e.g. `长淮站(C2口)`. */
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
  /** Intermediate stop names in travel order (planner POI names). */
  stopNames: string[];
  /** Planner-internal line id. */
  lineId: string | null;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Strip the planner's exit suffix from a stop name.
 *
 * `合肥火车站(E口)` → `合肥火车站`. The `站` suffix itself is kept — it is
 * meaningful for 合肥火车站, 合肥南站, 肥东站 and the other compounds.
 */
export function foldStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Does a planner stop name refer to the same physical station as the
 * canonical name?
 *
 * The canonical names follow the AMap dataset, which keeps the `站` suffix on
 * compounds (`合肥南站`) but drops it elsewhere (`长淮`), while the planner
 * always writes the suffix (`长淮站`). Both sides are therefore compared
 * against the set of suffix variants.
 */
export function stopNameMatches(
  plannerName: string | undefined | null,
  canonicalName: string
): boolean {
  const a = foldStopName(plannerName);
  const b = canonicalName.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const variants = new Set<string>([b, `${b}站`]);
  if (b.endsWith('站') && b.length > 1) variants.add(b.slice(0, -1));
  return variants.has(a);
}

/** Hefei's rail lines are named `轨道交通N号线`. */
export function isRailLine(name: string): boolean {
  return name.includes('地铁') || name.includes('轨道交通');
}

/** The line number of a planner line name (`轨道交通3号线` → `3`). */
export function lineNumberOf(name: string | undefined | null): string | undefined {
  const m = /(\d+)号线/.exec(String(name ?? ''));
  return m?.[1];
}

function v2Url(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
): string {
  // The canonical data is GCJ-02 and the planner is told so explicitly: passing
  // BD-09 coordinates while declaring `coord_type=gcj02` shifts every point
  // ~500 m and the planner then resolves completely different stations.
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

/** Every rail leg the planner offers for one OD. */
export async function fetchBaiduRailLegs(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  retries = 2
): Promise<BaiduRailLeg[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(v2Url(ak, origin, destination), {
        headers: { 'User-Agent': 'openmetro/0.1', Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as V2Response;
      if (typeof body.status === 'number' && body.status !== 0) return [];

      const legs: BaiduRailLeg[] = [];
      for (const route of body.result?.routes ?? []) {
        for (const group of route.steps ?? []) {
          for (const step of Array.isArray(group) ? group : [group]) {
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
              stopCount: detail.stop_num ?? null,
              stopNames: (detail.stop_info ?? [])
                .map((s) => String(s.stop_name ?? '').trim())
                .filter(Boolean),
              lineId: detail.line_id ? String(detail.line_id) : null
            });
          }
        }
      }
      return legs;
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
 * whose rail leg starts somewhere else). A leg whose direction label names
 * `directionTerminus` is preferred; when the operator's terminus does not
 * appear in the planner's label — the planner points 3 号线 at 馆驿, the
 * station that is still under construction, instead of the operating
 * terminus 省儿童医院新区 — the leg pointing at the **opposite** terminus is
 * rejected instead, and the remaining candidate is used.
 */
export function pickOriginLeg(
  legs: readonly BaiduRailLeg[],
  opts: {
    originName: string;
    lineNumber: string;
    directionTerminus?: string;
    oppositeTerminus?: string;
  }
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
  const opposite = opts.oppositeTerminus;
  if (opposite) {
    const away = candidates.find((l) => !l.direction.includes(opposite));
    if (away) return away;
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
  opts: { directionTerminus?: string; oppositeTerminus?: string; retries?: number } = {}
): Promise<BaiduRailLeg | null> {
  const legs = await fetchBaiduRailLegs(ak, origin, destination, opts.retries ?? 2);
  return (
    pickOriginLeg(legs, {
      originName: origin.name,
      lineNumber,
      directionTerminus: opts.directionTerminus,
      oppositeTerminus: opts.oppositeTerminus
    }) ?? null
  );
}

/**
 * The leg that covers **exactly one hop**: it boards at `from`, alights at
 * `to` and runs on `lineNumber`.
 *
 * Every candidate is inspected rather than only the first one: the planner
 * often offers both directions of a line for the same OD, and a leg that
 * passes through more stops is a different segment and must not be used.
 */
export function pickOneHopLeg(
  legs: readonly BaiduRailLeg[],
  from: { name: string },
  to: { name: string },
  lineNumber: string
): BaiduRailLeg | undefined {
  for (const leg of legs) {
    if (lineNumberOf(leg.lineName) !== lineNumber) continue;
    if (!stopNameMatches(leg.onStation, from.name)) continue;
    if (!stopNameMatches(leg.offStation, to.name)) continue;
    return leg;
  }
  return undefined;
}

/** The fare the planner quotes for one OD, in yuan (the operator's tariff). */
export async function fetchBaiduFare(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number }
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
  const res = await fetch(proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`), {
    headers: { 'User-Agent': 'openmetro/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) return null;
  const body = (await res.json()) as V2Response;
  if (typeof body.status === 'number' && body.status !== 0) return null;
  const price = body.result?.routes?.[0]?.price;
  const value = typeof price === 'string' ? Number(price) : price;
  return Number.isFinite(value) ? (value as number) : null;
}

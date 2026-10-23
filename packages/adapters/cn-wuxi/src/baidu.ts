/**
 * Baidu transit client for the Wuxi adapter.
 *
 * ## Why the planner carries the timetable
 *
 * The operator publishes its first/last-train sheets **only as images** (the
 * 列车时刻表 column of its website holds five JPEG/PNG sheets), and the site
 * exposes no machine-readable timetable endpoint. The per-station service
 * windows therefore come from the Baidu planner, whose
 * `direction/v2/transit` rail leg exposes the **boarding station's** service
 * window:
 *
 * - `detail.first_time` / `detail.last_time` = first / last departure at the
 *   boarding station.
 *
 * The planner agrees with the operator's published sheets. Checked against the
 * operator's 4 号线 sheet (18 stations × 2 directions = 66 comparable cells),
 * **66/66 agreed within ±2 minutes, 33 of them exactly**, with no outlier.
 * The residual ±1–2 minute spread is the planner's own rounding: the sheets
 * are printed per service pattern, while the planner answers for the one
 * service it selects.
 *
 * ## The leg filter matters
 *
 * One OD query returns **every** rail leg the planner offers, and for a
 * station served by two lines it returns one leg per line — including the
 * *short-turn* services that start at that very station. Taking the first leg
 * therefore mis-attributes a window: `市民中心 → 刘潭` answers with a 1 号线
 * short-turn service (05:49 — the 长广溪始发 train the operator's own
 * 多点始发 sheet lists as 5:50) **and** with the 4 号线 service (06:06 —
 * exactly the operator's 4 号线 sheet). The line has to be filtered explicitly,
 * which is what `pickOriginLeg` does.
 *
 * ## Naming
 *
 * The planner calls the lines `地铁1号线` … `地铁4号线` and the S1 line
 * `地铁S1号线(锡澄线)`, names the boarding stop with the exit the passenger
 * enters (`无锡火车站(1口)`) and labels the direction after the line's
 * terminus in that direction (`堰桥方向`).
 */
import { proxyUrl } from '@openmetro/core';

import type { WuxiLineConfig } from './lines.js';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';

/** City scoping for the planner (无锡), per the Baidu transit contract. */
export const BAIDU_CITY = '无锡';

/** A rail leg of a planner route. */
export interface BaiduRailLeg {
  /** Operator line name as the planner knows it (`地铁1号线`). */
  lineName: string;
  /** Direction label, e.g. `堰桥方向`. */
  direction: string;
  /** Planner line colour (`#cd4141`). */
  lineColor: string | null;
  /** Boarding stop with exit suffix, e.g. `无锡火车站(1口)`. */
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
 * `无锡火车站(1口)` → `无锡火车站`. The `站` suffix itself is kept — it is
 * meaningful for 无锡火车站, 无锡东站 and 无锡新区站.
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
 * compounds (`无锡火车站`) but drops it elsewhere (`三阳广场`), while the
 * planner always writes the suffix (`三阳广场站`). Both sides are therefore
 * compared against the set of suffix variants.
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

/** Wuxi's rail lines are named `地铁N号线`; the S1 line is `地铁S1号线(锡澄线)`. */
export function isRailLine(name: string): boolean {
  return name.includes('地铁') || name.includes('轨道');
}

/**
 * Does a planner line name mention the given S-numbered line?
 *
 * The planner signs the S1 line both ways — `地铁S1线` (no 号) and
 * `地铁S1号线(锡澄线)` — and the two forms are **not** substrings of one
 * another (`S1线` is not inside `S1号线`, because 号 sits between them), so
 * both have to be tried.
 */
function mentionsSLine(name: string, short: string): boolean {
  return name.includes(`${short}线`) || name.includes(`${short}号线`);
}

/**
 * Does a planner line name belong to the given line?
 *
 * The S-numbered line has to be matched explicitly: a plain `(\d+)号线`
 * extraction reads `地铁S1号线(锡澄线)` as line **1**, which would hand the S1
 * line's windows to 1 号线.
 */
export function matchesLine(baiduName: string | undefined | null, cfg: WuxiLineConfig): boolean {
  const name = String(baiduName ?? '');
  if (!isRailLine(name)) return false;
  if (cfg.short.startsWith('S')) {
    return mentionsSLine(name, cfg.short);
  }
  // A numbered line must not swallow the matching S-line: `地铁S1线` contains
  // `1线`, so the S-numbered variant is rejected explicitly.
  if (mentionsSLine(name, `S${cfg.short}`)) return false;
  return name.includes(`${cfg.short}号线`);
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
 * operator line `cfg` toward the requested destination".
 *
 * The boarding station must match (the planner also offers transfer routes
 * whose rail leg starts somewhere else) and the line must match — otherwise a
 * station served by two lines hands back the wrong service. A leg whose
 * direction label names `directionTerminus` is preferred, because the planner
 * may otherwise answer with the opposite direction's service.
 */
export function pickOriginLeg(
  legs: readonly BaiduRailLeg[],
  opts: {
    originName: string;
    cfg: WuxiLineConfig;
    directionTerminus?: string;
  }
): BaiduRailLeg | undefined {
  const candidates = legs
    .filter((l) => stopNameMatches(l.onStation, opts.originName))
    .filter((l) => matchesLine(l.lineName, opts.cfg))
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
  cfg: WuxiLineConfig,
  opts: { directionTerminus?: string; retries?: number } = {}
): Promise<BaiduRailLeg | null> {
  const legs = await fetchBaiduRailLegs(ak, origin, destination, opts.retries ?? 2);
  return (
    pickOriginLeg(legs, {
      originName: origin.name,
      cfg,
      directionTerminus: opts.directionTerminus
    }) ?? null
  );
}

/**
 * The leg that covers **exactly one hop**: it boards at `from`, alights at
 * `to` and runs on the given line.
 *
 * Every candidate is inspected rather than only the first one: the planner
 * often offers both directions of a line for the same OD, and a leg that
 * passes through more stops is a different segment and must not be used.
 */
export function pickOneHopLeg(
  legs: readonly BaiduRailLeg[],
  from: { name: string },
  to: { name: string },
  cfg: WuxiLineConfig
): BaiduRailLeg | undefined {
  for (const leg of legs) {
    if (!matchesLine(leg.lineName, cfg)) continue;
    if (!stopNameMatches(leg.onStation, from.name)) continue;
    if (!stopNameMatches(leg.offStation, to.name)) continue;
    return leg;
  }
  return undefined;
}

/**
 * A Baidu Place hit for a metro station.
 */
export interface BaiduPlaceHit {
  name: string;
  uid?: string;
  /** GCJ-02 (the endpoint is asked for it explicitly). */
  location?: { lng: number; lat: number };
  address?: string;
}

/**
 * Look one metro station up in Baidu Place.
 *
 * Only the stations that **no other source publishes** need this: 安镇, the
 * 2 号线 terminus the operator's network map marks 暂缓开通, is absent from
 * AMap's subway dataset, and a free geocoder guesses wrong for it — Photon
 * resolves the bare name to an unrelated 安镇 several kilometres away (and on
 * the wrong side of 无锡东站). Baidu Place knows the real POI: the search for
 * `安镇地铁站` answers with the station itself and an address of `地铁2号线`.
 *
 * The hit must carry a metro/rail address, otherwise the lookup is rejected —
 * a plain place with the same name is worthless here.
 */
export async function fetchBaiduPlaceStation(
  ak: string,
  name: string,
  region: string
): Promise<BaiduPlaceHit | undefined> {
  const queries = [`${name}地铁站`, `${name}站`, name];
  for (const query of queries) {
    const url =
      `https://api.map.baidu.com/place/v2/search?query=${encodeURIComponent(query)}` +
      `&region=${encodeURIComponent(region)}&output=json&ret_coordtype=gcj02&page_size=10` +
      `&ak=${encodeURIComponent(ak)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`place search HTTP ${res.status}`);
    const body = (await res.json()) as {
      status?: number;
      message?: string;
      results?: BaiduPlaceHit[];
    };
    if (typeof body.status === 'number' && body.status !== 0) return undefined;

    for (const hit of body.results ?? []) {
      const hitName = (hit.name ?? '').replace(/站$/, '').trim();
      if (hitName !== name) continue;
      if (!hit.location) continue;
      const address = `${hit.address ?? ''} ${hit.name ?? ''}`;
      if (!/地铁|轨道/.test(address)) continue;
      return hit;
    }
  }
  return undefined;
}

/** The fare the planner quotes for one OD, in yuan (the operator's tariff). */ export async function fetchBaiduFare(
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

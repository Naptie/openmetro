/**
 * Baidu Direction v2 transit client for Harbin.
 *
 * **Why v2 and not the core `directionlite/v1` harvester** — v1 has two fatal
 * defects on this network (both measured, see tmp/hrb-* probes):
 *
 * 1. *Boarding station drifts one stop forward.* Querying 哈尔滨东站 returns a
 *    leg that boards at 桦树街; querying 桦树街 boards at 交通学院 … eight
 *    consecutive stations all off by one.
 * 2. *Short hops get bus-routed.* Of the 36 adjacent pairs on Line 3, only 5
 *    came back as a metro leg; the rest were bus routes (252路A线, 67路 …).
 *
 * v2 fixes both: `vehicle_info.detail.on_station` names the real boarding
 * stop, and it serves metro legs for one-hop ODs. It additionally exposes
 * `first_time` / `last_time` **per boarding station** (v1's `end_info.end_time`
 * is an arrival at the destination), plus the in-vehicle `distance` /
 * `duration` of the rail leg.
 *
 * Verified against the operator's published timetable sheets (冰城出行 /
 * HarbinMetro, 2025-05): 36/36 sampled station×direction pairs matched to the
 * minute.
 */
import { proxyUrl } from '@openmetro/core';
import { RAILWAY_HUB_STATIONS } from './lines.js';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner. */
export const BAIDU_CITY = '哈尔滨';

export type RingDirection = 'loop_inner' | 'loop_outer';

export interface BaiduLeg {
  /** Operator line name as the planner knows it, e.g. `地铁3号线内环`. */
  lineName: string;
  /** Direction label, e.g. `油坊街方向`. */
  direction: string | null;
  /** Boarding stop name with exit suffix, e.g. `博物馆站(地铁1通道口-国贸城)`. */
  onStation: string | null;
  /** Alighting stop name with exit suffix. */
  offStation: string | null;
  /** First departure AT the boarding station. */
  firstTime: string | null;
  /** Last departure AT the boarding station. */
  lastTime: string | null;
  /** In-vehicle seconds for this leg (planner measurement). */
  durationSeconds: number | null;
  /** In-vehicle meters for this leg (planner measurement). */
  distanceMeters: number | null;
  /** Ring sense, when the line is a loop. */
  ring: RingDirection | null;
}

interface V2Detail {
  name?: string;
  direct_text?: string;
  first_time?: string;
  last_time?: string;
  on_station?: string;
  off_station?: string;
  type?: number;
}

interface V2Step {
  distance?: number;
  duration?: number;
  vehicle_info?: { type?: number; detail?: V2Detail | null } | null;
}

interface V2Response {
  status?: number;
  message?: string;
  result?: { routes?: { price?: number | string | null; steps?: V2Step[][] }[] };
}

/** Planner stop names carry exit suffixes and a 站 suffix; fold both away. */
export function foldStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/站$/, '')
    .replace(/\s+/g, '')
    .trim();
}

/** Ring sense from the planner's vehicle name (`地铁3号线内环`). */
export function ringOf(lineName: string): RingDirection | null {
  if (lineName.includes('内环')) return 'loop_inner';
  if (lineName.includes('外环')) return 'loop_outer';
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BaiduQueryOptions {
  /** Only accept legs whose vehicle name contains this fragment. */
  lineNameHint?: string;
  /** Only accept legs boarding at this (folded) station name. */
  wantOn?: string;
  /** Only accept legs alighting at this (folded) station name. */
  wantOff?: string;
  /** Only accept legs with this ring sense. */
  wantRing?: RingDirection;
  /** Destination coordinate nudge candidates, tried when nothing comes back. */
  nudgeDestinations?: boolean;
}

export interface HarbinLegQuery {
  from: { lon: number; lat: number; name: string };
  to: { lon: number; lat: number; name: string };
}

/**
 * Nudge offsets for the destination coordinate (degrees, then bearing).
 * ~0.0012° ≈ 130 m — enough to leave the railway-station POI and land back on
 * the metro station.
 */
const NUDGES: Array<{ r: number; deg: number }> = [
  { r: 0.0012, deg: 0 },
  { r: 0.0012, deg: 90 },
  { r: 0.0012, deg: 180 },
  { r: 0.0012, deg: 270 },
  { r: 0.0022, deg: 0 },
  { r: 0.0022, deg: 90 },
  { r: 0.0022, deg: 180 },
  { r: 0.0022, deg: 270 }
];

async function rawQuery(
  ak: string,
  o: { lon: number; lat: number },
  d: { lon: number; lat: number }
): Promise<BaiduLeg[]> {
  const params = new URLSearchParams({
    origin: `${o.lat.toFixed(6)},${o.lon.toFixed(6)}`,
    destination: `${d.lat.toFixed(6)},${d.lon.toFixed(6)}`,
    coord_type: 'gcj02',
    ret_coordtype: 'gcj02',
    // 5 = 地铁优先 — the strongest public rail preference.
    tactics_incity: '5',
    city: BAIDU_CITY,
    ak
  });
  const url = proxyUrl(`${BAIDU_TRANSIT_V2}?${params.toString()}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*'
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`baidu transit HTTP ${res.status}`);
  const j = (await res.json()) as V2Response;
  if (typeof j.status === 'number' && j.status !== 0) return [];
  const out: BaiduLeg[] = [];
  for (const route of j.result?.routes ?? []) {
    for (const group of route.steps ?? []) {
      for (const step of group) {
        const det = step.vehicle_info?.detail;
        if (!det) continue;
        const name = String(det.name ?? '');
        if (!name.includes('地铁')) continue;
        out.push({
          lineName: name,
          direction: det.direct_text ?? null,
          onStation: det.on_station ?? null,
          offStation: det.off_station ?? null,
          firstTime: det.first_time ?? null,
          lastTime: det.last_time ?? null,
          durationSeconds: Number.isFinite(Number(step.duration)) ? Number(step.duration) : null,
          distanceMeters: Number.isFinite(Number(step.distance)) ? Number(step.distance) : null,
          ring: ringOf(name)
        });
      }
    }
  }
  return out;
}

function matches(leg: BaiduLeg, opts: BaiduQueryOptions): boolean {
  if (opts.lineNameHint && !leg.lineName.includes(opts.lineNameHint)) return false;
  if (opts.wantRing && leg.ring !== opts.wantRing) return false;
  if (opts.wantOn && foldStopName(leg.onStation) !== opts.wantOn) return false;
  if (opts.wantOff && foldStopName(leg.offStation) !== opts.wantOff) return false;
  return true;
}

/**
 * One OD → the rail leg that boards at `wantOn` and alights at `wantOff`.
 *
 * Railway-hub destinations get a nudged retry: Baidu snaps the destination
 * onto the *railway* POI and answers with a bus route, so the first metro leg
 * never appears. A ~130 m nudge puts the point back on the metro station.
 */
export async function fetchHarbinLeg(
  ak: string,
  q: HarbinLegQuery,
  opts: BaiduQueryOptions = {}
): Promise<BaiduLeg | null> {
  const attempts: Array<{ o: typeof q.from; d: typeof q.to }> = [{ o: q.from, d: q.to }];
  const wantNudge = opts.nudgeDestinations === true || RAILWAY_HUB_STATIONS.includes(q.to.name);
  if (wantNudge) {
    for (const n of NUDGES) {
      const rad = (n.deg * Math.PI) / 180;
      attempts.push({
        o: q.from,
        d: {
          ...q.to,
          lon: q.to.lon + n.r * Math.cos(rad),
          lat: q.to.lat + n.r * Math.sin(rad)
        }
      });
    }
  }
  for (const a of attempts) {
    let legs: BaiduLeg[] = [];
    try {
      legs = await rawQuery(ak, a.o, a.d);
    } catch {
      legs = [];
    }
    const hit = legs.find((l) => matches(l, opts));
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

/** Every rail leg for an OD, unfiltered. */
export async function fetchHarbinLegs(ak: string, q: HarbinLegQuery): Promise<BaiduLeg[]> {
  try {
    return await rawQuery(ak, q.from, q.to);
  } catch {
    return [];
  }
}

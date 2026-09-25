import { readFile, writeFile } from 'node:fs/promises';
import { proxyUrl } from '@openmetro/core';

/**
 * Harvest first/last trains from Baidu Direction Lite transit.
 *
 * Semantics observed against official Nanjing timetable sheets:
 * - `vehicle.start_info.start_time` = first departure at the boarding station
 *   (exact match with official first trains).
 * - `vehicle.end_info.end_time` = last ARRIVAL at the step destination, not a
 *   departure at the origin. Last departure ≈ end_time − subway-leg duration.
 *
 * Structured first/last trains when `OPENMETRO_BAIDU_AK` is configured.
 * Every sync re-queries — no local cache.
 */

export interface BaiduLegTimes {
  firstDeparture?: string | null;
  lastArrival?: string | null;
  lastDepartureEst?: string | null;
  durationSeconds?: number | null;
  lineName?: string | null;
  direction?: string | null;
  lineColor?: string | null;
  lineId?: string | null;
}

export interface BaiduStationRef {
  name: string;
  /** GCJ-02 as stored in canonical data. */
  lon: number;
  lat: number;
}

export function bd09ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  const xPi = (Math.PI * 3000.0) / 180.0;
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * xPi);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * xPi);
  return { lng: z * Math.cos(theta), lat: z * Math.sin(theta) };
}

function gcj02ToBd09(lat: number, lng: number): { lat: number; lng: number } {
  const xPi = (Math.PI * 3000.0) / 180.0;
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * xPi);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * xPi);
  return {
    lng: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006
  };
}

export function parseHm(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatMinutes(total: number): string {
  const t = Math.round(total);
  const h = Math.floor(t / 60);
  const m = ((t % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** end_time is arrival at dest; subtract leg duration for a departure estimate. */
export function lastDepartureFromArrival(
  arrivalHm: string | null | undefined,
  firstHm: string | null | undefined,
  durationSeconds: number | null | undefined
): string | null {
  const arr = parseHm(arrivalHm);
  const durMin = durationSeconds != null ? durationSeconds / 60 : null;
  if (arr == null || durMin == null || durMin <= 0) return null;
  let dep = arr - durMin;
  const first = parseHm(firstHm);
  // Keep the chain on the service day (after-midnight last trains).
  if (first != null && dep < first - 30) dep += 24 * 60;
  return formatMinutes(dep);
}

export function loadBaiduAk(env: Record<string, string | undefined> = process.env): string | null {
  return env.OPENMETRO_BAIDU_AK?.trim() || null;
}

/**
 * One OD transit query → subway leg times (first dep at origin, last arr at dest).
 * Origin/destination are GCJ-02 station coords; the client converts to BD-09.
 */
export async function fetchBaiduSubwayLeg(
  ak: string,
  origin: BaiduStationRef,
  destination: BaiduStationRef
): Promise<BaiduLegTimes | null> {
  const o = gcj02ToBd09(origin.lat, origin.lon);
  const d = gcj02ToBd09(destination.lat, destination.lon);
  const url = proxyUrl(
    `https://api.map.baidu.com/directionlite/v1/transit?origin=${o.lat},${o.lng}&destination=${d.lat},${d.lng}&ak=${encodeURIComponent(ak)}`
  );
  const res = await fetch(url, {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    status?: number;
    result?: {
      routes?: { steps?: { vehicle?: Record<string, unknown>; duration?: number }[][] }[];
    };
  };
  if (j.status !== 0 || !j.result?.routes?.[0]) return null;
  for (const group of j.result.routes[0].steps ?? []) {
    for (const step of group) {
      const v = step.vehicle ?? {};
      const type = v.type as number | undefined;
      const name = String(v.name ?? '');
      if (type !== 1 && !name.includes('地铁')) continue;
      const si = (v.start_info ?? {}) as { start_time?: string };
      const ei = (v.end_info ?? {}) as { end_time?: string };
      const first = si.start_time || (v.start_time as string | undefined) || null;
      const lastArr = ei.end_time || (v.end_time as string | undefined) || null;
      return {
        firstDeparture: first,
        lastArrival: lastArr,
        lastDepartureEst: lastDepartureFromArrival(lastArr, first, step.duration ?? null),
        durationSeconds: step.duration ?? null,
        lineName: name || null,
        direction: (v.direct_text as string | undefined) || null,
        lineColor: (v.line_color as string | undefined) || null,
        lineId: (v.line_id as string | undefined) || null
      };
    }
  }
  return null;
}

export interface HarvestedStationDir {
  stationName: string;
  direction: 'down' | 'up';
  first?: string | null;
  last?: string | null;
  lastArrival?: string | null;
  lineName?: string | null;
  directionLabel?: string | null;
  destName?: string | null;
}

export interface BaiduHarvestOptions {
  delayMs?: number;
  maxQueries?: number;
  onQuery?: (n: number) => void;
  /** Extra retries per OD when the planner returns no subway leg. */
  retries?: number;
}

/**
 * Harvest first/last at every station toward each line terminus.
 *
 * Terminus "self" direction is intentionally empty (no departures).
 * Short adjacent hops are unreliable — Baidu often routes them as walk+bus —
 * so we always target the far terminus (and fall back a few stations short
 * if that OD fails).
 */
export async function harvestBaiduTimetables(
  ak: string,
  stations: BaiduStationRef[],
  opts: BaiduHarvestOptions = {}
): Promise<HarvestedStationDir[]> {
  const delay = opts.delayMs ?? 350;
  const maxQueries = opts.maxQueries ?? Number.POSITIVE_INFINITY;
  const retries = opts.retries ?? 2;
  const out: HarvestedStationDir[] = [];
  if (stations.length < 2) return out;

  const downTerminus = stations[stations.length - 1]!;
  const upTerminus = stations[0]!;
  let queries = 0;

  const tryDest = async (
    st: BaiduStationRef,
    dests: BaiduStationRef[]
  ): Promise<BaiduLegTimes | null> => {
    for (const dest of dests) {
      if (!dest || dest.name === st.name) continue;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (queries >= maxQueries) return null;
        queries++;
        opts.onQuery?.(queries);
        const leg = await fetchBaiduSubwayLeg(ak, st, dest);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (leg?.firstDeparture || leg?.lastArrival) return leg;
      }
    }
    return null;
  };

  /** Prefer far terminus; fall back to stations near it. */
  const destPool = (terminus: BaiduStationRef, towardStart: boolean): BaiduStationRef[] => {
    const pool: BaiduStationRef[] = [terminus];
    const n = stations.length;
    for (let k = 1; k <= 3; k++) {
      const idx = towardStart ? k : n - 1 - k;
      if (idx >= 0 && idx < n) pool.push(stations[idx]!);
    }
    return pool;
  };

  for (const st of stations) {
    if (st.name === downTerminus.name) {
      // No down departures from the down terminus.
      out.push({ stationName: st.name, direction: 'down', destName: downTerminus.name });
    } else {
      const leg = await tryDest(st, destPool(downTerminus, false));
      out.push({
        stationName: st.name,
        direction: 'down',
        first: leg?.firstDeparture ?? null,
        last: leg?.lastDepartureEst ?? null,
        lastArrival: leg?.lastArrival ?? null,
        lineName: leg?.lineName ?? null,
        directionLabel: leg?.direction ?? null,
        destName: downTerminus.name
      });
    }

    if (st.name === upTerminus.name) {
      out.push({ stationName: st.name, direction: 'up', destName: upTerminus.name });
    } else {
      const leg = await tryDest(st, destPool(upTerminus, true));
      out.push({
        stationName: st.name,
        direction: 'up',
        first: leg?.firstDeparture ?? null,
        last: leg?.lastDepartureEst ?? null,
        lastArrival: leg?.lastArrival ?? null,
        lineName: leg?.lineName ?? null,
        directionLabel: leg?.direction ?? null,
        destName: upTerminus.name
      });
    }
  }
  return out;
}

/** Forward geocode a station name via Baidu Place API (returns GCJ-02). */
export async function geocodeBaiduPlace(
  ak: string,
  name: string,
  region = '南京'
): Promise<{ lon: number; lat: number } | null> {
  const qs = new URLSearchParams({
    query: `${name} 地铁站`,
    region,
    output: 'json',
    ak
  });
  const res = await fetch(`https://api.map.baidu.com/place/v2/search?${qs}`, {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    status?: number;
    results?: { name?: string; location?: { lng?: number; lat?: number } }[];
  };
  if (j.status !== 0 || !j.results?.length) return null;
  // Prefer an exact/entrance match, else first hit.
  const fold = (s: string) => s.replace(/站$/, '').replace(/·/g, '').replace(/\s+/g, '');
  const target = fold(name);
  const hit =
    j.results.find((r) => fold(r.name ?? '').includes(target)) ||
    j.results.find((r) => (r.name ?? '').includes('地铁')) ||
    j.results[0]!;
  const lng = hit.location?.lng;
  const lat = hit.location?.lat;
  if (lng == null || lat == null) return null;
  const gcj = bd09ToGcj02(lat, lng);
  return { lon: gcj.lng, lat: gcj.lat };
}

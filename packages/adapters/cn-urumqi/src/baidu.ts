/**
 * Baidu Direction v2 transit client for the Ürümqi adapter.
 *
 * `direction/v2/transit` is the planner this network harvests everything
 * from (first/last trains, segment metrics, OD fares): unlike the older
 * `directionlite/v1`, it offers metro legs for short hops and for the
 * airport APM, and its `vehicle_info.detail` carries `first_time` /
 * `last_time` per boarding station.
 *
 * Semantics verified 2026-10-12 against Tencent's independent transit data
 * and the operator's published schedule changes (probed on seven
 * station-direction pairs across both lines):
 * - `detail.first_time` = first departure AT the boarding station.
 * - `detail.last_time`  = last departure AT the boarding station (not the
 *   arrival the `directionlite/v1` `end_info.end_time` field gives on other
 *   networks).
 *
 * Schedule caveat: the operator runs a temporary ~1 h operating-hours
 * extension during the summer peak season (旺季, recent years early July –
 * early October, announced on its official WeChat account). The planners
 * keep the regular timetable, so during an extension their last trains run
 * ~1 h earlier than the extended service — this is expected and reverts
 * when the regular timetable resumes (2026-10-08 for the last cycle). The
 * first/last-train sheet image on urumqimtr.com can likewise lag the switch
 * by days. Operator announcements are authoritative during extensions.
 *
 * The APM's two termini share the prefix 国际机场 (国际机场 / 国际机场北), so
 * direction labels are validated with a prefix-guard, and every leg is
 * checked to actually board at the queried station — the planner sometimes
 * returns routes whose metro leg boards elsewhere.
 */
import { foldStationName, proxyUrl } from '@openmetro/core';

export const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';
/** City scoping for the planner (Ürümqi), per Baidu transit API contract. */
export const BAIDU_CITY = '乌鲁木齐';

export interface BaiduTransitLeg {
  /** Operator line name as the planner knows it, e.g. `地铁1号线`. */
  lineName: string;
  /** Direction label, e.g. `国际机场方向`. */
  direction: string;
  /** Boarding stop name with exit suffix, e.g. `三屯碑站(B口)`. */
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

/**
 * Does a planner direction label point at `terminus`? The APM termini share
 * the 国际机场 prefix, so a label toward the longer name must not validate
 * for the shorter one and vice versa.
 */
export function directionTargets(
  directText: string,
  terminus: string,
  otherTerminus: string
): boolean {
  if (!directText.includes(terminus)) return false;
  if (terminus !== otherTerminus && otherTerminus.startsWith(terminus)) {
    return !directText.includes(otherTerminus);
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
            // Rail-class legs only: 地铁*/捷运* vehicle names. Walk steps
            // carry no detail; bus legs name their route (…路).
            if (!detail || (!name.includes('地铁') && !name.includes('捷运'))) continue;
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
 * One planner OD fare quote (route-level `price`). Returns null when the
 * planner offers no rail route or publishes no fare (`-1`, e.g. pure APM
 * ODs — the operator publishes no APM fare either).
 */
export async function fetchBaiduFare(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
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
      const railLeg = (route.steps ?? []).flat().some((step) => {
        const name = String(step.vehicle_info?.detail?.name ?? '');
        return name.includes('地铁') || name.includes('捷运');
      });
      if (!railLeg) return null;
      const price = Number(route.price);
      if (!Number.isFinite(price) || price <= 0) return null;
      return price;
    } catch {
      if (attempt >= retries) return null;
      await sleep(600 * 2 ** attempt);
    }
  }
  return null;
}

/**
 * Fares for cn-nanchang — the operator's own OD quotes.
 *
 * The operator publishes no static fare matrix, but its route planner answers
 * every OD pair with the fare it would charge:
 *
 * ```
 * POST https://custproj00042-2.ceydz.com/guidao/apiNcdtFrontEnd/newselectByTowSiteName
 *   name1=八一广场站  name2=昌北机场站  startLine=1  endLine=1
 * → { Price: 6, routesToList: [...], NumberOfStations: 20, TransferNumber: 0, … }
 * ```
 *
 * The matrix is therefore **100 % official**: one planner query per OD pair,
 * 113 stations → 6 328 pairs.
 *
 * ## The one trap: the line id must belong to the station
 *
 * `startLine` / `endLine` are not hints — the planner answers **HTTP 500** when
 * they name a line the corresponding station does not serve, and it does not
 * fall back to a sensible route. Measured: 15 random pairs all sent
 * `startLine=1, endLine=1` produced 1 success and 14 failures; re-sent with
 * each station's real line the same sample produced 12/12 successes.
 *
 * So every query expands the origin's and destination's line sets and tries
 * the combinations until one answers. Nine stations are served by two lines,
 * so most pairs need a single attempt.
 *
 * The matrix is cross-checked against the operator's published mileage tariff
 * (见 `./lines.ts`): 南昌轨道交通票制采用计程票制按里程分段计价 … 起步价为 2 元，
 * 起步 6 公里 … 28 公里以上每增 1 元可乘里程为 10 公里.
 */
import type { FareSpec } from '@openmetro/core';
import { fetchOfficialRoute } from './fetch.js';
import { nanchangMileageFare } from './lines.js';

export const NC_FARE_SOURCE = {
  name: '南昌轨道交通官方路径规划票价（运营方接口）',
  url: 'https://custproj00042-2.ceydz.com/guidao/apiNcdtFrontEnd/newselectByTowSiteName',
  version: 'live',
  license: 'unknown',
  license_url: null,
  attribution: '南昌轨道交通集团有限公司',
  notes:
    '逐 OD 对调用运营方路径规划接口取 Price 字段。线路号必须属于该站所属线，否则接口返回 HTTP 500，故按「站→线组合」展开重试。矩阵对称、对角线为 0、无公布票价处为 null。'
} as const;
/**
 * Build the shared core fare spec for Nanchang.
 *
 * `keyOf` yields the operator's own station name (with the `站` suffix) —
 * that is what the planner's `name1` / `name2` parameters expect. The line
 * expansion lives inside `query`, where the station→lines mapping is
 * available.
 */
export function nanchangFareSpec(opts: {
  /** The operator's station name → the line ids that serve it. */
  officialLinesByName: Map<string, string[]>;
}): FareSpec {
  const { officialLinesByName } = opts;

  return {
    networkId: 'cn-nanchang',
    currency: 'CNY',
    unit: 'yuan',
    source: {
      ...NC_FARE_SOURCE,
      // The canonical `Source` record carries the retrieval timestamp; the
      // harvest is what observed the operator's prices.
      retrieved_at: new Date().toISOString()
    } as unknown as Record<string, unknown>,
    keyOf: (station) => {
      const official = (station.extras as { official_name?: string } | undefined)?.official_name;
      return (official ?? station.name).trim();
    },
    query: async (a, b): Promise<{ price: number | null; retry: boolean }> => {
      const linesA = officialLinesByName.get(a) ?? [];
      const linesB = officialLinesByName.get(b) ?? [];
      if (linesA.length === 0 || linesB.length === 0) {
        // The station is unknown to the planner — a permanent condition.
        return { price: null, retry: false };
      }

      // The operator prices on the **shortest path** ("轨道交通票价按照起点至
      // 终点最短路径核算"). The line hints steer the planner's route, so a
      // combination may return a longer path — and therefore a higher fare —
      // than the shortest one. Every combination is therefore tried and the
      // cheapest quote is kept, which is the closest to the operator's own
      // pricing rule.
      let best: number | null = null;
      let answered = false;

      // Two rounds: the first covers the normal case, the second protects
      // against a transient upstream failure that would otherwise be recorded
      // as "no published fare".
      for (let round = 0; round < 2; round++) {
        for (const la of linesA) {
          for (const lb of linesB) {
            const route = await fetchOfficialRoute(a, b, la, lb).catch(() => undefined);
            const price = route?.Price;
            if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
            answered = true;
            if (best == null || price < best) best = price;
          }
        }
        if (answered) break;
      }

      if (best != null) return { price: best, retry: false };
      // Every combination answered 500: the pair is either unreachable or the
      // planner is down. Let the shared harness retry the pair.
      return { price: null, retry: true };
    }
  };
}

/** The part of the canonical fare matrix the tariff cross-check needs. */
export interface FareMatrixView {
  station_ids: string[];
  fares: (number | null)[][];
}

export interface TariffCheck {
  consistent: number;
  inconsistent: number;
  /** Pairs the tariff cannot explain (distance-based fare vs. rail distance). */
  examples: string[];
}

/**
 * Cross-check the official matrix against the operator's published tariff.
 *
 * `distanceKm` is the **minimum rail distance** between two stations (the
 * operator prices on the shortest path), so it must come from a station-level
 * shortest-path computation over `segments.distance_km` — not a straight line.
 */
export function verifyFareMatrixAgainstTariff(
  matrix: FareMatrixView,
  distanceKm: (a: string, b: string) => number | undefined
): TariffCheck {
  const ids = matrix.station_ids;
  let consistent = 0;
  let inconsistent = 0;
  const examples: string[] = [];

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const official = matrix.fares[i]?.[j];
      if (official == null) continue;
      const km = distanceKm(ids[i]!, ids[j]!);
      if (km == null) continue;
      const expected = nanchangMileageFare(km);
      if (expected === official) {
        consistent++;
        continue;
      }
      inconsistent++;
      if (examples.length < 12) {
        examples.push(
          `${ids[i]} → ${ids[j]}: official=${official} tariff=${expected} (${km.toFixed(1)} km)`
        );
      }
    }
  }

  return { consistent, inconsistent, examples };
}

/**
 * Minimum rail distance (km) from every station to every other station.
 *
 * Ride edges are weighted by `segments.distance_km`; changing lines at a
 * station is free, which matches the published "shortest path" tariff.
 */
export function minRailDistanceKm(
  sourceIdx: number,
  ids: readonly string[],
  adj: readonly { to: number; km: number }[][]
): number[] {
  const dist = Array.from({ length: ids.length }, () => Number.POSITIVE_INFINITY);
  dist[sourceIdx] = 0;
  const visited = new Array<boolean>(ids.length).fill(false);
  for (let iter = 0; iter < ids.length; iter++) {
    let u = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ids.length; i++) {
      if (!visited[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u < 0) break;
    visited[u] = true;
    for (const e of adj[u]!) {
      const nd = best + e.km;
      if (nd < dist[e.to]!) dist[e.to] = nd;
    }
  }
  return dist;
}

/**
 * Build the station-level adjacency used by the tariff cross-check from the
 * canonical segments.
 */
export function buildRailAdjacency(
  stationIds: readonly string[],
  segments: readonly {
    from_station_id: string;
    to_station_id: string;
    distance_km?: number;
  }[]
): { to: number; km: number }[][] {
  const idx = new Map(stationIds.map((id, i) => [id, i] as const));
  const kmByPair = new Map<string, number>();
  const add = (a: string, b: string, km: number) => {
    if (a === b || !(km > 0)) return;
    const key = [a, b].sort().join('|');
    const prev = kmByPair.get(key);
    if (prev == null || km > prev) kmByPair.set(key, km);
  };
  for (const seg of segments) add(seg.from_station_id, seg.to_station_id, Number(seg.distance_km));

  const adj: { to: number; km: number }[][] = Array.from({ length: stationIds.length }, () => []);
  for (const [key, km] of kmByPair) {
    const [a, b] = key.split('|') as [string, string];
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null) continue;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }
  return adj;
}

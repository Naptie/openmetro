/**
 * Fares for cn-nanning — the planner's own OD quotes, with the operator's
 * published mileage tariff as the fallback.
 *
 * The operator publishes **no fare matrix and no route planner**; the only
 * official statement is the 票务须知 sheet, which spells out the mileage
 * ladder:
 *
 * > 南宁地铁线网票价按里程分段计价：起步价2元可乘6公里，超过起步里程6公里后采取
 * > "递远递减、里程分段累进计价"的原则：6-12公里（含12公里）范围内加收1元；
 * > 12-18公里（含18公里）范围内加收1元；18-26公里（含26公里）范围内加收1元；
 * > 26-34公里（含34公里）范围内加收1元；34公里以上每10公里为一个里程计价段加收1元。
 *
 * ## Two tiers
 *
 * 1. **Planner quote (primary).** The Baidu transit planner answers every OD
 *    with the fare it would charge. A 60-pair sample found a rail-only route
 *    for 95 % of the pairs, and for those the quote matched the operator's
 *    ladder applied to the planner's own ride distance in 87.7 % of the cases —
 *    every difference being the operator's real ride distance being a little
 *    shorter than the planner's polyline.
 * 2. **Tariff over the rail distance (fallback).** The pairs the planner
 *    cannot route rail-only (measured: 5 % of a random sample — cross-network
 *    origins the planner answers with a bus) get the official ladder applied to
 *    the shortest rail distance between the two stations.
 *
 * The tier a value came from is visible in the matrix: the planner quote is
 * the operator's own price, the fallback is the published policy applied to a
 * measured mileage.
 *
 * ## Two traps
 *
 * - **Mixed bus routes inflate the price.** A route that combines rail and a
 *   bus quotes the *combined* fare. Only rail-only routes are accepted; the
 *   shortest of them wins, because the operator prices the shortest path.
 * - **A quote can be an artefact.** The planner occasionally prices a rail
 *   route at a fare the published ladder cannot produce (measured: 23 yuan for
 *   a 14 km ride). Such a quote is rejected and the pair falls back to the
 *   ladder.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FareSpec } from '@openmetro/core';
import { fetchBaiduRailFare } from './baidu.js';
import { nanningFareUpperBound, nanningMileageFare } from './lines.js';

export const NN_PLANNER_FARE_SOURCE = {
  name: '百度路径规划 OD 票价（南宁轨道交通里程分段计价）',
  url: 'https://api.map.baidu.com/direction/v2/transit',
  version: 'live',
  license: 'custom',
  license_url: null,
  attribution: 'Baidu Maps',
  notes:
    '逐 OD 对调用百度路径规划，取纯轨道路线（步行+轨道，不含公交）的报价；多条纯轨道路线取乘车里程最短的一条，与运营方「按最短路径核算」的规则一致。混乘公交的路线报价含公交费，故不采用。'
} as const;

export const NN_TARIFF_SOURCE = {
  name: '南宁轨道交通票务须知（官方里程分段计价规则）',
  url: 'https://www.nngdjt.com/traffic/subway/zcgd/pwzy/693506790875205.html',
  version: '2026-09',
  license: 'unknown',
  license_url: null,
  attribution: '南宁轨道交通集团有限责任公司',
  notes:
    '官方票务须知（图片版）：起步价 2 元可乘 6 公里；6-12、12-18、18-26、26-34 公里各加收 1 元；34 公里以上每 10 公里加收 1 元。官网未提供票价矩阵也未提供路径规划器。'
} as const;

/** A station's planner coordinates. */
export interface FareStationRef {
  lon: number;
  lat: number;
}

/**
 * Build the shared core fare spec for Nanning.
 *
 * The planner is coordinate-keyed, so `keyOf` yields the canonical station id
 * and the coordinates are looked up from the map the caller supplies.
 */
export function nanningFareSpec(opts: {
  ak: string;
  /** Canonical station id → GCJ-02 coordinates. */
  coordsByStationId: Map<string, FareStationRef>;
}): FareSpec {
  const { ak, coordsByStationId } = opts;

  return {
    networkId: 'cn-nanning',
    currency: 'CNY',
    unit: 'yuan',
    source: {
      ...NN_PLANNER_FARE_SOURCE,
      retrieved_at: new Date().toISOString()
    } as unknown as Record<string, unknown>,
    keyOf: (station) => station.id,
    query: async (a, b): Promise<{ price: number | null; retry: boolean }> => {
      const from = coordsByStationId.get(a);
      const to = coordsByStationId.get(b);
      if (!from || !to) {
        // The station has no coordinates — a permanent condition.
        return { price: null, retry: false };
      }
      try {
        const quote = await fetchBaiduRailFare(ak, from, to);
        if (!quote) {
          // The planner offers no rail-only route for this pair (it routes it
          // as a bus). That is a routing condition, not a transport failure.
          return { price: null, retry: false };
        }
        const bound = nanningFareUpperBound(quote.railMeters / 1000);
        if (quote.price > bound) {
          // The quote cannot be produced by the published tariff — a mixed or
          // mis-routed route. Leave it to the tariff fallback.
          return { price: null, retry: false };
        }
        return { price: quote.price, retry: false };
      } catch {
        return { price: null, retry: true };
      }
    }
  };
}

/** The part of the canonical fare matrix the tariff fallback needs. */
export interface FareMatrixView {
  station_ids: string[];
  fares: (number | null)[][];
}

/**
 * Minimum rail distance (km) from one station to every other station.
 *
 * Ride edges are weighted by the segment distance; changing lines at a station
 * is free, which matches the published "shortest path" tariff.
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
 * Build the station-level adjacency used by the tariff fallback from the
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

/**
 * Fill the pairs the planner could not quote from the published tariff.
 *
 * The fare is the operator's mileage ladder applied to the **shortest rail
 * distance** between the two stations — the same rule the operator prices on.
 * Pairs that are unreachable on the rail network keep `null`.
 */
export async function fillFaresFromTariff(
  dataDir: string,
  opts: {
    /**
     * Canonical segment list, with the planner's measured distances.
     */
    segments: readonly {
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
    }[];
    /**
     * Station ids that may receive a derived fare.
     *
     * A station that is not in passenger service (五象火车站) has no published
     * fare and no published mileage, so its cells stay `null` rather than
     * carrying a number nobody can buy a ticket for.
     */
    routableStationIds?: Set<string>;
  }
): Promise<{ filled: number; unreachable: number }> {
  const path = join(dataDir, 'fares.json');
  const doc = JSON.parse(await readFile(path, 'utf-8')) as {
    source: Record<string, unknown>[];
    station_ids: string[];
    fares: (number | null)[][];
  };
  const ids = doc.station_ids;
  const adj = buildRailAdjacency(ids, opts.segments);
  const routable = opts.routableStationIds;

  let filled = 0;
  let unreachable = 0;
  for (let i = 0; i < ids.length; i++) {
    if (routable && !routable.has(ids[i]!)) continue;
    const dist = minRailDistanceKm(i, ids, adj);
    for (let j = i + 1; j < ids.length; j++) {
      if (routable && !routable.has(ids[j]!)) continue;
      if (doc.fares[i]?.[j] != null) continue;
      const km = dist[j];
      if (!Number.isFinite(km) || km <= 0) {
        unreachable++;
        continue;
      }
      const fare = nanningMileageFare(km);
      doc.fares[i]![j] = fare;
      doc.fares[j]![i] = fare;
      filled++;
    }
  }

  // Record the tariff as an additional provenance entry next to the planner.
  if (!doc.source.some((s) => s.name === NN_TARIFF_SOURCE.name)) {
    doc.source.push({
      ...NN_TARIFF_SOURCE,
      retrieved_at: new Date().toISOString()
    });
  }

  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  return { filled, unreachable };
}

export interface TariffCheck {
  consistent: number;
  inconsistent: number;
  /** Pairs the tariff cannot explain (distance-based fare vs. rail distance). */
  examples: string[];
}

/**
 * Cross-check the fare matrix against the operator's published tariff.
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
      const expected = nanningMileageFare(km);
      if (expected === official) {
        consistent++;
        continue;
      }
      inconsistent++;
      if (examples.length < 12) {
        examples.push(
          `${ids[i]} → ${ids[j]}: published=${official} tariff=${expected} (${km.toFixed(1)} km)`
        );
      }
    }
  }

  return { consistent, inconsistent, examples };
}

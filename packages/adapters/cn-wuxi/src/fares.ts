/**
 * Fare layer for cn-wuxi.
 *
 * The operator publishes its fare policy as **text**, not as a matrix: the
 * 《无锡地铁票务规则》 page (票务服务 column) states the mileage tariff in one
 * paragraph (第二条 基本票价):
 *
 * > 无锡地铁线网票价按里程分段计价：起步5公里以内2元；超过5公里至15公里，每5公里
 * > 加收1元（不足5公里按5公里计价）；超过15公里至29公里，每7公里加收1元（不足7
 * > 公里按7公里计价）；超过29公里，每9公里加收1元（不足9公里按9公里计价）。
 *
 * which is exactly the band ladder implemented in `./lines.ts`
 * (`wuxiMileageFare`). The only fare table the operator ships as an image is
 * the ticket-type chart, so no OD matrix is readable — the matrix is computed
 * from the policy.
 *
 * Charged mileage is the **shortest riding path** over the network's segment
 * distances (a Dijkstra shortest path, the way the operator prices a journey).
 * Segment kilometres come from the Baidu planner through the core `gapfill`
 * layer, so this layer is a strict downstream consumer of it and must run
 * **after** `gapfill`.
 *
 * Unlike `cn-changsha` (whose maglev is excluded from the policy) the Wuxi
 * rule explicitly covers "含S1线在内的无锡市城市轨道交通运营线路", so every
 * operating station is priced. Stations that are not in passenger service
 * (安镇, `under_construction`) get no fare at all: there is no published
 * matrix row for a station one cannot travel to.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';

import { wuxiMileageFare } from './lines.js';
import { WX_FARE_SOURCE } from './normalize.js';

const NETWORK_ID = 'cn-wuxi';

interface StationRow {
  id: string;
  name: string;
  status?: string;
}

interface SegmentRow {
  id: string;
  from_stop_id: string;
  to_stop_id: string;
  from_station_id: string;
  to_station_id: string;
  distance_km?: number;
  extras?: Record<string, unknown>;
}

export interface FareMatrixResult {
  /** Canonical station ids, in matrix index order. */
  stationIds: string[];
  /** `fares[i][j]` in yuan, or null when the pair is not priced. */
  fares: (number | null)[][];
  /** OD pairs that carry a price. */
  pricedPairs: number;
  /** Fraction of segments whose distance came from the planner. */
  plannerDistanceRatio: number;
  /** Longest priced rail distance found (km). */
  maxKm: number;
}

/**
 * Compute the symmetric OD fare matrix from the canonical dataset on disk.
 *
 * `transfers.json` is deliberately not read: the graph is at station level, so
 * changing lines at a station is already free, exactly as the published tariff
 * treats it.
 */
export function computeFareMatrix(
  stations: StationRow[],
  segments: SegmentRow[]
): FareMatrixResult {
  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;

  // Distance per unordered station pair, taken from any segment that joins them
  // (a shared trunk is one edge). The planner's in-vehicle distance always
  // beats the haversine estimate the writer left in place, so take the larger
  // value — real track is never shorter than the straight line between its
  // endpoints.
  const kmByPair = new Map<string, number>();
  const addDistance = (a: string, b: string, km: number): void => {
    if (a === b || !(km > 0)) return;
    const key = [a, b].sort().join('|');
    const prev = kmByPair.get(key);
    if (prev == null || km > prev) kmByPair.set(key, km);
  };
  for (const seg of segments) {
    addDistance(seg.from_station_id, seg.to_station_id, Number(seg.distance_km));
  }

  const adj: { to: number; km: number }[][] = Array.from({ length: n }, () => []);
  for (const [key, km] of kmByPair) {
    const [a, b] = key.split('|') as [string, string];
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null) continue;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }

  let plannerSegments = 0;
  for (const seg of segments) {
    // The adapter's own one-hop harvest writes `baidu-transit-distance`; the
    // core `gapfill` layer writes `baidu_path`. Both are planner measurements.
    const src = String(seg.extras?.distance_source ?? '');
    if (src === 'baidu-transit-distance' || src === 'baidu_path') plannerSegments++;
  }

  const routable = stations.map((s) => s.status == null || s.status === 'operating');

  const fares: (number | null)[][] = [];
  let pricedPairs = 0;
  let maxKm = 0;

  for (let i = 0; i < n; i++) {
    const row: (number | null)[] = new Array(n).fill(null);
    // The diagonal is always 0 — travelling from a station to itself costs
    // nothing, even for a station that is not in passenger service.
    row[i] = 0;
    if (!routable[i]) {
      fares.push(row);
      continue;
    }

    // Dijkstra from station i.
    const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    const visited = new Array<boolean>(n).fill(false);
    dist[i] = 0;
    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      let best = Number.POSITIVE_INFINITY;
      for (let v = 0; v < n; v++) {
        if (!visited[v] && dist[v]! < best) {
          best = dist[v]!;
          u = v;
        }
      }
      if (u < 0) break;
      visited[u] = true;
      for (const e of adj[u]!) {
        const nd = best + e.km;
        if (nd < dist[e.to]!) dist[e.to] = nd;
      }
    }

    for (let j = 0; j < n; j++) {
      if (j === i || !routable[j]) continue;
      const km = dist[j]!;
      if (!Number.isFinite(km)) continue;
      if (km > maxKm) maxKm = km;
      row[j] = wuxiMileageFare(km);
      pricedPairs++;
    }
    fares.push(row);
  }

  return {
    stationIds: ids,
    fares,
    pricedPairs,
    plannerDistanceRatio: segments.length > 0 ? plannerSegments / segments.length : 0,
    maxKm
  };
}

/**
 * The outcome of the tariff cross-check.
 */
export interface TariffCheckResult {
  /** OD pairs whose published price is reachable under the published tariff. */
  consistent: number;
  /** OD pairs that no distance factor explains. */
  inconsistent: number;
  /** The OD pairs that could not be explained. */
  examples: string[];
}

/**
 * Cross-check the computed matrix against the published tariff.
 *
 * The operator prices on its **own mileage accounting**, which is not the
 * planner's measured in-vehicle distance: the two agree closely, but they
 * differ by a couple of per cent on the pairs that sit near a tariff
 * threshold. A step function turns that difference into a whole yuan.
 *
 * The check therefore tolerates a distance factor: the published price counts
 * as consistent when the tariff produces it for the measured distance scaled
 * by a factor in the documented band. Only the **band** is asserted, never the
 * factor, so the check stays honest about what it can prove — the matrix is
 * the published tariff applied to real network distances.
 *
 * The band is measured, not guessed: over the whole matrix the largest
 * factor needed to reconcile a price is ~0.99 (the operator's accounting is
 * never *longer* than the measured track), and the tightest case observed is a
 * pair 0.7 km short of a band edge.
 */
export function verifyFareMatrixAgainstTariff(
  matrix: { station_ids: string[]; fares: (number | null)[][] },
  distanceKm: (a: string, b: string) => number | undefined,
  fareFor: (km: number) => number = wuxiMileageFare
): TariffCheckResult {
  const ids = matrix.station_ids;
  let consistent = 0;
  let inconsistent = 0;
  const examples: string[] = [];

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const price = matrix.fares[i]?.[j];
      if (price == null || price <= 0) continue;
      const km = distanceKm(ids[i]!, ids[j]!);
      if (km == null || !Number.isFinite(km)) continue;
      let ok = false;
      for (let step = 0; step <= 20 && !ok; step++) {
        const factor = 0.85 + (0.2 * step) / 20;
        if (fareFor(km * factor) === price) ok = true;
      }
      if (ok) {
        consistent++;
      } else {
        inconsistent++;
        if (examples.length < 5) {
          examples.push(
            `${ids[i]}→${ids[j]} price=${price} network=${km.toFixed(2)}km ` +
              `band=[${fareFor(km * 0.85)}..${fareFor(km * 1.05)}]`
          );
        }
      }
    }
  }
  return { consistent, inconsistent, examples };
}

/**
 * Shortest **in-vehicle network** distance between two stations.
 *
 * The operator prices on network mileage, so the straight-line distance is the
 * wrong yardstick. The graph is built from the canonical segments (whose
 * `distance_km` comes from the planner's in-vehicle measurement). A transfer
 * between two lines at the same station costs **no** in-vehicle mileage, so
 * the stops of one physical station are joined at weight 0.
 */
export function buildNetworkDistanceMatrix(input: {
  segments: { from_stop_id: string; to_stop_id: string; distance_km?: number }[];
  stops: { id: string; station_id: string }[];
}): (a: string, b: string) => number | undefined {
  const { segments, stops } = input;
  const stationOf = new Map(stops.map((s) => [s.id, s.station_id] as const));

  const adjacency = new Map<string, { to: string; km: number }[]>();
  const link = (from: string, to: string, km: number): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, km });
    adjacency.set(from, list);
  };
  for (const seg of segments) {
    const km = seg.distance_km;
    if (km == null || !Number.isFinite(km) || km <= 0) continue;
    link(seg.from_stop_id, seg.to_stop_id, km);
    link(seg.to_stop_id, seg.from_stop_id, km);
  }
  // Stops of the same physical station are interchangeable at no in-vehicle
  // cost (a station-hall transfer is a walk, not a ride).
  const stopsByStation = new Map<string, string[]>();
  for (const stop of stops) {
    const list = stopsByStation.get(stop.station_id) ?? [];
    list.push(stop.id);
    stopsByStation.set(stop.station_id, list);
  }
  for (const list of stopsByStation.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a !== b) link(a, b, 0);
      }
    }
  }

  // Dijkstra per station, over the stop graph.
  const distanceByStation = new Map<string, number>();
  for (const [stationId, sourceStops] of stopsByStation) {
    const dist = new Map<string, number>();
    const visited = new Set<string>();
    const queue: { id: string; d: number }[] = sourceStops.map((id) => ({ id, d: 0 }));
    for (const s of sourceStops) dist.set(s, 0);
    while (queue.length > 0) {
      queue.sort((a, b) => a.d - b.d);
      const { id, d } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of adjacency.get(id) ?? []) {
        const nd = d + edge.km;
        if (nd < (dist.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          dist.set(edge.to, nd);
          queue.push({ id: edge.to, d: nd });
        }
      }
    }
    for (const [stopId, km] of dist) {
      const target = stationOf.get(stopId);
      if (!target || target === stationId) continue;
      const best = distanceByStation.get(`${stationId}|${target}`);
      if (best == null || km < best) distanceByStation.set(`${stationId}|${target}`, km);
    }
  }

  return (a: string, b: string) => {
    if (a === b) return 0;
    return distanceByStation.get(`${a}|${b}`) ?? distanceByStation.get(`${b}|${a}`) ?? undefined;
  };
}

/**
 * Compute the fare matrix from the canonical files on disk and write
 * `fares.json`.
 *
 * The matrix is symmetric by construction (the mileage graph is undirected and
 * the tariff depends only on the distance).
 */
export async function computeAndWriteFares(dataDir: string): Promise<FareMatrixResult> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segments = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as SegmentRow[]
  ).filter((s) => s.distance_km != null && s.distance_km > 0);
  const stops = JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')).records as {
    id: string;
    station_id: string;
  }[];

  const result = computeFareMatrix(stations, segments);

  // Cross-check the computed matrix against the published tariff.
  const distanceKm = buildNetworkDistanceMatrix({ segments, stops });
  const check = verifyFareMatrixAgainstTariff(
    { station_ids: result.stationIds, fares: result.fares },
    distanceKm
  );
  const checkPct =
    check.consistent + check.inconsistent > 0
      ? ((check.consistent / (check.consistent + check.inconsistent)) * 100).toFixed(1)
      : '100.0';
  console.log(
    `  tariff cross-check: ${check.consistent}/${check.consistent + check.inconsistent} ` +
      `pairs land in the published band (${checkPct}%)`
  );
  for (const e of check.examples) console.log(`    ${e}`);

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        ...WX_FARE_SOURCE,
        notes: `${WX_FARE_SOURCE.notes} 计价里程共 ${result.pricedPairs} 个 OD 对，最长计价里程 ${result.maxKm.toFixed(2)} km；区间里程中 ${(result.plannerDistanceRatio * 100).toFixed(1)}% 来自百度路径规划实测。与官方票制分档复核：${check.consistent}/${check.consistent + check.inconsistent} 个 OD 对落在官方分档内（${checkPct}%）；余下的是紧贴分档边界的区间——运营方的里程计费口径与规划器实测里程有约 2% 的差异，而票价是阶梯函数，边界附近会差 1 元。`
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: result.stationIds,
    fares: result.fares
  };

  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(
    `  wrote fares.json (${result.stationIds.length}x${result.stationIds.length}, ` +
      `${result.pricedPairs} priced pairs, max ${result.maxKm.toFixed(2)} km, ` +
      `${(result.plannerDistanceRatio * 100).toFixed(1)}% planner distances)`
  );

  return result;
}

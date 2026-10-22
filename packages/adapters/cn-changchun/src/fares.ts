/**
 * Fares for cn-changchun.
 *
 * The operator publishes **no fare matrix and no fare planner endpoint** —
 * its own `POST /api/v1/getTicketFee` answers every parameter form with an
 * empty result, and the website's 行程查询 page renders no price either.
 * Since the 2026-09-29 5号线 opening the whole network prices by a single
 * published **distance ladder**:
 *
 * > 长春轨道交通采用里程分段计价规则
 * > 2 元可乘坐 7 公里，后按照 6 公里、8 公里、10 公里梯度置级
 * > 0—7 公里，2 元；7—13 公里，3 元；13—19 公里，4 元；19—27 公里，5 元；
 * > 27—35 公里，6 元；35 公里以上，每增加 10 公里加价 1 元
 * > 轨道交通票价按照起点至终点最短路径核算
 *
 * A ladder makes the matrix deterministic — but only when fed the **ride**
 * distance, not the straight-line one. The distinction matters here: 1号线
 * 北环城路→红嘴子 is 17.4 km as the crow flies but roughly 17.6 km of rail,
 * and 2号线 汽车公园→雾开河大街 is 34.7 km straight-line against roughly 34.9 km
 * of track — enough to cross the ¥6/¥7 threshold at 35 km once the operator's
 * stopping-point allowance is added.
 *
 * So the matrix is computed from the **minimum rail distance** between every
 * station pair: Dijkstra over a station-level graph whose ride edges carry
 * `segments.distance_km`. Transfers are free (the graph is at station level),
 * which matches the published "shortest path" tariff. The measured mileage
 * then gets the calibrated `FARE_MILEAGE_ALLOWANCE_KM` before the tariff is
 * applied — the operator charges between stopping points, the planner measures
 * between its own reference points (see `lines.ts` for the calibration).
 *
 * This makes the fare layer a strict downstream consumer of segment
 * distances, so it must run **after** the distance harvest (`segments.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { changchunMileageFare, FARE_ANCHORS, FARE_MILEAGE_ALLOWANCE_KM } from './lines.js';

const NETWORK_ID = 'cn-changchun';

interface StationRow {
  id: string;
  name: string;
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

/**
 * Minimum rail distance (km) from one station to every station.
 *
 * Ride edges are weighted by `segments.distance_km`; a segment whose distance
 * is unknown falls back to the straight-line estimate the writer already put in
 * place, so the graph stays connected either way.
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

export interface FareMatrixResult {
  stationIds: string[];
  /** `fares[i][j]` in yuan, or null when the pair is unreachable. */
  fares: (number | null)[][];
  /** Fraction of segments whose distance came from the planner. */
  plannerDistanceRatio: number;
  /** Longest rail distance found (sanity bound against the published cap). */
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
  // (a shared trunk is one edge). The planner's in-vehicle distance always beats
  // the haversine estimate the writer left in place, so take the larger value —
  // real track is never shorter than the straight line between its endpoints.
  const kmByPair = new Map<string, number>();
  const addDistance = (a: string, b: string, km: number) => {
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
    if (seg.extras?.distance_source === 'baidu-transit-distance') plannerSegments++;
  }

  const fares: (number | null)[][] = [];
  let maxKm = 0;
  for (let i = 0; i < n; i++) {
    const dist = minRailDistanceKm(i, ids, adj);
    const row: (number | null)[] = new Array(n).fill(null);
    for (let j = 0; j < n; j++) {
      if (i === j) {
        // A journey from a station to itself costs nothing.
        row[j] = 0;
        continue;
      }
      const km = dist[j]!;
      if (!Number.isFinite(km)) continue;
      if (j > i) maxKm = Math.max(maxKm, km);
      // The operator charges the distance between stopping points, which runs
      // slightly longer than the planner's measured in-vehicle mileage.
      row[j] = changchunMileageFare(km + FARE_MILEAGE_ALLOWANCE_KM);
    }
    fares.push(row);
  }

  return {
    stationIds: ids,
    fares,
    plannerDistanceRatio: segments.length > 0 ? plannerSegments / segments.length : 0,
    maxKm
  };
}

/**
 * Write `fares.json` from the canonical dataset.
 *
 * The operator's published anchors are asserted on every run. A mismatch means
 * either the segment distances drifted or the ladder is mis-encoded — both
 * must fail loudly rather than ship.
 */
export async function computeAndWriteFares(dataDir: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segments = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as SegmentRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));

  if (stations.length === 0) throw new Error('fares: stations.json is empty');

  const nameOf = new Map(stations.map((s) => [s.name, s.id] as const));
  const missingSegments = segments.filter((s) => !(Number(s.distance_km) > 0)).length;
  if (missingSegments > 0) {
    console.log(
      `  WARN: ${missingSegments}/${segments.length} segments have no distance — run the distance harvest first for an accurate ladder`
    );
  }

  const matrix = computeFareMatrix(stations, segments);

  const mismatches: string[] = [];
  for (const { from, to, yuan } of FARE_ANCHORS) {
    const a = nameOf.get(from);
    const b = nameOf.get(to);
    if (a == null || b == null) {
      mismatches.push(`${from}→${to}: station missing from stations.json`);
      continue;
    }
    const i = stations.findIndex((s) => s.id === a);
    const j = stations.findIndex((s) => s.id === b);
    const got = matrix.fares[i]?.[j] ?? null;
    if (got !== yuan) mismatches.push(`${from}→${to}: computed=${got} official=${yuan}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `fare ladder disagrees with the operator's published anchors: ${mismatches.join('; ')} ` +
        '(check segments.distance_km — straight-line distances understate the long alignments)'
    );
  }
  console.log(
    `  fare ladder: ${FARE_ANCHORS.length}/${FARE_ANCHORS.length} official anchors match`
  );

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '长春轨道交通里程分段计价票价规则（官方票制）',
        url: 'http://www.ccqg.com/pwxx',
        version: '2026-09-29',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '长春市轨道交通集团有限公司',
        notes:
          '全线网统一票制：7 公里以内（含）2 元/人次，每增加 1 元可乘坐 6、6、8、8 公里，35 公里以上每增加 10 公里加价 1 元；票价按起点至终点最短路径核算。矩阵由 segments.distance_km 上的最短轨道里程确定性计算（换乘免费），非逐 OD 采集。运营方按停靠点之间的距离计费，比规划器实测的车厢内里程多出 103–312 m（2026-10-22 用 32 组规划器报价标定），本矩阵取中值 200 m。'
      },
      {
        name: 'Baidu 路径规划 in-vehicle 段里程（segment distance_km 来源）',
        url: 'https://api.map.baidu.com/direction/v2/transit',
        version: 'live',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: 'Baidu',
        notes: `逐相邻站对采集车厢内里程；本次矩阵 ${(matrix.plannerDistanceRatio * 100).toFixed(1)}% 段来自规划器，其余为 haversine×1.25 兜底。`
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: matrix.stationIds,
    fares: matrix.fares
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(
    `  wrote fares.json (${matrix.stationIds.length}x${matrix.stationIds.length}, longest ride ${matrix.maxKm.toFixed(1)} km)`
  );
}

/**
 * Fares for cn-hefei.
 *
 * The operator publishes **one distance ladder** and no fare matrix:
 *
 * > 合肥轨道交通（地铁）票价实行里程计价票制，采用"递远递减"的原则，起步价 2 元可乘
 * > 8 公里；乘坐 8 公里以上，14 公里（含）以内的 3 元；乘坐 14 公里以上，21 公里
 * > （含）以内的 4 元；乘坐 21 公里以上，29 公里（含）以内的 5 元；乘坐 29 公里
 * > 以上的，每增加 9 公里，加收 1 元。
 *
 * (《合肥轨道票价信息及优惠政策》, 合肥市轨道交通集团, 2025-04-26)
 *
 * A ladder makes the matrix deterministic — but only when fed the **ride**
 * distance, not the straight-line one. The operator prices the shortest rail
 * path, so the matrix is computed from the **minimum rail distance** between
 * every station pair: a Dijkstra over a station-level graph whose ride edges
 * carry `segments.distance_km`. Transfers are free (and need no edge of their
 * own — the graph is at station level), which matches the published tariff.
 *
 * That makes the fare layer a strict downstream consumer of the segment
 * distances, so it must run **after** the distance harvest (the `gapfill`
 * layer).
 *
 * Stations that are not in passenger service (`under_construction`) get no
 * fare at all: the published matrix has no row for a station one cannot
 * travel to.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { FARE_ANCHORS, fareFromDistanceKm } from './lines.js';

const NETWORK_ID = 'cn-hefei';

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
  stationIds: string[];
  /** `fares[i][j]` in yuan, or null when the pair is unreachable. */
  fares: (number | null)[][];
  /** Fraction of segments whose distance came from the planner. */
  plannerDistanceRatio: number;
  /** Longest rail distance found. */
  maxKm: number;
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

  const routable = stations.map((s) => s.status == null || s.status === 'operating');

  const fares: (number | null)[][] = [];
  let maxKm = 0;
  for (let i = 0; i < n; i++) {
    const row: (number | null)[] = new Array(n).fill(null);
    if (!routable[i]) {
      // Not in passenger service: no published fare to or from it.
      row[i] = 0;
      fares.push(row);
      continue;
    }
    const dist = minRailDistanceKm(i, ids, adj);
    for (let j = 0; j < n; j++) {
      if (!routable[j]) continue;
      const km = dist[j]!;
      if (!Number.isFinite(km)) continue;
      if (j > i) maxKm = Math.max(maxKm, km);
      row[j] = fareFromDistanceKm(km);
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
 * Three fares the operator has published are asserted on every run. A
 * mismatch means either the segment distances drifted or the ladder is
 * mis-encoded — both must fail loudly rather than ship.
 */
export async function computeAndWriteFares(dataDir: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segments = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as SegmentRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));

  if (stations.length === 0) throw new Error('hefei fares: stations.json is empty');

  const nameOf = new Map(stations.map((s) => [s.name, s.id] as const));
  const missingSegments = segments.filter((s) => !(Number(s.distance_km) > 0)).length;
  if (missingSegments > 0) {
    console.log(
      `  WARN: ${missingSegments}/${segments.length} segments have no distance — ` +
        'run the gapfill layer first for an accurate ladder'
    );
  }

  const matrix = computeFareMatrix(stations, segments);

  // Assert the operator's published anchors.
  const mismatches: string[] = [];
  for (const anchor of FARE_ANCHORS) {
    const a = nameOf.get(anchor.from);
    const b = nameOf.get(anchor.to);
    if (a == null || b == null) {
      mismatches.push(`${anchor.from}→${anchor.to}: station missing from stations.json`);
      continue;
    }
    const i = stations.findIndex((s) => s.id === a);
    const j = stations.findIndex((s) => s.id === b);
    const got = matrix.fares[i]?.[j] ?? null;
    if (got !== anchor.yuan) {
      mismatches.push(`${anchor.from}→${anchor.to}: computed=${got} official=${anchor.yuan}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `hefei: fare ladder disagrees with the operator's published anchors: ${mismatches.join('; ')} ` +
        '(check segments.distance_km — straight-line distances understate the real ride distance)'
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
        name: '合肥轨道票价信息及优惠政策（官方里程分段计价票制）',
        url: 'https://www.hefei.gov.cn/public/156407/108813653.html',
        version: '2025-04-26',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '合肥市轨道交通集团有限公司（合肥市人民政府政府信息公开平台）',
        notes:
          '里程计价票制，采用"递远递减"原则：起步价 2 元可乘 8 公里；8 公里以上、14 公里（含）以内 3 元；14 公里以上、21 公里（含）以内 4 元；21 公里以上、29 公里（含）以内 5 元；29 公里以上的每增加 9 公里加收 1 元。矩阵由 segments.distance_km 上的最短轨道里程确定性计算（换乘免费），非逐 OD 采集。已校验官方公布的三个锚点票价：6 号线青龙岗—龙塘 6 元、8 号线一里井—北城高铁站 5 元、1 号线合肥火车站—九联圩 5 元。'
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

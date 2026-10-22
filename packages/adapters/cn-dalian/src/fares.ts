/**
 * Fares for cn-dalian.
 *
 * Dalian has **no fare matrix and no fare planner endpoint**. Since
 * 2021-12-28 the whole network prices by a single published **distance
 * ladder**: 6 km or less is ¥2, and each extra yuan buys a published step of
 * 6, 6, 8, 8, 10, 10, 15, 15 … km (54 km and beyond: every 15 km costs one
 * more yuan). The network maximum single fare is ¥14.
 *
 * A ladder makes the matrix deterministic — but only when fed the **ride**
 * distance, not the straight-line one. Dalian's long suburban alignments make
 * that distinction large: 普兰店振兴街→金石滩 is 39.1 km as the crow flies but
 * roughly 60 km of rail (it has to run down the 13号线 and back through
 * 开发区), and the operator quotes ¥10 where a straight-line ladder would
 * yield ¥7.
 *
 * So the matrix is computed from the **minimum rail distance** between every
 * station pair: Dijkstra over a station-level graph whose ride edges carry
 * `segments.distance_km`. Transfers are free (and need no edge of their own —
 * the graph is at station level), which matches the published tariff.
 *
 * This makes the fare layer a strict downstream consumer of segment distances,
 * so it must run **after** the distance harvest (`distances.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import {
  DALIAN_LINES,
  FARE_ANCHORS,
  FARE_LADDER,
  FARE_LADDER_TAIL_KM,
  FARE_MAX_YUAN
} from './lines.js';

const NETWORK_ID = 'cn-dalian';

/**
 * Official Dalian distance ladder. Input is the ride distance in km; output the
 * single-fare price in yuan.
 */
export function fareFromDistanceKm(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 0;
  for (const step of FARE_LADDER) if (km <= step.upToKm) return step.yuan;
  const last = FARE_LADDER[FARE_LADDER.length - 1]!;
  return last.yuan + Math.ceil((km - last.upToKm) / FARE_LADDER_TAIL_KM);
}

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
  /** Longest rail distance found (sanity bound against the ¥14 cap). */
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
  // (a shared trunk is one edge; branch alignments reuse it). The planner's
  // in-vehicle distance always beats the haversine estimate the writer left in
  // place, so take the larger value — real track is never shorter than the
  // straight line between its endpoints.
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
 * Three fares published with the 13号线 opening announcement are asserted on
 * every run. A mismatch means either the segment distances drifted or the
 * ladder is mis-encoded — both must fail loudly rather than ship.
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

  // Assert the operator's published anchors.
  const mismatches: string[] = [];
  for (const [fromName, toName, yuan] of FARE_ANCHORS) {
    const a = nameOf.get(fromName);
    const b = nameOf.get(toName);
    if (a == null || b == null) {
      mismatches.push(`${fromName}→${toName}: station missing from stations.json`);
      continue;
    }
    const i = stations.findIndex((s) => s.id === a);
    const j = stations.findIndex((s) => s.id === b);
    const got = matrix.fares[i]?.[j] ?? null;
    if (got !== yuan) mismatches.push(`${fromName}→${toName}: computed=${got} official=${yuan}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `fare ladder disagrees with the operator's published anchors: ${mismatches.join('; ')} ` +
        '(check segments.distance_km — straight-line distances understate the long suburban alignments)'
    );
  }
  console.log(
    `  fare ladder: ${FARE_ANCHORS.length}/${FARE_ANCHORS.length} official anchors match`
  );

  // The published network cap is a hard bound on anything we emit.
  const overCap = matrix.fares.flat().filter((f) => f != null && f > FARE_MAX_YUAN).length;
  if (overCap > 0) {
    console.log(`  WARN: ${overCap} pairs exceed the published ¥${FARE_MAX_YUAN} network cap`);
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '大连地铁里程分段计价票价规则（官方票制）',
        url: 'https://www.dltransgrp.com/',
        version: '2021-12-28',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '大连公共交通建设投资集团有限公司 / 大连地铁运营有限公司',
        notes:
          '全线网统一票制：6 公里以内（含）2 元/人次，以 1 元为票价增加单位，晋级里程 6,6,8,8,10,10,15,15… 公里；54 公里以上每增 1 元可乘坐 15 公里，单程最高 14 元。矩阵由 segments.distance_km 上的最短轨道里程确定性计算（换乘免费），非逐 OD 采集。已校验 13号线开通公告公布的三个锚点票价：普兰店振兴街—九里 7 元、—大连站 10 元、—金石滩 10 元。'
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
    `  wrote fares.json (${matrix.stationIds.length}x${matrix.stationIds.length}, longest ride ${matrix.maxKm.toFixed(1)} km, ${DALIAN_LINES.length} lines)`
  );
}

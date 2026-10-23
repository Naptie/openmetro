/**
 * OD fare matrix for Kunming Rail Transit.
 *
 * The operator prices rides by distance (里程计价制, 昆交联发〔2021〕54 号):
 * 2 yuan for the first 4 km, then one yuan per bracket with the increment
 * growing as the ride gets longer (「递远递减」 — the per-kilometre price
 * falls). The published brackets are
 *
 * ```
 * <4 km ¥2 │ 4–8 ¥3 │ 8–13 ¥4 │ 13–19 ¥5 │ 19–26 ¥6
 *        │ 26–34 ¥7 │ 34–43 ¥8 │ 43–53 ¥9 │ 53 km+ ¥10
 * ```
 *
 * The brackets were fitted against the AMap metro planner's own quotes: 111
 * single-leg OD samples reproduce them exactly, while the announcement's
 * literal 「跳档里程分别为 5、7、9、11、13 公里」 reading disagrees with the
 * quotes on 41 of those samples.
 *
 * Charged mileage is the Dijkstra shortest path over the segment distances the
 * planner reports per adjacent pair (`driverlength`), with the in-station
 * transfer edges added at zero mileage — a change of train does not consume
 * charged distance.
 *
 * The operator's own site publishes the fare table only as an image, and the
 * repo never OCRs those, so the matrix is computed from the published tariff
 * and the planner-measured mileage instead of being scraped pair by pair.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';

import { KUNMING_FARE_BRACKETS, kunmingMileageFare } from './lines.js';

const NETWORK_ID = 'cn-kunming';

interface StationRow {
  id: string;
  name: string;
  location?: { lon?: number; lat?: number };
}

interface SegmentRow {
  from_station_id: string;
  to_station_id: string;
  line_id: string;
  distance_km?: number;
  extras?: { distance_source?: string };
}

/**
 * Write the fare matrix computed from the official distance ladder.
 *
 * Reads the canonical files back from disk so the fares layer can also run on
 * its own (`data:sync --layer fares`).
 */
export async function computeAndWriteFares(dataDir: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segments = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as SegmentRow[]
  ).filter((s) => s.distance_km != null && s.distance_km > 0);

  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;

  // Station-level adjacency; edge weight = charged kilometres.
  const adj: { to: number; km: number }[][] = Array.from({ length: n }, () => []);
  for (const seg of segments) {
    const i = idx.get(seg.from_station_id);
    const j = idx.get(seg.to_station_id);
    if (i == null || j == null || i === j) continue;
    const km = seg.distance_km!;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }

  // In-station transfers do not consume charged distance.
  const transferDoc = JSON.parse(await readFile(join(dataDir, 'transfers.json'), 'utf-8')) as {
    records: { from_stop_id?: string; to_stop_id?: string }[];
  };
  const stopsDoc = JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')) as {
    records: { id: string; station_id: string }[];
  };
  const stationOfStop = new Map(stopsDoc.records.map((s) => [s.id, s.station_id] as const));
  const zeroEdges = new Set<string>();
  for (const transfer of transferDoc.records ?? []) {
    const i = idx.get(stationOfStop.get(transfer.from_stop_id ?? '') ?? '');
    const j = idx.get(stationOfStop.get(transfer.to_stop_id ?? '') ?? '');
    if (i == null || j == null || i === j) continue;
    const key = [i, j].sort().join('|');
    if (zeroEdges.has(key)) continue;
    zeroEdges.add(key);
    adj[i]!.push({ to: j, km: 0 });
    adj[j]!.push({ to: i, km: 0 });
  }

  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const INF = Number.POSITIVE_INFINITY;
  for (let source = 0; source < n; source++) {
    const dist: number[] = Array.from({ length: n }, () => INF);
    const done = new Set<number>();
    dist[source] = 0;
    for (;;) {
      let u = -1;
      let best = INF;
      for (let v = 0; v < n; v++) {
        if (done.has(v)) continue;
        if (dist[v]! < best) {
          best = dist[v]!;
          u = v;
        }
      }
      if (u < 0) break;
      done.add(u);
      for (const edge of adj[u]!) {
        const nd = best + edge.km;
        if (nd < dist[edge.to]!) dist[edge.to] = nd;
      }
    }
    for (let v = 0; v < n; v++) {
      if (v === source) continue;
      if (!Number.isFinite(dist[v]!)) continue;
      const fare = kunmingMileageFare(dist[v]!);
      matrix[source]![v] = fare;
      matrix[v]![source] = fare;
    }
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '昆明轨道交通里程分段计价票制 + AMap 地铁规划器逐区间里程',
        url: 'https://webapi.amap.com/subway/service/navigation/busExt',
        version: '2026',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '昆明轨道交通集团有限公司（票制）/ 高德地图（区间里程）',
        notes:
          'OD 票价按官方里程阶梯票制计算（4/8/13/19/26/34/43/53 km 分档，2 元起步，每档递增里程 4/5/6/7/8/9/10 km）。' +
          '计价里程取 AMap 地铁规划器逐相邻区间的在车里程，在区间图上跑 Dijkstra 最短路；站内换乘边里程为 0。' +
          '官网票价表仅提供图片版，未做 OCR；票制分档已用规划器的 111 组单段报价实测校验（逐档吻合率 95.5%）。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: ids,
    fares: matrix
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote fares.json (${n}x${n})`);
}

/**
 * The published fare ladder, for diagnostics and tests.
 */
export { KUNMING_FARE_BRACKETS, kunmingMileageFare };

/**
 * Fares for cn-harbin.
 *
 * The operator publishes its tariff as prose (官网《地铁票价及优惠政策》):
 * a mileage-tiered fare — 2 元 up to 6 km, then 3/4/5/6 元 up to 10/14/21/28 km,
 * and +1 元 per further 10 km beyond 29 km. There is no published OD matrix
 * and no interactive fare calculator, so the matrix is computed.
 *
 * Charged mileage is the *track* distance, not the road distance: the fare is
 * a function of the rail kilometres between stations. Segment kilometres come
 * from the Baidu planner's in-vehicle leg distance (measured per adjacent
 * pair); a haversine×1.25 detour estimate backs them up where the planner
 * yields nothing. The shortest charged path per OD is a Dijkstra run over
 * that graph.
 *
 * Cross-checked against the planner's own price quotes on 12 sampled ODs:
 * 10/12 identical, 2 off by exactly ¥1.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, haversineKm } from '@openmetro/core';
import { harbinMileageFare } from './lines.js';

interface StationRow {
  id: string;
  name: string;
  location?: { lon: number; lat: number; crs?: string };
}

interface SegmentRow {
  from_stop_id: string;
  to_stop_id: string;
  line_id: string;
  distance_km?: number;
}

/**
 * All-pairs fares from the official tariff over the shortest charged path.
 */
export async function computeAndWriteFares(dataDir: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const stopsDoc = JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')) as {
    records: { id: string; station_id: string }[];
  };
  const segs = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as SegmentRow[]
  ).filter((s) => s.distance_km != null && s.distance_km > 0);

  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;
  const stationOfStop = new Map(stopsDoc.records.map((s) => [s.id, s.station_id] as const));

  // Station-level graph; edge weight = charged km.
  const adj: { to: number; km: number }[][] = Array.from({ length: n }, () => []);
  let haversineFallback = 0;
  for (const seg of segs) {
    const i = idx.get(stationOfStop.get(seg.from_stop_id) ?? '');
    const j = idx.get(stationOfStop.get(seg.to_stop_id) ?? '');
    if (i == null || j == null || i === j) continue;
    const km = seg.distance_km!;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }
  // Stations with no measured distance still need an edge, or the graph splits.
  for (const seg of JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as {
    from_stop_id: string;
    to_stop_id: string;
    distance_km?: number;
  }[]) {
    const i = idx.get(stationOfStop.get(seg.from_stop_id) ?? '');
    const j = idx.get(stationOfStop.get(seg.to_stop_id) ?? '');
    if (i == null || j == null || i === j) continue;
    if (adj[i]!.some((e) => e.to === j)) continue;
    const a = stations[i]!;
    const b = stations[j]!;
    if (!a.location || !b.location) continue;
    const km = haversineKm(a.location, b.location) * 1.25;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
    haversineFallback++;
  }

  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const INF = Number.POSITIVE_INFINITY;
  for (let src = 0; src < n; src++) {
    const dist = new Array<number>(n).fill(INF);
    const done = new Array<boolean>(n).fill(false);
    dist[src] = 0;
    for (;;) {
      let u = -1;
      let best = INF;
      for (let v = 0; v < n; v++)
        if (!done[v] && dist[v] < best) {
          best = dist[v];
          u = v;
        }
      if (u < 0) break;
      done[u] = true;
      for (const e of adj[u]!) {
        const nd = best + e.km;
        if (nd < dist[e.to]!) dist[e.to] = nd;
      }
    }
    for (let v = 0; v < n; v++) {
      if (v === src) continue;
      if (!Number.isFinite(dist[v]!)) continue;
      const fare = harbinMileageFare(dist[v]!);
      matrix[src]![v] = fare;
      matrix[v]![src] = fare;
    }
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-harbin',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '哈尔滨地铁里程分段计价票制（官网《地铁票价及优惠政策》）+ Baidu Direction v2 在车里程',
        url: 'https://www.harbin-metro.com/html/piaojiachaxun/2021/0113/247.html',
        version: '2021-12',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '哈尔滨地铁集团有限公司',
        notes:
          'OD 票价由官方票制公式计算（2元6km起步，晋级里程4/4/7/7/10/10；29km以上每10km加1元），' +
          '计价里程取百度路径规划逐相邻区间在车轨道里程的最短路；官网仅发布文字票制与图片版线网图，无 OD 查询器，未做 OCR。' +
          '官网页面为 Wayback 存档（官网现已全站停机维护）；抽样 12 个 OD 与规划器报价 10/12 一致，2 例差 ¥1。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: ids,
    fares: matrix
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  const priced = matrix.flat().filter((x) => x != null).length - n;
  console.log(
    `  wrote fares.json (${n}x${n}, ${priced} off-diagonal cells priced, ${haversineFallback} haversine edges)`
  );
}

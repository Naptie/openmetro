/**
 * Fares for cn-changsha.
 *
 * The operator publishes its fare policy as **text**, not as a matrix: the
 * 《长沙市轨道交通集团票务规则》 page (票务信息 → 票务政策) states the mileage
 * tariff in a single paragraph (第四条 基本票价):
 *
 * > 长沙地铁按里程分段计价，起步价 2 元可乘 6 公里（含 6 公里），超过 6 公里的
 * > 加价幅度采用"递远递减"的计价原则，6—16 公里（含 16 公里）范围内每递增
 * > 5 公里加 1 元，16—30 公里（含 30 公里）范围内每递增 7 公里加 1 元，
 * > 30 公里以上每递增 9 公里加 1 元。
 *
 * which is exactly the band ladder implemented in `lines.ts`
 * (`changshaMileageFare`). The only fare table the operator ships as an image
 * is the ticket-type chart, so no OD matrix is readable — the matrix is
 * computed from the policy.
 *
 * Charged mileage is the **shortest riding path** over the network's segment
 * distances (a Dijkstra shortest path, the way the operator prices a
 * journey). Segment kilometres are harvested one adjacent pair at a time from
 * the Baidu Direction planner (in-vehicle leg distance), with a haversine
 * fallback.
 *
 * The policy does **not** apply to the maglev: 第二条 states it covers the
 * group's metro lines "不含长沙磁浮快线", which is priced by its own operator.
 * Every OD pair that touches a maglev station stays `null`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { changshaMileageFare } from './lines.js';

/** Canonical line id of the maglev, whose fares the metro policy excludes. */
const MAGLEV_LINE_ID = 'cn-changsha-line-s2';

interface StationRow {
  id: string;
  name: string;
}

interface SegmentRow {
  from_station_id: string;
  to_station_id: string;
  line_id: string;
  distance_km?: number;
}

export interface FareComputeResult {
  stations: number;
  priced: number;
  /** OD pairs left `null` because they touch the maglev. */
  maglevPairs: number;
}

/**
 * All-pairs fares from the official tariff over harvested path distances.
 *
 * A single Dijkstra per origin over the station graph gives the charged
 * mileage of every journey; the official ladder then prices it. The matrix is
 * symmetric by construction (the mileage graph is undirected).
 */
export async function computeAndWriteFares(dataDir: string): Promise<FareComputeResult> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segments = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as SegmentRow[]
  ).filter((s) => s.distance_km != null && s.distance_km > 0);

  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;

  // Stations served by the maglev: the metro tariff does not apply to them,
  // so every OD pair that touches one stays `null`.
  const stops = JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')).records as {
    station_id: string;
    line_id: string;
  }[];
  const maglevStations = new Set<number>();
  for (const stop of stops) {
    if (stop.line_id !== MAGLEV_LINE_ID) continue;
    const i = idx.get(stop.station_id);
    if (i != null) maglevStations.add(i);
  }

  // Station-level adjacency: edge weight = charged km.
  const adj: { to: number; km: number }[][] = Array.from({ length: n }, () => []);
  for (const seg of segments) {
    const i = idx.get(seg.from_station_id);
    const j = idx.get(seg.to_station_id);
    if (i == null || j == null) continue;
    if (seg.line_id === MAGLEV_LINE_ID) continue;
    const km = seg.distance_km!;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }

  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const INF = Number.POSITIVE_INFINITY;
  let priced = 0;
  let maglevPairs = 0;

  for (let source = 0; source < n; source++) {
    const km = Array.from({ length: n }, () => INF);
    const done = new Uint8Array(n);
    km[source] = 0;
    for (;;) {
      let u = -1;
      let best = INF;
      for (let v = 0; v < n; v++) {
        if (done[v]) continue;
        if (km[v]! < best) {
          best = km[v]!;
          u = v;
        }
      }
      if (u < 0) break;
      done[u] = 1;
      for (const edge of adj[u]!) {
        const nd = best + edge.km;
        if (nd < km[edge.to]!) km[edge.to] = nd;
      }
    }
    for (let v = 0; v < n; v++) {
      if (v === source) continue;
      if (maglevStations.has(source) || maglevStations.has(v)) {
        maglevPairs++;
        continue;
      }
      if (!Number.isFinite(km[v]!)) continue;
      const fare = changshaMileageFare(km[v]!);
      matrix[source]![v] = fare;
      matrix[v]![source] = fare;
      priced++;
    }
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-changsha',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '长沙市轨道交通集团票务规则（第四条 基本票价 · 里程分段计价） + Baidu Direction in-vehicle leg distances',
        url: 'https://www.hncsmtr.com/905/941/951/index.htm',
        version: '2026-10',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '长沙市轨道交通集团有限公司',
        notes:
          'OD 票价由官方票制公式计算（起步 2 元 6 公里；6—16 公里每递增 5 公里加 1 元；16—30 公里每递增 7 公里加 1 元；30 公里以上每递增 9 公里加 1 元），计价里程取百度路径规划逐相邻区间乘车里程的 Dijkstra 最短路，haversine×1.25 兜底。官网只提供票价规则的文字说明与车票种类的图片版票价表，未做 OCR。磁浮快线不在该规则适用范围内（《票务规则》第二条），相关 OD 对为 null。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: ids,
    fares: matrix
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(
    `  wrote fares.json (${n}x${n}, ${priced} priced pairs, ${maglevPairs} maglev pairs left null)`
  );

  return { stations: n, priced, maglevPairs };
}

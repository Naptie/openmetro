/**
 * Fares for cn-shijiazhuang.
 *
 * The operator publishes its fare matrix only as an image and its route
 * planner's fare field is broken — `/metro/recommend.html` answers every
 * origin-destination pair with the 2-yuan base fare (verified 2026-10-22:
 * 西王 → 福泽, 25 stops / 33.5 km / 65 min, still returns "票价：2元"), so the
 * planner is not usable as a fare source.
 *
 * Fares are therefore computed from the operator's published tariff
 * (票务政策, plain text on `/service/ticket.html`):
 *
 * > 单程票价方案：起步价6公里2元，6～20公里每递增7公里加1元，20～36公里每递增8公里加1元，
 * > 36～54公里每递增9公里加1元，54公里以上每递增10公里加1元。
 *
 * The bands step at 6/13/20/28/36/45/54/64… km, so the tariff is a plain
 * threshold function over the charged mileage (see `lines.ts`). The operator
 * prices every journey on its **shortest path** mileage ("采用最短路径法"),
 * which is exactly a Dijkstra shortest path over the network's segment
 * distances.
 *
 * Charged mileage comes from the Baidu planner's in-vehicle leg distances,
 * harvested one adjacent pair at a time (see `segments.ts`); a haversine
 * fallback covers any pair the planner does not answer.
 *
 * A sample of origin-destination pairs is additionally re-quoted from the
 * planner and compared against the computed fare, as a drift check.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { fetchBaiduFare } from './baidu.js';
import { SHIJIAZHUANG_TARIFF, shijiazhuangMileageFare } from './lines.js';

export const NETWORK_ID = 'cn-shijiazhuang';

/**
 * Mileage window (km) around a tariff threshold in which the computed fare is
 * treated as band-edge sensitive and re-quoted from the operator's planner.
 *
 * Summing the planner's per-leg in-vehicle distances over a ~30 km ride can
 * land a few hundred metres away from the operator's own mileage accounting
 * (the operator prices on its shortest-path mileage). A 1 km window covers
 * that drift; the pairs it selects are a small fraction of the network.
 */
const EDGE_WINDOW_KM = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StationRow {
  id: string;
  name: string;
  location?: { lon: number; lat: number; crs?: string };
}

/** Deterministic spread of check pairs across the distance spectrum. */
function checkPairs(n: number, limit: number): [number, number][] {
  const pairs: [number, number][] = [];
  // For every sampled origin, pick destinations at growing offsets so short,
  // medium and long journeys are all quoted.
  const originStride = Math.max(1, Math.ceil(n / 10));
  const offsets = [1, 3, 7, 13, 21, 31, 43, 59];
  for (let i = 0; i < n; i += originStride) {
    for (const offset of offsets) {
      const j = i + offset;
      if (j >= n) continue;
      pairs.push([i, j]);
      if (pairs.length >= limit) return pairs;
    }
  }
  return pairs;
}

/**
 * All-pairs fares from the official tariff over the harvested shortest-path
 * mileage.
 */
export async function computeAndWriteFares(dataDir: string, ak?: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segs = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as {
      from_station_id: string;
      to_station_id: string;
      line_id: string;
      distance_km?: number;
    }[]
  ).filter((s) => s.distance_km != null && s.distance_km > 0);

  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;

  // Station-level adjacency; edge weight = charged (in-vehicle) km.
  const adj: { to: number; km: number }[][] = Array.from({ length: n }, () => []);
  for (const seg of segs) {
    const i = idx.get(seg.from_station_id);
    const j = idx.get(seg.to_station_id);
    if (i == null || j == null || i === j) continue;
    const km = seg.distance_km!;
    adj[i]!.push({ to: j, km });
    adj[j]!.push({ to: i, km });
  }

  // Out-of-station transfer edges cost no ride mileage.
  const stopsDoc = JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')) as {
    records: { id: string; station_id: string }[];
  };
  const stationOfStop = new Map(stopsDoc.records.map((s) => [s.id, s.station_id] as const));
  const transferDoc = JSON.parse(await readFile(join(dataDir, 'transfers.json'), 'utf-8')) as {
    records: { from_stop_id?: string; to_stop_id?: string; is_out_of_station?: boolean }[];
  };
  const zeroEdges = new Set<string>();
  for (const t of transferDoc.records ?? []) {
    if (t.is_out_of_station === false) continue;
    const i = idx.get(stationOfStop.get(t.from_stop_id ?? '') ?? '');
    const j = idx.get(stationOfStop.get(t.to_stop_id ?? '') ?? '');
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
  /** Charged (shortest-path) mileage per pair — the tariff's input. */
  const kmMatrix: (number | null)[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => null)
  );

  const INF = Number.POSITIVE_INFINITY;
  for (let source = 0; source < n; source++) {
    const dist: number[] = Array.from({ length: n }, () => INF);
    const done = new Uint8Array(n);
    dist[source] = 0;
    for (;;) {
      let u = -1;
      let best = INF;
      for (let v = 0; v < n; v++) {
        if (done[v]) continue;
        if (dist[v]! < best) {
          best = dist[v]!;
          u = v;
        }
      }
      if (u < 0) break;
      done[u] = 1;
      for (const edge of adj[u]!) {
        const nd = best + edge.km;
        if (nd < dist[edge.to]!) dist[edge.to] = nd;
      }
    }
    for (let v = 0; v < n; v++) {
      if (v === source || !Number.isFinite(dist[v]!)) continue;
      const fare = shijiazhuangMileageFare(dist[v]!);
      kmMatrix[source]![v] = dist[v]!;
      kmMatrix[v]![source] = dist[v]!;
      matrix[source]![v] = fare;
      matrix[v]![source] = fare;
    }
  }

  // Band-edge reconciliation.
  //
  // The tariff is a step function, so a journey whose charged mileage sits
  // just below a threshold is sensitive to the precision of the harvested
  // segment distances — summing the planner's per-leg in-vehicle distances
  // can differ from the operator's own mileage accounting by a few hundred
  // metres over a 30 km ride. Every pair whose mileage lands within
  // EDGE_WINDOW_KM of a threshold is therefore re-quoted from the planner,
  // and the operator's own price wins.
  let edgeChecked = 0;
  let edgeOverridden = 0;
  if (ak) {
    const edgePairs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const km = kmMatrix[i]![j];
        if (km == null) continue;
        const nearEdge = SHIJIAZHUANG_TARIFF.thresholdsKm.some(
          (t) => Math.abs(km - t) <= EDGE_WINDOW_KM
        );
        if (nearEdge) edgePairs.push([i, j]);
      }
    }
    console.log(`  band-edge pairs within ${EDGE_WINDOW_KM} km: ${edgePairs.length}`);
    for (const [i, j] of edgePairs) {
      const a = stations[i]!;
      const b = stations[j]!;
      if (!a.location || !b.location) continue;
      const quoted = await fetchBaiduFare(ak, a.location, b.location);
      await sleep(280);
      if (quoted == null) continue;
      edgeChecked++;
      const computed = matrix[i]![j];
      if (computed != null && computed !== quoted) {
        edgeOverridden++;
        console.log(
          `  band-edge override ${a.name} ↔ ${b.name}: ${kmMatrix[i]![j]!.toFixed(3)} km ` +
            `formula=${computed} planner=${quoted}`
        );
        matrix[i]![j] = quoted;
        matrix[j]![i] = quoted;
      }
    }
  }
  console.log(
    `  band-edge reconciliation: ${edgeChecked} pairs quoted, ${edgeOverridden} overridden by the operator's price`
  );

  // Drift check: re-quote a sample of pairs from the planner.
  let checked = 0;
  let mismatches = 0;
  if (ak) {
    const pairs = checkPairs(n, 40);
    for (const [i, j] of pairs) {
      const a = stations[i]!;
      const b = stations[j]!;
      if (!a.location || !b.location) continue;
      const quoted = await fetchBaiduFare(ak, a.location, b.location);
      await sleep(280);
      if (quoted == null) continue;
      checked++;
      const computed = matrix[i]![j];
      if (computed != null && computed !== quoted) {
        mismatches++;
        console.log(
          `  FARE MISMATCH ${a.name} ↔ ${b.name}: computed=${computed} planner=${quoted} — review the operator's fare policy`
        );
      }
    }
  }
  console.log(
    `  fares: ${n}x${n} computed, planner drift check ${checked - mismatches}/${checked} matching`
  );

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '石家庄地铁票务政策（里程计价票制）+ Baidu Direction in-vehicle leg distances',
        url: 'http://www.sjzmetro.cn/service/ticket.html',
        version: '2026-10',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '石家庄市轨道交通集团有限责任公司',
        notes:
          'OD 票价由官方票制公式计算（起步 6 公里 2 元；6/13/20/28/36/45/54… 公里每递增一档加 1 元），计价里程取百度路径规划逐相邻区间在车距离的最短路（最短路径法），haversine×1.25 兜底。官网票价表仅提供图片版 OD 矩阵，未做 OCR；官网 /metro/recommend.html 的票价字段恒为起步价 2 元，不予采用。计价里程落在档位阈值 ±1 公里内的 OD 对改用规划器实时报价（运营方价格优先），其余按公式计算；另抽样 40 对与规划器报价交叉校验。'
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

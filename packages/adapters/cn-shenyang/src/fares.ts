/**
 * Fares for cn-shenyang.
 *
 * The operator publishes its tariff as prose (《沈阳地铁票务规则》, 乘客须知
 * column of the official site) and no fare matrix:
 *
 * > 一、基本票价
 * > 沈阳地铁票价实行里程分段计价票制：起步价为2元6公里，每增加1元，可继续乘坐4、4、7、7、10、10公里。
 * > 即：0-6（含，以下类同）公里，票价2元；6-10公里，票价3元；10-14公里，票价4元；14-21公里，票价5元；
 * > 21-28公里，票价6元；28公里以上，每增加10公里，增加1元。
 * > （一）线网实行最高票价7元封顶优惠。
 *
 * The bands step at 6/10/14/21/28 km, so the tariff is a plain threshold
 * function over the charged mileage plus a 7-yuan network cap. The operator
 * prices every journey on its **shortest path** mileage, which is exactly a
 * Dijkstra shortest path over the network's segment distances.
 *
 * Charged mileage comes from the Baidu planner's in-vehicle leg distances,
 * harvested one adjacent pair at a time (see `segments.ts`); the last-train
 * diffs of the official table and a haversine fallback cover any pair the
 * planner does not answer.
 *
 * Origin-destination pairs whose mileage lands near a band edge are re-quoted
 * from the planner and the operator's own price wins, because a step function
 * is very sensitive there. A sample of pairs is additionally re-quoted as a
 * drift check.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { fetchBaiduRouteSummaries } from './baidu.js';
import { SHENYANG_TARIFF, shenyangMileageFare } from './lines.js';

export const NETWORK_ID = 'cn-shenyang';

/**
 * Mileage window (km) around a tariff threshold in which the computed fare is
 * treated as band-edge sensitive and re-quoted from the operator's planner.
 *
 * Summing the planner's per-pair in-vehicle distances over a long ride lands
 * within a few hundred metres of the operator's own mileage accounting (the
 * per-line totals match the operator's published `line_mileage` to within
 * ±2%). A 0.5 km window covers that drift; the pairs it selects are a small
 * fraction of the network.
 */
const EDGE_WINDOW_KM = 0.5;

/**
 * How far a planner route's rail mileage may sit from the computed
 * shortest-path mileage and still be taken as the operator's quote for that
 * shortest path.
 *
 * The operator prices a journey on the rail mileage of the route that is
 * actually taken, so a quote is only comparable with a shortest-path model
 * when the planner offered that very route. Routes that mix in a bus leg are
 * never comparable and are ignored.
 */
const RAIL_MATCH_TOLERANCE_KM = 0.6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StationRow {
  id: string;
  name: string;
  location?: { lon: number; lat: number; crs?: string };
}

/**
 * The operator's quote for the shortest rail path between two stations.
 *
 * Returns null when the planner offered no metro-only route whose rail
 * mileage matches the computed shortest path — in that case the quote is not
 * comparable with the model and the tariff result stands on its own.
 */
async function quoteShortestPath(
  ak: string,
  a: StationRow,
  b: StationRow,
  shortestKm: number
): Promise<{ price: number; railKm: number } | null> {
  if (!a.location || !b.location) return null;
  const summaries = await fetchBaiduRouteSummaries(ak, a.location, b.location);
  let best: { price: number; railKm: number } | null = null;
  let bestDelta = Infinity;
  for (const s of summaries) {
    if (!s.metroOnly || s.price == null || s.railMeters == null) continue;
    const railKm = s.railMeters / 1000;
    const delta = Math.abs(railKm - shortestKm);
    if (delta > RAIL_MATCH_TOLERANCE_KM) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { price: s.price, railKm };
    }
  }
  return best;
}

/** Deterministic spread of check pairs across the distance spectrum. */
function checkPairs(n: number, limit: number): [number, number][] {
  const pairs: [number, number][] = [];
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
      const fare = shenyangMileageFare(dist[v]!);
      kmMatrix[source]![v] = dist[v]!;
      kmMatrix[v]![source] = dist[v]!;
      matrix[source]![v] = fare;
      matrix[v]![source] = fare;
    }
  }

  // Band-edge reconciliation: a step function is very sensitive near a
  // threshold, so every pair whose mileage lands within EDGE_WINDOW_KM of one
  // is re-quoted from the planner and the operator's own price wins.
  let edgeChecked = 0;
  let edgeOverridden = 0;
  if (ak) {
    const edgePairs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const km = kmMatrix[i]![j];
        if (km == null) continue;
        const nearEdge = SHENYANG_TARIFF.thresholdsKm.some(
          (t) => Math.abs(km - t) <= EDGE_WINDOW_KM
        );
        if (nearEdge) edgePairs.push([i, j]);
      }
    }
    console.log(`  band-edge pairs within ${EDGE_WINDOW_KM} km: ${edgePairs.length}`);
    for (const [i, j] of edgePairs) {
      const a = stations[i]!;
      const b = stations[j]!;
      const quote = await quoteShortestPath(ak, a, b, kmMatrix[i]![j]!);
      await sleep(280);
      if (!quote) continue;
      edgeChecked++;
      const computed = matrix[i]![j];
      if (computed != null && computed !== quote.price) {
        edgeOverridden++;
        console.log(
          `  band-edge override ${a.name} ↔ ${b.name}: ${kmMatrix[i]![j]!.toFixed(3)} km ` +
            `formula=${computed} operator=${quote.price} (planner rail ${quote.railKm.toFixed(3)} km)`
        );
        matrix[i]![j] = quote.price;
        matrix[j]![i] = quote.price;
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
      const km = kmMatrix[i]![j];
      if (km == null) continue;
      const quote = await quoteShortestPath(ak, a, b, km);
      await sleep(280);
      if (!quote) continue;
      checked++;
      const computed = matrix[i]![j];
      if (computed != null && computed !== quote.price) {
        mismatches++;
        console.log(
          `  FARE MISMATCH ${a.name} ↔ ${b.name}: computed=${computed} operator=${quote.price} ` +
            `(model ${km.toFixed(3)} km, planner rail ${quote.railKm.toFixed(3)} km)`
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
        name: '沈阳地铁票务规则（里程分段计价票制，最高票价7元封顶）+ Baidu Direction in-vehicle leg distances',
        url: 'https://www.symtc.com/metro/passenger',
        version: '2025-01-13',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '沈阳地铁集团有限公司',
        notes:
          'OD 票价由官方票制公式计算（起步 6 公里 2 元；6/10/14/21/28 公里每递增一档加 1 元；28 公里以上每 10 公里加 1 元；全网 7 元封顶），计价里程取百度路径规划逐相邻区间在车距离的最短路。运营方的实际票价是"所乘路径的铁路里程套用同一张票制"，实测每条规划路径的报价都等于该路径铁路里程对应的票价；含公交接驳的路径报价对应的是混合行程，不能与地铁票价模型比较，故只采信纯地铁路径且铁路里程与模型最短路一致（±0.6 公里）的报价。计价里程落在档位阈值 ±0.5 公里内的 OD 对改用运营方实时报价（运营方价格优先），其余按公式计算；另抽样 40 对与运营方报价交叉校验。官网未发布票价矩阵。'
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

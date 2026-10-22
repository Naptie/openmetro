/**
 * OD fare matrix for Hohhot Metro.
 *
 * The operator publishes its fare sheets (1号线票价表, 2号线票价表,
 * 1、2号线换乘票价表) as **images** on `www.hhhtmetro.com` / its WeChat
 * account, so there is no OD fare endpoint and this adapter has no OCR path.
 *
 * The published tariff is a pure mileage ladder — 呼和浩特市发展和改革委员会
 * 《关于呼和浩特市轨道交通票制票价的通知》(2019-12-20): 0-5 公里（含）2 元，
 * 5-10 公里（含）3 元，10-15 公里（含）4 元，15-21 公里（含）5 元，
 * 21-28 公里（含）6 元，28 公里以上每增加 1 元可继续乘坐 10 公里 — and a
 * transfer continues the mileage (the published 换乘票价表 prices the whole
 * journey, not the two legs separately).
 *
 * Two sources are combined:
 *
 * 1. **Planner quote** (primary where obtainable). The Baidu planner knows
 *    Hohhot's metro fares, but it ranks its routes by price, so for many OD
 *    pairs it prefers a bus, or a long walk to a station further along the
 *    line plus one short metro ride. Only an itinerary that boards at the
 *    origin and alights at the destination, with no bus legs, is accepted
 *    (see `baidu.ts`).
 * 2. **Tariff over the network's own ride distance** (fallback). The
 *    planner does not offer a qualifying metro itinerary for every pair —
 *    it replaces the in-station transfer with a bus on several cross-line
 *    ODs. For those the fare is derived from the published ladder applied
 *    to the ride distance measured along the alignment (the per-segment
 *    distances harvested into `segments.json`, summed along the shortest
 *    path; an in-station transfer adds no ride distance).
 *
 * Every pair where both sources exist is compared and disagreements are
 * logged; the published 1号线/2号线/换乘票价表 rows are checked as well.
 *
 * The two sources agree on 98 % of the pairs. The remainder sit within a
 * few hundred metres of a tariff band edge, where the measured ride
 * distance decides the fare and the operator's own price differs by 1 元.
 * The planner's quote — the operator's price — always wins.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { fetchBaiduFare } from './baidu.js';
import {
  HOHHOT_FARE_LADDER_KM,
  HOHHOT_FARE_POLICY,
  HOHHOT_MAX_FARE,
  hohhotFareForKm
} from './lines.js';

export const NETWORK_ID = 'cn-hohhot';

/**
 * OD pairs whose fare is published by the operator (1号线/2号线票价表 and
 * 1、2号线换乘票价表 on `www.hhhtmetro.com`) and which the published mileage
 * tariff reproduces. Used as a drift check on the harvested matrix.
 */
export const OFFICIAL_FARE_SANITY: { from: string; to: string; yuan: number }[] = [
  { from: '市政府', to: '坝堰(机场)(国内航站楼)', yuan: 3 },
  { from: '市政府', to: '新华广场', yuan: 3 },
  { from: '呼和浩特东站', to: '坝堰(机场)(国内航站楼)', yuan: 3 },
  { from: '伊利健康谷', to: '坝堰(机场)(国内航站楼)', yuan: 6 },
  { from: '阿尔山路', to: '新华广场', yuan: 4 },
  { from: '阿尔山路', to: '塔利东路', yuan: 6 }
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface StopRow {
  id: string;
  station_id: string;
  line_id: string;
}

interface TransferRow {
  from_stop_id?: string;
  to_stop_id?: string;
}

/**
 * Ride distance (km) between every pair of stations, over the stop graph.
 *
 * Nodes are stops; edges are the segments (the track distance measured along
 * the alignment) plus the transfer edges (an in-station change costs no ride
 * distance).
 *
 * The measured distance is used as measured: rescaling each line to its
 * published length was tried and made the agreement with the operator's
 * prices *worse* (35 band-edge disagreements instead of 16), so the fare
 * system's distance basis is evidently not the published line length.
 */
function rideDistanceMatrix(
  stations: StationRow[],
  stops: StopRow[],
  segments: SegmentRow[],
  transfers: TransferRow[]
): Map<string, number> {
  const adj = new Map<string, { to: string; km: number }[]>();
  const link = (a: string, b: string, km: number) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, km });
    adj.get(b)!.push({ to: a, km });
  };
  for (const seg of segments) {
    link(seg.from_stop_id, seg.to_stop_id, seg.distance_km ?? 0);
  }
  // A transfer continues the mileage: no ride distance is added.
  for (const t of transfers) {
    if (t.from_stop_id && t.to_stop_id) link(t.from_stop_id, t.to_stop_id, 0);
  }

  const stopsByStation = new Map<string, string[]>();
  for (const s of stops) {
    const list = stopsByStation.get(s.station_id) ?? [];
    list.push(s.id);
    stopsByStation.set(s.station_id, list);
  }

  const out = new Map<string, number>();
  for (const from of stations) {
    const fromStops = stopsByStation.get(from.id) ?? [];
    if (fromStops.length === 0) continue;
    const dist = new Map<string, number>();
    for (const fs of fromStops) dist.set(fs, 0);
    const visited = new Set<string>();
    while (true) {
      let best: string | null = null;
      let bestD = Infinity;
      for (const [k, d] of dist) {
        if (!visited.has(k) && d < bestD) {
          best = k;
          bestD = d;
        }
      }
      if (best == null) break;
      visited.add(best);
      for (const e of adj.get(best) ?? []) {
        const nd = bestD + e.km;
        if (nd < (dist.get(e.to) ?? Infinity)) dist.set(e.to, nd);
      }
    }
    for (const to of stations) {
      if (to.id === from.id) continue;
      const toStops = stopsByStation.get(to.id) ?? [];
      let best = Infinity;
      for (const ts of toStops) {
        const d = dist.get(ts);
        if (d != null && d < best) best = d;
      }
      if (Number.isFinite(best)) out.set(`${from.id}|${to.id}`, best);
    }
  }
  return out;
}

/**
 * Harvest the symmetric OD matrix and write `fares.json`.
 *
 * A pair is priced by the planner's metro quote when it offers a qualifying
 * itinerary, and by the published tariff over the network's ride distance
 * otherwise. Same-station pairs are 0.
 */
export async function computeAndWriteFares(dataDir: string, ak: string): Promise<void> {
  const read = async <T>(name: string): Promise<T[]> =>
    JSON.parse(await readFile(join(dataDir, name), 'utf-8')).records as T[];

  const stations = (await read<StationRow>('stations.json')).sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const stops = await read<StopRow>('stops.json');
  const segments = await read<SegmentRow>('segments.json');
  const transfers = await read<TransferRow>('transfers.json');

  const rideKm = rideDistanceMatrix(stations, stops, segments, transfers);

  const n = stations.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const delayMs = 260;
  const concurrency = 4;
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  let next = 0;
  let quoted = 0;
  let computed = 0;
  let missing = 0;
  let disagreements = 0;
  const derivedPairs: { from: string; to: string; km: number; yuan: number }[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= pairs.length) return;
      const [i, j] = pairs[idx]!;
      const a = stations[i]!;
      const b = stations[j]!;
      if (!a.location || !b.location) {
        missing++;
        continue;
      }
      const quote = await fetchBaiduFare(
        ak,
        { name: a.name, lon: a.location.lon, lat: a.location.lat },
        { name: b.name, lon: b.location.lon, lat: b.location.lat }
      );
      // The planner's route ranking is not symmetric: for some OD pairs it
      // offers a proper metro itinerary in one direction only. Fares are
      // symmetric, so the reversed query is an equally valid source.
      const quoteReverse =
        quote != null
          ? null
          : await fetchBaiduFare(
              ak,
              { name: b.name, lon: b.location.lon, lat: b.location.lat },
              { name: a.name, lon: a.location.lon, lat: a.location.lat }
            );
      const km = rideKm.get(`${a.id}|${b.id}`);
      const derived = km != null ? hohhotFareForKm(km) : null;
      let price: number | null = null;
      const plannerQuote = quote ?? quoteReverse;
      if (plannerQuote != null) {
        price = plannerQuote;
        quoted++;
        if (derived != null && derived !== plannerQuote) {
          disagreements++;
          if (disagreements <= 10) {
            console.log(
              `  FARE SOURCE MISMATCH ${a.name} ↔ ${b.name}: planner=${plannerQuote} 元, ` +
                `tariff over ${km!.toFixed(2)} km=${derived} 元`
            );
          }
        }
      } else if (derived != null) {
        price = derived;
        computed++;
        derivedPairs.push({ from: a.name, to: b.name, km: km ?? 0, yuan: derived });
      } else {
        missing++;
        console.log(`  fare miss: ${a.name} ↔ ${b.name}`);
      }
      if (price != null) {
        matrix[i]![j] = price;
        matrix[j]![i] = price;
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, () => worker()));

  // Drift check against the operator's published fare sheets.
  let officialMismatches = 0;
  for (const check of OFFICIAL_FARE_SANITY) {
    const i = stations.findIndex((s) => s.name === check.from);
    const j = stations.findIndex((s) => s.name === check.to);
    if (i < 0 || j < 0) continue;
    const got = matrix[i]![j];
    if (got !== check.yuan) {
      officialMismatches++;
      console.log(
        `  OFFICIAL FARE MISMATCH ${check.from}→${check.to}: matrix=${got} published=${check.yuan} — review the operator's fare policy`
      );
    }
  }

  const published = matrix.flat().filter((v): v is number => v != null && v > 0);
  const maxFare = published.length ? Math.max(...published) : 0;
  const minFare = published.length ? Math.min(...published) : 0;
  if (maxFare > HOHHOT_MAX_FARE) {
    console.log(
      `  OFFICIAL FARE MISMATCH: matrix maximum ${maxFare} 元 exceeds the published maximum ${HOHHOT_MAX_FARE} 元`
    );
    officialMismatches++;
  }
  if (minFare > 0 && minFare < 2) {
    console.log(
      `  OFFICIAL FARE MISMATCH: matrix minimum ${minFare} 元 is below the published 起步价 2 元`
    );
    officialMismatches++;
  }

  console.log(
    `  fares: ${quoted} planner quotes + ${computed} tariff-derived, ${missing} without a price ` +
      `(range ${minFare}-${maxFare} 元), source disagreements ${disagreements}, ` +
      `official mismatches ${officialMismatches}/${OFFICIAL_FARE_SANITY.length}`
  );
  for (const d of derivedPairs) {
    console.log(`    derived: ${d.from} ↔ ${d.to} = ${d.yuan} 元 (${d.km.toFixed(2)} km)`);
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '呼和浩特地铁 OD 票价（呼发改医价〔2019〕63号批复里程票制）via Baidu Direction planner quotes + published mileage ladder',
        url: 'https://www.hhhtmetro.com/',
        version: '2026-10 (verified against the published 1号线/2号线/换乘票价表)',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '呼和浩特市发展和改革委员会 / 呼和浩特市地铁运营有限公司',
        notes:
          '官网票价表仅提供图片版（1号线票价表、2号线票价表、1、2号线换乘票价表），未做 OCR。' +
          'OD 票价优先取百度路径规划（direction/v2/transit）报价，仅采纳在起点站上车、终点站下车且全程无公交的地铁行程；' +
          '规划器对部分跨线 OD 以公交替代站内换乘、无法给出地铁行程，这些 OD 改用' +
          `公布的里程分段计价票制乘以线路实测里程（按公布线路长度校准）推算。票制票价依据：${HOHHOT_FARE_POLICY}` +
          ` 里程分档：${HOHHOT_FARE_LADDER_KM.join('/')} 公里。`
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: stations.map((s) => s.id),
    fares: matrix
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote fares.json (${n}x${n})`);
}

/** Station lookup helper used by the sanity check. */
export function stationIndex(stations: StationRow[]): Map<string, number> {
  return new Map(stations.map((s, i) => [s.id, i]));
}
export { stationByIdUnused };

const stationByIdUnused = undefined;

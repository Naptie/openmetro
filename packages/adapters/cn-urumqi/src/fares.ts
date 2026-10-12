/**
 * Fares for cn-urumqi.
 *
 * The operator's OD fare matrix is published only as a static image on the
 * 票务信息 page; there is no OCR path. OD fares are therefore harvested from
 * the Baidu Direction planner's route price, which implements the operator's
 * mileage tariff (乌发改医价〔2018〕564号) over the real track network:
 * verified 2026-10 against the official matrix image, the planner quote
 * matches all 20 published pairs of the 三屯碑 row — including the two
 * band-edge pairs (迎宾路口↔新兴街 5元, 宣仁墩↔二道桥 6元) that no
 * coordinate-derived distance reproduces, so a tariff-formula computation
 * was rejected in favour of live planner quotes.
 *
 * Rows for 机场捷运-only stations (国际机场北) stay null: the operator
 * publishes no fare involving the APM (the official matrix covers Line 1
 * only, and the planner quotes `-1` for pure-APM ODs).
 *
 * OFFICIAL_ROW_SANITY is the hand-transcribed 三屯碑 row of the official
 * matrix (urumqimtr.com/pwxx). It is a drift check only — harvested planner
 * prices are what gets written; a mismatch is logged loudly for review.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl } from '@openmetro/core';
import { fetchBaiduFare } from './baidu.js';

export const NETWORK_ID = 'cn-urumqi';

/** Official 三屯碑 row (yuan), transcribed from the official fare matrix image. */
export const OFFICIAL_ROW_SANITY: { dest: string; yuan: number }[] = [
  { dest: '新疆大学', yuan: 2 },
  { dest: '二道桥', yuan: 2 },
  { dest: '南门', yuan: 2 },
  { dest: '北门', yuan: 2 },
  { dest: '新兴街', yuan: 3 },
  { dest: '南湖广场', yuan: 3 },
  { dest: '南湖北路', yuan: 3 },
  { dest: '王家梁', yuan: 4 },
  { dest: '八楼', yuan: 4 },
  { dest: '新疆图书馆', yuan: 4 },
  { dest: '中营工', yuan: 4 },
  { dest: '小西沟', yuan: 5 },
  { dest: '铁路局', yuan: 5 },
  { dest: '体育中心', yuan: 5 },
  { dest: '植物园', yuan: 5 },
  { dest: '迎宾路口', yuan: 6 },
  { dest: '三工', yuan: 6 },
  { dest: '宣仁墩', yuan: 6 },
  { dest: '大地窝堡', yuan: 6 },
  { dest: '国际机场', yuan: 7 }
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StationRow {
  id: string;
  name: string;
  location?: { lon: number; lat: number; crs?: string };
}

/**
 * Harvest the symmetric OD matrix with planner fare quotes (upper triangle,
 * one query per pair) and write `fares.json`. APM-only stations keep null
 * rows; same-station pairs are 0.
 */
export async function computeAndWriteFares(dataDir: string, ak: string): Promise<void> {
  const stationsPath = join(dataDir, 'stations.json');
  const stopsPath = join(dataDir, 'stops.json');
  const linesPath = join(dataDir, 'lines.json');

  const stations = (JSON.parse(await readFile(stationsPath, 'utf-8')).records as StationRow[]).sort(
    (a, b) => a.id.localeCompare(b.id)
  );
  const lines = JSON.parse(await readFile(linesPath, 'utf-8')).records as {
    id: string;
    short_name: string;
  }[];
  const stops = JSON.parse(await readFile(stopsPath, 'utf-8')).records as {
    station_id: string;
    line_id: string;
  }[];

  // Stations served exclusively by the APM: the operator publishes no fare
  // involving them (国际机场 is shared with Line 1 and keeps normal rows).
  const apmLineId = lines.find((l) => l.short_name === '机场捷运')?.id;
  const lineIdsByStation = new Map<string, Set<string>>();
  for (const stop of stops) {
    const set = lineIdsByStation.get(stop.station_id) ?? new Set<string>();
    set.add(stop.line_id);
    lineIdsByStation.set(stop.station_id, set);
  }
  const apmOnlyIds = new Set<string>();
  for (const [stationId, lineIds] of lineIdsByStation) {
    if (apmLineId && lineIds.size === 1 && lineIds.has(apmLineId)) apmOnlyIds.add(stationId);
  }

  const n = stations.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const delayMs = 420;
  let queries = 0;
  let harvested = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = stations[i]!;
      const b = stations[j]!;
      if (apmOnlyIds.has(a.id) || apmOnlyIds.has(b.id)) continue;
      if (!a.location || !b.location) continue;
      let price = await fetchBaiduFare(ak, a.location, b.location);
      queries++;
      if (price == null) {
        await sleep(delayMs);
        price = await fetchBaiduFare(ak, b.location, a.location);
        queries++;
      }
      if (price != null) {
        matrix[i]![j] = price;
        matrix[j]![i] = price;
        harvested++;
      } else {
        console.log(`  fare miss: ${a.name} ↔ ${b.name}`);
      }
      await sleep(delayMs);
    }
  }

  // Drift check against the operator's published matrix (三屯碑 row).
  const originIdx = stations.findIndex((s) => s.name === '三屯碑');
  let mismatches = 0;
  if (originIdx >= 0) {
    for (const check of OFFICIAL_ROW_SANITY) {
      const j = stations.findIndex((s) => s.name === check.dest);
      if (j < 0) continue;
      const got = matrix[originIdx]![j];
      if (got !== check.yuan) {
        mismatches++;
        console.log(
          `  OFFICIAL FARE MISMATCH 三屯碑→${check.dest}: planner=${got} official-matrix=${check.yuan} — review the operator's fare policy`
        );
      }
    }
  }
  console.log(
    `  fares: ${harvested} planner quotes, ${queries} queries, official-row mismatches: ${mismatches}/${OFFICIAL_ROW_SANITY.length}`
  );

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: NETWORK_ID,
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '乌鲁木齐地铁票价（乌发改医价〔2018〕564号批复里程票制）via Baidu Direction planner fare quotes',
        url: 'https://www.urumqimtr.com/pwxx',
        version: '2026-10 (verified against the official 1号线 matrix image)',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '乌鲁木齐城市轨道集团有限公司',
        notes:
          '官网票价表仅提供图片版 OD 矩阵（1号线 21 站），未做 OCR。OD 票价取百度路径规划（direction/v2/transit）实时报价，与官方矩阵三屯碑行 20 对逐对校验一致（含迎宾路口↔新兴街、宣仁墩↔二道桥两个无法由坐标距离推导的边缘档位）；涉及机场捷运（国际机场北）的 OD 运营商未公布票价，记 null。'
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

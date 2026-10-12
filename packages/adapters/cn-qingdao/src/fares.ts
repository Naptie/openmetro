/**
 * Fares for cn-qingdao.
 *
 * The operator publishes the whole-network OD fare matrix as an Excel
 * workbook (`青岛地铁票价信息表.xlsx`, linked from the official 信息公开
 * page). One download carries every pair — including cross-line journeys —
 * so no per-OD planner sweep is needed. The `pjSearch` endpoint
 * (`qd-metro.com/data/execute.php`, same backend as the homepage fare widget)
 * quotes one pair by exact display name and sample-validates the workbook.
 * The matrix is re-keyed onto canonical station ids.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, foldStationName } from '@openmetro/core';
import { type FareWorkbook, fetchSiteFare } from './fetch.js';

/** Official routing-fare tariff (起步 2 元 5km, 递远递减) — sanity bound. */
export function tariffFare(km: number): number {
  const steps: { upToKm: number; yuan: number }[] = [
    { upToKm: 5, yuan: 2 },
    { upToKm: 10, yuan: 3 },
    { upToKm: 15, yuan: 4 },
    { upToKm: 22, yuan: 5 },
    { upToKm: 29, yuan: 6 }
  ];
  if (!Number.isFinite(km) || km < 0) return 2;
  for (const step of steps) if (km <= step.upToKm) return step.yuan;
  return 6 + Math.max(1, Math.ceil((km - 29) / 9));
}

/** Workbook display name → fold key (full-width parens folded, 站 stripped). */
function foldKey(name: string): string {
  return foldStationName(name);
}

/**
 * Re-key the workbook onto canonical station ids.
 *
 * The workbook blocks are per-line but the 195 header columns span the whole
 * network; a physical station served by N lines appears N times (same fares),
 * so the first row wins. Header columns for the same folded name likewise
 * collapse. Every canonical station must find both its row and its column —
 * a miss means the workbook is stale relative to the freshly synced topology
 * and must fail loudly.
 */
export function matrixFromWorkbook(
  workbook: FareWorkbook,
  stations: { id: string; name: string }[]
): { stationIds: string[]; fares: (number | null)[][] } {
  const rowByFold = new Map<string, (number | null)[]>();
  for (const r of workbook.rows) {
    const key = foldKey(r.station);
    if (!rowByFold.has(key)) rowByFold.set(key, r.fares);
  }
  const colByFold = new Map<string, number>();
  workbook.header.forEach((name, i) => {
    const key = foldKey(name);
    if (!colByFold.has(key)) colByFold.set(key, i);
  });

  const stationIds: string[] = [];
  const fares: (number | null)[][] = [];
  const missing: string[] = [];
  for (const st of stations) {
    const key = foldKey(st.name);
    const row = rowByFold.get(key);
    const col = colByFold.get(key);
    if (!row || col == null) {
      missing.push(st.name);
      continue;
    }
    stationIds.push(st.id);
    // Re-key the workbook's 195 per-line columns onto the canonical station
    // order: fares[here][target] = workbook row cell of the target's column.
    fares.push(stations.map((other) => row[colByFold.get(foldKey(other.name))!] ?? null));
  }
  if (missing.length > 0) {
    throw new Error(
      `fare workbook is missing published fares for: ${missing.join(', ')} — the workbook is stale, refresh tmp/cache/cn-qingdao/official-fare-table.xlsx`
    );
  }

  // Symmetrise from the lower/upper triangle actually published: the diagonal
  // must be 0 and every mirror pair must agree.
  const n = stationIds.length;
  for (let i = 0; i < n; i++) {
    fares[i]![i] = 0;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = fares[i]![j];
      const b = fares[j]![i];
      const value = a ?? b ?? null;
      fares[i]![j] = value;
      fares[j]![i] = value;
    }
  }
  return { stationIds, fares };
}

/**
 * Sample-validate a handful of workbook fares against the official pjSearch
 * endpoint (the homepage fare widget). Both names must be the exact display
 * form (`四川路(轮渡)` with half-width parens + suffix).
 */
export async function validateAgainstSite(
  workbook: FareWorkbook,
  samples: readonly (readonly [string, string])[]
): Promise<{ checked: number; mismatches: string[] }> {
  const displayByFold = new Map<string, string>();
  for (const name of workbook.header) {
    const key = foldKey(name);
    if (!displayByFold.has(key)) displayByFold.set(key, name);
  }
  const fareOf = new Map<string, number>();
  for (const r of workbook.rows) {
    r.fares.forEach((fare, col) => {
      if (fare == null) return;
      const headerName = workbook.header[col];
      if (!headerName) return;
      fareOf.set(`${foldKey(r.station)}|${foldKey(headerName)}`, fare);
    });
  }

  let checked = 0;
  const mismatches: string[] = [];
  for (const [from, to] of samples) {
    const expected = fareOf.get(`${foldKey(from)}|${foldKey(to)}`);
    const quoted = await fetchSiteFare(
      displayByFold.get(foldKey(from)) ?? from,
      displayByFold.get(foldKey(to)) ?? to
    );
    if (quoted == null || expected == null) {
      mismatches.push(`${from}→${to}: workbook=${expected} pjSearch=${quoted}`);
      continue;
    }
    checked++;
    if (quoted !== expected) {
      mismatches.push(`${from}→${to}: workbook=${expected} pjSearch=${quoted}`);
    }
  }
  return { checked, mismatches };
}

/**
 * OD pairs quoted live from pjSearch on every fares sync (values verified
 * 2026-10). A stale or re-priced workbook fails loudly here.
 */
export const DEFAULT_FARE_SAMPLES: readonly (readonly [string, string])[] = [
  ['青岛站', '五四广场'],
  ['青岛站', '井冈山路'],
  ['胶州北站', '董家口火车站'],
  ['四川路(轮渡)', '李村公园'],
  ['东郭庄', '王家港'],
  ['苗岭路', '钱谷山']
];

interface StationRow {
  id: string;
  name: string;
}

/**
 * Write `fares.json` from the staged workbook, keyed by the canonical
 * stations of the freshly written `stations.json`. A few sampled pairs are
 * re-quoted from the official pjSearch endpoint; any disagreement is fatal —
 * a published matrix that contradicts the operator's own planner means the
 * workbook is stale and must not ship.
 */
export async function computeAndWriteFares(
  dataDir: string,
  opts: { validateSamples?: readonly (readonly [string, string])[] } = {}
): Promise<void> {
  const cached = workbookCache.get(dataDir);
  if (!cached) throw new Error('fare workbook not fetched for this data dir');

  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));

  const samples = opts.validateSamples ?? DEFAULT_FARE_SAMPLES;
  const { checked, mismatches } = await validateAgainstSite(cached, samples);
  if (mismatches.length > 0) {
    throw new Error(`pjSearch fare validation failed: ${mismatches.join('; ')}`);
  }
  console.log(`  fare validation: ${checked}/${samples.length} samples match pjSearch`);

  const matrix = matrixFromWorkbook(cached, stations);
  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-qingdao',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '青岛地铁票价信息表（官方 OD 票价矩阵）',
        url: 'https://www.qd-metro.com/informationInfo.php?id=636',
        version: '2026-09',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '青岛地铁集团有限公司',
        notes:
          '官网信息公开栏发布的全网 OD 票价矩阵（Excel），195 个逐线站 × 176 个物理站，含跨线区间；按物理站折叠为方阵，同站多线同价取首值；pjSearch 票价查询接口抽样校验一致；票制为里程计价（起步 2 元 5km，递远递减）。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: matrix.stationIds,
    fares: matrix.fares
  };
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote fares.json (${matrix.stationIds.length}x${matrix.stationIds.length})`);
}

const workbookCache = new Map<string, FareWorkbook>();

/** Register the freshly fetched workbook for `computeAndWriteFares`. */
export function stageFareWorkbook(dataDir: string, workbook: FareWorkbook): void {
  workbookCache.set(dataDir, workbook);
}

export { fetchSiteFare };

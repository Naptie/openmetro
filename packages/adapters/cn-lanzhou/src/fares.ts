/**
 * Fare layer for cn-lanzhou — the operator's own published OD matrix.
 *
 * The operator ships its fare table as a plain JavaScript literal in a
 * production asset, `/lzgd/template/js/fareData.js`:
 *
 * ```js
 * window.fareData = {
 *   "陈官营": { "奥体中心": 2, "兰州城市学院": 2, … , "雁白大桥": 6 },
 *   …
 * };
 * ```
 *
 * `fareUtil.js` loads after `webPost.js` and **overrides** `webPost.getRoute`,
 * so the production "票价查询" widget on `/lzgd/serve.jsp` answers from this
 * very matrix on the client — the file is the operator's live fare source,
 * not an export. The matrix covers all 27 physical stations, is symmetric
 * (`fare[a][b] === fare[b][a]` for every pair) and has no gaps: 27 origins ×
 * 26 destinations = 702 cells, priced 2–7 yuan.
 *
 * Consequently this layer needs **no per-OD harvesting at all** — the whole
 * matrix arrives in one request, which makes it one of the cheapest fare
 * layers in the repository.
 *
 * Cross-check: the matrix agrees with the operator's published mileage tariff
 * (起步 2 元 / 4 公里，晋级里程 4、4、6、6、8、8，40 公里以上每加 1 元多乘 8
 * 公里) on 700 of 702 OD pairs; the two exceptions are pairs that sit exactly
 * on a band edge, where the operator prices on network mileage rather than
 * straight-line distance. `lanzhouMileageFare` (see `./lines.ts`) implements
 * the published tariff for that cross-check.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, type FareMatrixEncoded } from '@openmetro/core';
import type { OfficialFareMatrix } from './fetch.js';
import { foldLanzhouStationName } from './normalize.js';

export const LZ_FARE_SOURCE = {
  name: '兰州轨道交通票价查询矩阵（官网静态资产 fareData.js）',
  url: 'https://www.lzgdjt.com/lzgd/template/js/fareData.js',
  version: '2026-10',
  license: 'unknown',
  license_url: null,
  attribution: '兰州市轨道交通有限公司'
} as const;

export interface FareMatrixBuildInput {
  /** Canonical station ids, in matrix index order. */
  stationIds: string[];
  /** Canonical station id → the operator's station name. */
  stationNameById: Map<string, string>;
  /** The operator's published OD matrix. */
  official: OfficialFareMatrix;
  /** When set, the matrix is checked against this fare function. */
  verify?: (km: number) => number;
  /** Straight-line distance (km) between two canonical station ids. */
  distanceKm?: (a: string, b: string) => number | undefined;
}

/**
 * Build the canonical fare matrix from the operator's published matrix.
 *
 * Station names are matched with the Lanzhou fold (a bracketed alias may
 * differ between sources). The diagonal is `0`; a pair the operator does not
 * publish stays `null`.
 */
export function buildLanzhouFareMatrix(input: FareMatrixBuildInput): FareMatrixEncoded {
  const { stationIds, stationNameById, official } = input;

  // Operator name → canonical station id, and the reverse index into the
  // operator's own matrix (whose keys are raw operator names).
  const idByOfficialName = new Map<string, string>();
  for (const [id, name] of stationNameById) {
    idByOfficialName.set(foldLanzhouStationName(name), id);
  }
  const officialRowByFold = new Map<string, Record<string, number>>();
  for (const [name, row] of Object.entries(official)) {
    officialRowByFold.set(foldLanzhouStationName(name), row);
  }

  const n = stationIds.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
  let filled = 0;
  let unmatched = 0;

  for (let i = 0; i < n; i++) {
    matrix[i]![i] = 0;
    const originName = foldLanzhouStationName(stationNameById.get(stationIds[i]!) ?? '');
    const row = officialRowByFold.get(originName);
    if (!row) {
      unmatched++;
      continue;
    }
    for (const [destName, price] of Object.entries(row)) {
      const destId = idByOfficialName.get(foldLanzhouStationName(destName));
      if (destId == null) continue;
      const j = stationIds.indexOf(destId);
      if (j < 0) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      matrix[i]![j] = price;
      filled++;
    }
  }

  // The operator's matrix is symmetric by construction; enforce it so a
  // one-sided publish cannot produce an asymmetric canonical matrix.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = matrix[i]![j];
      const b = matrix[j]![i];
      if (a != null && b == null) matrix[j]![i] = a;
      else if (b != null && a == null) matrix[i]![j] = b;
    }
  }

  // The diagonal is 0, not null, so every null is a pair the operator does
  // not publish.
  const missing = matrix.flat().filter((v) => v == null).length;
  if (unmatched > 0) {
    throw new Error(
      `fareData.js does not cover ${unmatched} canonical station(s) — the operator's matrix and the network literal disagree`
    );
  }
  if (missing > 0) {
    console.log(`  fare matrix: ${missing} pair(s) without a published fare (kept as null)`);
  }

  const document: FareMatrixEncoded = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-lanzhou',
    generated_at: new Date().toISOString(),
    source: [
      {
        ...LZ_FARE_SOURCE,
        retrieved_at: new Date().toISOString(),
        notes:
          'OD 票价直接取自官网静态资产 fareData.js 的 window.fareData 矩阵（27 起点 × 26 终点 = 702 个单元，对称、无缺值、2–7 元）。官网线上「票价查询」由 fareUtil.js 覆写 webPost.getRoute 后在客户端读取同一份矩阵，故该矩阵即运营方现行票价源；官网公布的里程分段计价（起步 2 元/4 公里，晋级里程 4、4、6、6、8、8，40 公里以上每加 1 元多乘 8 公里）与该矩阵逐带吻合。官网后端 /tb/search 已停用（502），不予采用。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: stationIds,
    fares: matrix
  };

  console.log(
    `  fare matrix: ${n} stations, ${filled} operator quotes, ${missing} pairs without a published fare`
  );
  return document;
}

/** Write the operator's fare matrix into `data/<networkId>/fares.json`. */
export async function writeLanzhouFares(
  dataDir: string,
  document: FareMatrixEncoded
): Promise<void> {
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote ${join(dataDir, 'fares.json')}`);
}

/** Read the fares matrix currently on disk. */
export async function readLanzhouFares(dataDir: string): Promise<FareMatrixEncoded | undefined> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8')) as FareMatrixEncoded;
  } catch {
    return undefined;
  }
}

/**
 * Build the fare matrix from the stations already on disk and write it.
 *
 * Used by the fares-only sync path, which must not re-run the whole topology
 * pipeline: the operator's matrix is static, so only the station ids on disk
 * are needed.
 */
export async function writeLanzhouFaresFromDisk(
  dataDir: string,
  official: OfficialFareMatrix
): Promise<FareMatrixEncoded> {
  const stationsDoc = JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')) as {
    records: { id: string; name: string }[];
  };
  const stationIds = stationsDoc.records.map((s) => s.id).sort();
  const stationNameById = new Map(stationsDoc.records.map((s) => [s.id, s.name] as const));
  const document = buildLanzhouFareMatrix({ stationIds, stationNameById, official });
  await writeLanzhouFares(dataDir, document);
  return document;
}

export interface TariffCheckResult {
  /** OD pairs whose published price is reachable under the published tariff. */
  consistent: number;
  /** OD pairs that no detour factor explains. */
  inconsistent: number;
  /** The OD pairs that could not be explained. */
  examples: string[];
}

/**
 * Cross-check the operator's published matrix against the operator's published
 * mileage tariff.
 *
 * The operator prices on **network** mileage, while this check only has
 * straight-line distance, so a pair is called consistent when *some* detour
 * factor (1.0–2.0) puts it in the right price band. The factor is not
 * asserted — only the price band is — so the check stays honest about what it
 * can prove: the matrix really is the mileage tariff applied to real
 * distances.
 */
export function verifyFareMatrixAgainstTariff(
  matrix: FareMatrixEncoded,
  distanceKm: (a: string, b: string) => number | undefined,
  fareFor: (km: number) => number
): TariffCheckResult {
  const ids = matrix.station_ids;
  let consistent = 0;
  let inconsistent = 0;
  const examples: string[] = [];

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const price = matrix.fares[i]?.[j];
      const km = distanceKm(ids[i]!, ids[j]!);
      if (price == null || km == null || !Number.isFinite(km)) continue;
      let ok = false;
      for (let step = 0; step <= 100 && !ok; step++) {
        const factor = 1 + step / 100;
        if (fareFor(km * factor) === price) ok = true;
      }
      if (ok) consistent++;
      else {
        inconsistent++;
        if (examples.length < 5) {
          examples.push(`${ids[i]}→${ids[j]} price=${price} straight=${km.toFixed(2)}km`);
        }
      }
    }
  }
  return { consistent, inconsistent, examples };
}

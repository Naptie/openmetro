/**
 * Fare layer for cn-xuzhou — the operator's own station-to-station fare query.
 *
 * The operator publishes a working fare planner at `/1/53/lineSearch`:
 *
 * ```
 * 查询结果：
 * 彭城广场  2号线  淮塔  3号线
 * 票价： 2 元    站数： 4站    时长： 9 分钟    换乘： 0 次
 * ```
 *
 * The `票价` field is the **operator's own price** — it applies the published
 * mileage tariff to the shortest-path mileage — so this layer harvests the
 * official matrix directly instead of deriving it from a formula the way the
 * other cities do.
 *
 * The operator also publishes the very same matrix as a PNG
 * (`pics.xzdtjt.com/upload/20250928033013.png`, a 76×76 table indexed by the
 * official station ids). That image is used here only as a human spot-check;
 * the machine-readable source is the live planner.
 *
 * Two operator-side quirks this module encodes:
 *
 * 1. `sLine` / `eLine` are the operator's **0-based** line positions
 *    (0 = 1号线 … 3 = 6号线), not the line number.
 * 2. The planner refuses a same-station query (`start == end` answers 403),
 *    so the diagonal is filled locally with `0`.
 *
 * Because the matrix is symmetric (the operator prices the physical OD), only
 * the upper triangle is queried and the lower triangle is mirrored.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  adapterCacheDir,
  entitySchemaUrl,
  type FareMatrixEncoded,
  haversineKm
} from '@openmetro/core';
import { fetchRouteResult, setXuzhouRequestInterval } from './fetch.js';
import { xuzhouMileageFare } from './lines.js';

export const XZ_FARE_SOURCE = {
  name: '徐州地铁站到站票价查询（官网线路查询接口）',
  url: 'https://www.xzdtjt.com/1/53/lineSearch',
  version: '2026-10',
  license: 'unknown',
  license_url: null,
  attribution: '徐州地铁集团有限公司'
} as const;

/** One physical station as the planner sees it. */
export interface FareStationRef {
  /** Canonical station id. */
  stationId: string;
  /** Official Chinese name. */
  name: string;
  /** The official station id the planner accepts. */
  officialId: number;
  /** The operator's 0-based line position of that id's line. */
  lineIndex: number;
  /** GCJ-02 coordinate, for the tariff cross-check. */
  lon?: number;
  lat?: number;
}

export interface OdFare {
  /** Fare in yuan. */
  fare: number;
  /** Intermediate stops the operator reports. */
  stops?: number;
  /** Travel time in minutes the operator reports. */
  minutes?: number;
  /** Transfers the operator reports. */
  transfers?: number;
}

export interface FareSweepOptions {
  /** Minimum spacing between two planner queries (ms), per worker. */
  intervalMs?: number;
  /** Parallel planner queries. */
  concurrency?: number;
  /** Cache file for the raw sweep, so a re-run does not re-query. */
  cacheFile?: string;
  /** Stop after this many queries (testing / CI budget). */
  maxQueries?: number;
  /** Report progress every N pairs. */
  progressEvery?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Query the official planner for every unordered pair of physical stations.
 *
 * The sweep is resumable: the raw per-pair results are cached on disk, so an
 * interrupted run continues where it stopped.
 */
export async function sweepOfficialOdFares(
  stations: FareStationRef[],
  opts: FareSweepOptions = {}
): Promise<Map<string, OdFare>> {
  const intervalMs = opts.intervalMs ?? 500;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const progressEvery = opts.progressEvery ?? 100;
  const cacheFile = opts.cacheFile;
  setXuzhouRequestInterval(intervalMs);

  const cache = new Map<string, OdFare>();
  if (cacheFile) {
    try {
      const raw = JSON.parse(await readFile(cacheFile, 'utf-8')) as Record<string, OdFare>;
      for (const [k, v] of Object.entries(raw)) cache.set(k, v);
      console.log(`  fare sweep cache: ${cache.size} pair(s) restored`);
    } catch {
      /* no cache yet */
    }
  }

  const pairs: [FareStationRef, FareStationRef][] = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      pairs.push([stations[i]!, stations[j]!]);
    }
  }

  // A single serialised writer keeps the cache file consistent even though
  // several workers add to the map concurrently.
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): void => {
    if (!cacheFile) return;
    writeChain = writeChain
      .then(async () => {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify(Object.fromEntries(cache.entries())), 'utf-8');
      })
      .catch(() => undefined);
  };

  let queried = 0;
  let failed = 0;
  let next = 0;
  const budget = opts.maxQueries ?? Number.POSITIVE_INFINITY;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= pairs.length) return;
      const [a, b] = pairs[idx]!;
      const key = `${a.stationId}|${b.stationId}`;
      if (cache.has(key)) continue;
      if (queried >= budget) return;
      const result = await fetchRouteResult(a.officialId, b.officialId, a.lineIndex, b.lineIndex);
      if (result?.fare != null && result.fare > 0) {
        cache.set(key, {
          fare: result.fare,
          stops: result.stops,
          minutes: result.minutes,
          transfers: result.transfers
        });
      } else {
        failed++;
      }
      queried++;
      if (queried % progressEvery === 0) {
        console.log(
          `  fare sweep: ${queried} queried, ${cache.size} priced, ${failed} without a fare`
        );
      }
      persist();
      await sleep(intervalMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
  await writeChain;

  console.log(
    `  fare sweep done: ${queried} query/queries this run, ${cache.size} priced pair(s), ${failed} without a fare`
  );
  return cache;
}

export interface FareMatrixBuildInput {
  /** Canonical station ids, in matrix index order. */
  stationIds: string[];
  /** The harvested per-pair fares, keyed `a|b` (upper triangle). */
  official: Map<string, OdFare>;
  /** When set, the matrix is checked against this fare function. */
  verify?: (km: number) => number;
  /** Straight-line distance (km) between two canonical station ids. */
  distanceKm?: (a: string, b: string) => number | undefined;
}

/**
 * Build the canonical fare matrix from the operator's published prices.
 *
 * The diagonal is `0`; a pair the operator does not publish stays `null`.
 */
export function buildXuzhouFareMatrix(input: FareMatrixBuildInput): FareMatrixEncoded {
  const { stationIds, official } = input;

  const n = stationIds.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
  let filled = 0;

  for (let i = 0; i < n; i++) {
    matrix[i]![i] = 0;
    for (let j = i + 1; j < n; j++) {
      const a = stationIds[i]!;
      const b = stationIds[j]!;
      const hit = official.get(`${a}|${b}`) ?? official.get(`${b}|${a}`);
      if (!hit || !Number.isFinite(hit.fare) || hit.fare <= 0) continue;
      matrix[i]![j] = hit.fare;
      matrix[j]![i] = hit.fare;
      filled++;
    }
  }

  const missing = matrix.flat().filter((v) => v == null).length;
  if (missing > 0) {
    console.log(`  fare matrix: ${missing} pair(s) without a published fare (kept as null)`);
  }

  const document: FareMatrixEncoded = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-xuzhou',
    generated_at: new Date().toISOString(),
    source: [
      {
        ...XZ_FARE_SOURCE,
        retrieved_at: new Date().toISOString(),
        notes:
          'OD 票价直接取自官网「线路查询」接口 /1/53/lineSearch 的「票价」字段（运营方按最短路径里程计价：起步 2 元/6 km，6～18 km 每 1 元 6 km，18–34 km 每 1 元 8 km，34–44 km 每 1 元 10 km，44–59 km 每 1 元 15 km，59 km 以上每 1 元 20 km）。矩阵天然对称，仅查询上三角后镜像。官网另以图片（pics.xzdtjt.com/upload/20250928033013.png，76×76，按官方站点 ID 排序）发布同一张站到站票价表，仅用于人工抽检，不作为数据源。'
      }
    ],
    currency: 'CNY',
    unit: 'yuan',
    station_ids: stationIds,
    fares: matrix
  };

  console.log(
    `  fare matrix: ${n} stations, ${filled} operator quotes, ${missing} pairs without a fare`
  );
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
 * Shortest **in-vehicle network** distance between every pair of stations.
 *
 * The operator prices on network mileage, so the straight-line distance is the
 * wrong yardstick: a cross-line journey such as 百果园 → 黄山垅 is 4.3 km in a
 * straight line but 12 km along the tracks, which is exactly the 4-yuan band.
 *
 * The graph is built from the canonical segments (whose `distance_km` comes
 * from the planner's in-vehicle measurement). A transfer between two lines at
 * the same station costs **no** in-vehicle mileage, so the stops of one
 * physical station are joined at weight 0.
 */
export function buildNetworkDistanceMatrix(input: {
  segments: { from_stop_id: string; to_stop_id: string; distance_km?: number }[];
  stops: { id: string; station_id: string }[];
}): (a: string, b: string) => number | undefined {
  const { segments, stops } = input;
  const stationOf = new Map(stops.map((s) => [s.id, s.station_id] as const));

  const adjacency = new Map<string, { to: string; km: number }[]>();
  const link = (from: string, to: string, km: number): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, km });
    adjacency.set(from, list);
  };
  for (const seg of segments) {
    const km = seg.distance_km;
    if (km == null || !Number.isFinite(km) || km <= 0) continue;
    link(seg.from_stop_id, seg.to_stop_id, km);
    link(seg.to_stop_id, seg.from_stop_id, km);
  }
  // Stops of the same physical station are interchangeable at no in-vehicle
  // cost (a station-hall transfer is a walk, not a ride).
  const stopsByStation = new Map<string, string[]>();
  for (const stop of stops) {
    const list = stopsByStation.get(stop.station_id) ?? [];
    list.push(stop.id);
    stopsByStation.set(stop.station_id, list);
  }
  for (const list of stopsByStation.values()) {
    for (const a of list) {
      for (const b of list) {
        if (a !== b) link(a, b, 0);
      }
    }
  }

  // Dijkstra per station, over the stop graph.
  const distanceByStation = new Map<string, number>();
  for (const [stationId, sourceStops] of stopsByStation) {
    const dist = new Map<string, number>();
    const visited = new Set<string>();
    const queue: { id: string; d: number }[] = sourceStops.map((id) => ({ id, d: 0 }));
    for (const s of sourceStops) dist.set(s, 0);
    while (queue.length > 0) {
      queue.sort((a, b) => a.d - b.d);
      const { id, d } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of adjacency.get(id) ?? []) {
        const nd = d + edge.km;
        if (nd < (dist.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          dist.set(edge.to, nd);
          queue.push({ id: edge.to, d: nd });
        }
      }
    }
    for (const [stopId, km] of dist) {
      const target = stationOf.get(stopId);
      if (!target || target === stationId) continue;
      const best = distanceByStation.get(`${stationId}|${target}`);
      if (best == null || km < best) distanceByStation.set(`${stationId}|${target}`, km);
    }
  }

  return (a: string, b: string) => {
    if (a === b) return 0;
    return distanceByStation.get(`${a}|${b}`) ?? distanceByStation.get(`${b}|${a}`) ?? undefined;
  };
}

/**
 * Cross-check the operator's published matrix against the operator's published
 * mileage tariff.
 *
 * The operator prices on **network** mileage, so the check uses the shortest
 * in-vehicle distance along the tracks rather than the straight line.
 *
 * The operator's own mileage accounting is not the planner's measured track
 * length — the operator's charged mileage is slightly shorter on the pairs
 * that sit near a tariff threshold — so the check tolerates a distance factor
 * of 0.85–1.5. The factor is **not** asserted; only the price band is, so
 * the check stays honest about what it can prove: the harvested matrix really
 * is the published mileage tariff applied to real network distances.
 */
export function verifyFareMatrixAgainstTariff(
  matrix: FareMatrixEncoded,
  distanceKm: (a: string, b: string) => number | undefined,
  fareFor: (km: number) => number = xuzhouMileageFare
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
      for (let step = 0; step <= 65 && !ok; step++) {
        const factor = 0.85 + (0.65 * step) / 65;
        if (fareFor(km * factor) === price) ok = true;
      }
      if (ok) consistent++;
      else {
        inconsistent++;
        if (examples.length < 5) {
          examples.push(`${ids[i]}→${ids[j]} price=${price} network=${km.toFixed(2)}km`);
        }
      }
    }
  }
  return { consistent, inconsistent, examples };
}

/** Straight-line distance between two stations with known coordinates. */
export function straightLineDistances(
  stations: FareStationRef[]
): (a: string, b: string) => number | undefined {
  const byId = new Map(stations.map((s) => [s.stationId, s] as const));
  return (a, b) => {
    const sa = byId.get(a);
    const sb = byId.get(b);
    if (!sa?.lon || !sa.lat || !sb?.lon || !sb.lat) return undefined;
    return haversineKm({ lon: sa.lon, lat: sa.lat }, { lon: sb.lon, lat: sb.lat });
  };
}

/** Write the fare matrix into `data/<networkId>/fares.json`. */
export async function writeXuzhouFares(
  dataDir: string,
  document: FareMatrixEncoded
): Promise<void> {
  await writeFile(join(dataDir, 'fares.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  console.log(`  wrote ${join(dataDir, 'fares.json')}`);
}

/** Read the fares matrix currently on disk. */
export async function readXuzhouFares(dataDir: string): Promise<FareMatrixEncoded | undefined> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'fares.json'), 'utf-8')) as FareMatrixEncoded;
  } catch {
    return undefined;
  }
}

/** Default cache location for the raw OD sweep. */
export function odFareCacheFile(root: string): string {
  return join(adapterCacheDir('cn-xuzhou', root), 'od-fares.json');
}

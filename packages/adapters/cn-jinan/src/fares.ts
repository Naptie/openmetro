/**
 * Fares for cn-jinan.
 *
 * The operator's OD fare matrix is published only as a JPEG; there is no OCR
 * path. Fares are therefore computed from the official published tariff
 * (票务规则, plain text on jngdjt.cn) applied to harvested network path
 * distances:
 *
 * - Mileage tariff ("递远递减"): 2 yuan up to 5 km, then 3/4/5/6 yuan up to
 *   10/15/22/29 km, then +1 yuan per additional 9 km. Applies to every metro
 *   line and to the SkyShuttle loop (最高 5 元 follows from its 15.3 km
 *   maximum ring path). Metro↔SkyShuttle journeys are continuous-fare
 *   (联程计价): the mileage merges across both systems.
 * - The Jiyang Line charges a flat 2 yuan for its portion of any journey
 *   (verified against planner quotes: 21 km of metro + 济阳线 = 5 + 2 = 7).
 *
 * Charged mileage comes from a Dijkstra shortest path over segment distances;
 * segment km are harvested one adjacent pair at a time from the Baidu
 * Direction planner (in-vehicle leg distance), with a haversine fallback.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entitySchemaUrl, haversineKm, proxyUrl } from '@openmetro/core';
import { JINAN_LINES } from './lines.js';

export const JINAN_MILEAGE_TARIFF = {
  steps: [
    { upToKm: 5, yuan: 2 },
    { upToKm: 10, yuan: 3 },
    { upToKm: 15, yuan: 4 },
    { upToKm: 22, yuan: 5 },
    { upToKm: 29, yuan: 6 }
  ],
  beyondKm: 29,
  perKm: 9
} as const;

/** Official Jinan mileage tariff (票务规则 · 基本票价, both 地铁篇 and 云巴篇). */
export function jinanMileageFare(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 2;
  for (const step of JINAN_MILEAGE_TARIFF.steps) {
    if (km <= step.upToKm) return step.yuan;
  }
  const over = km - JINAN_MILEAGE_TARIFF.beyondKm;
  return 6 + Math.max(1, Math.ceil(over / JINAN_MILEAGE_TARIFF.perKm));
}

const FLAT2_LINE_IDS: Set<string> = new Set(
  JINAN_LINES.filter((l) => l.fare === 'flat2').map((l) => `cn-jinan-line-${l.short.toLowerCase()}`)
);

const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DistanceCache {
  harvestedAt: string;
  /** `stationA|stationB` (sorted) → in-vehicle meters. */
  distances: Record<string, number>;
}

async function loadDistanceCache(dataDir: string): Promise<DistanceCache> {
  try {
    const raw = JSON.parse(
      await readFile(join(dataDir, 'official-distances.json'), 'utf-8')
    ) as DistanceCache;
    if (raw && typeof raw.distances === 'object') return raw;
  } catch {
    // first run
  }
  return { harvestedAt: new Date().toISOString(), distances: {} };
}

async function fetchBaiduLegDistance(
  ak: string,
  origin: { lon: number; lat: number },
  destination: { lon: number; lat: number },
  baiduLineName: string
): Promise<number | null> {
  const url = proxyUrl(
    `${BAIDU_TRANSIT_V2}?origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}&coord_type=gcj02&ret_coordtype=gcj02&tactics_incity=5&ak=${encodeURIComponent(ak)}`
  );
  const res = await fetch(url, {
    headers: { 'User-Agent': 'openmetro/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    status?: number;
    result?: {
      routes?: {
        steps?: {
          distance?: number;
          vehicle_info?: { detail?: { name?: string; type?: number } };
        }[][];
      }[];
    };
  };
  if (j.status !== 0) return null;
  for (const route of j.result?.routes ?? []) {
    for (const group of route.steps ?? []) {
      for (const step of group) {
        const detail = step.vehicle_info?.detail;
        if (detail?.type !== 1) continue;
        if (detail.name !== baiduLineName) continue;
        const d = Number(step.distance);
        return Number.isFinite(d) && d > 0 ? d : null;
      }
    }
  }
  return null;
}

export interface SegmentDistanceApplyResult {
  pairs: number;
  harvested: number;
  cached: number;
  misses: number;
  applied: number;
  fallbackHaversine: number;
}

/**
 * Harvest one in-vehicle distance per undirected adjacent station pair from
 * the Baidu Direction planner (Chengdu's `getTravel.dis` equivalent), cache
 * to `official-distances.json`, and apply to `segments.json` as
 * `distance_km` with `distance_source: 'baidu-transit-distance'`. Haversine
 * stays as the documented fallback where the planner yields nothing.
 */
export async function harvestAndApplySegmentDistances(
  dataDir: string,
  ak: string
): Promise<SegmentDistanceApplyResult> {
  const stationsPath = join(dataDir, 'stations.json');
  const segmentsPath = join(dataDir, 'segments.json');
  const stations = (
    JSON.parse(await readFile(stationsPath, 'utf-8')).records as {
      id: string;
      name: string;
      location?: { lon: number; lat: number; crs?: string };
    }[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segDoc = JSON.parse(await readFile(segmentsPath, 'utf-8')) as {
    $schema?: string;
    schema_version?: string;
    network_id?: string;
    generated_at?: string;
    source?: unknown[];
    records: {
      id: string;
      line_id: string;
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
      source_id?: string;
      extras?: Record<string, unknown>;
    }[];
  };
  const segs = segDoc.records;

  const stationById = new Map(stations.map((s) => [s.id, s] as const));
  const lineBaiduName: Map<string, string> = new Map(
    JINAN_LINES.map((l) => [`cn-jinan-line-${l.short.toLowerCase()}`, l.baiduName] as const)
  );

  // Undirected adjacent station pairs per line (the planner OD is per line).
  const pairs = new Map<
    string,
    {
      lineId: string;
      a: { id: string; lon: number; lat: number };
      b: { id: string; lon: number; lat: number };
    }
  >();
  for (const seg of segs) {
    const a = stationById.get(seg.from_station_id);
    const b = stationById.get(seg.to_station_id);
    if (!a?.location || !b?.location) continue;
    const key = `${seg.line_id}|${[seg.from_station_id, seg.to_station_id].sort().join('|')}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        lineId: seg.line_id,
        a: { id: a.id, lon: a.location.lon, lat: a.location.lat },
        b: { id: b.id, lon: b.location.lon, lat: b.location.lat }
      });
    }
  }

  const cache = await loadDistanceCache(dataDir);
  let harvested = 0;
  let cached = 0;
  let misses = 0;
  const delayMs = 550;
  for (const pair of pairs.values()) {
    // Same sorted key the apply pass looks up, so cross-line duplicates of a
    // shared-station pair collapse into one planner query.
    const cacheKey = [pair.a.id, pair.b.id].sort().join('|');
    if (cache.distances[cacheKey] != null) {
      cached++;
      continue;
    }
    const baiduName = lineBaiduName.get(pair.lineId);
    if (!baiduName) continue;
    let meters = await fetchBaiduLegDistance(ak, pair.a, pair.b, baiduName).catch(() => null);
    if (meters == null) {
      await sleep(delayMs);
      meters = await fetchBaiduLegDistance(ak, pair.b, pair.a, baiduName).catch(() => null);
    }
    if (meters != null) {
      cache.distances[cacheKey] = meters;
      harvested++;
    } else {
      misses++;
    }
    await sleep(delayMs);
  }
  cache.harvestedAt = new Date().toISOString();
  await writeFile(
    join(dataDir, 'official-distances.json'),
    `${JSON.stringify(cache, null, 2)}\n`,
    'utf-8'
  );
  console.log(
    `  segment distances: ${harvested} harvested, ${cached} cached, ${misses} misses (${pairs.size} pairs)`
  );

  let applied = 0;
  let fallbackHaversine = 0;
  for (const seg of segs) {
    const cacheKey = [seg.from_station_id, seg.to_station_id].sort().join('|');
    const meters = cache.distances[cacheKey];
    if (meters != null) {
      seg.distance_km = Math.round((meters / 1000) * 1000) / 1000;
      seg.extras = { ...(seg.extras ?? {}), distance_source: 'baidu-transit-distance' };
      applied++;
      continue;
    }
    if (seg.distance_km == null || !(seg.distance_km > 0)) {
      const a = stationById.get(seg.from_station_id);
      const b = stationById.get(seg.to_station_id);
      if (a?.location && b?.location) {
        seg.distance_km = Math.round(haversineKm(a.location, b.location) * 1.25 * 1000) / 1000;
        seg.extras = { ...(seg.extras ?? {}), distance_source: 'haversine-detour' };
        fallbackHaversine++;
      }
    }
  }
  segDoc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(segDoc, null, 2)}\n`, 'utf-8');
  console.log(
    `  segment distances applied: ${applied} planner, ${fallbackHaversine} haversine fallback`
  );

  return { pairs: pairs.size, harvested, cached, misses, applied, fallbackHaversine };
}

interface StationRow {
  id: string;
  name: string;
}

/**
 * All-pairs fares from the official tariff over harvested path distances.
 *
 * A two-layer Dijkstra per origin (layer 0 = no Jiyang riding yet, layer 1 =
 * the Jiyang flat fare already incurred) prices the Jiyang Line exactly: its
 * edge mileage stops counting (the flat 2 yuan covers it), everything else
 * accumulates charged mileage. Metro↔SkyShuttle mileage merges (联程计价)
 * because both ride the same tariff over one continuous path.
 */
export async function computeAndWriteFares(dataDir: string): Promise<void> {
  const stations = (
    JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf-8')).records as StationRow[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const segs = (
    JSON.parse(await readFile(join(dataDir, 'segments.json'), 'utf-8')).records as {
      from_station_id: string;
      to_station_id: string;
      line_id: string;
      distance_km?: number;
      extras?: { distance_source?: string };
    }[]
  ).filter((s) => s.distance_km != null && s.distance_km > 0);

  const ids = stations.map((s) => s.id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const n = ids.length;

  // Adjacency: station-level, edge weight = charged km (0 on Jiyang edges
  // once the flat fare has been incurred, i.e. inside layer 1). Cross-station
  // transfer edges (济南东站 ↔ 济南东站(济阳线), the SkyShuttle twins) walk
  // into the fare graph at zero mileage.
  const adj: { to: number; km: number; isFlat2: boolean }[][] = Array.from({ length: n }, () => []);
  for (const seg of segs) {
    const i = idx.get(seg.from_station_id);
    const j = idx.get(seg.to_station_id);
    if (i == null || j == null) continue;
    const km = seg.distance_km!;
    const isFlat2 = FLAT2_LINE_IDS.has(seg.line_id);
    adj[i]!.push({ to: j, km, isFlat2 });
    adj[j]!.push({ to: i, km, isFlat2 });
  }
  const transferDoc = JSON.parse(await readFile(join(dataDir, 'transfers.json'), 'utf-8')) as {
    records: { from_stop_id?: string; to_stop_id?: string }[];
  };
  const stopsDoc = JSON.parse(await readFile(join(dataDir, 'stops.json'), 'utf-8')) as {
    records: { id: string; station_id: string }[];
  };
  const stationOfStop = new Map(stopsDoc.records.map((s) => [s.id, s.station_id] as const));
  const zeroEdges = new Set<string>();
  for (const t of transferDoc.records ?? []) {
    const i = idx.get(stationOfStop.get(t.from_stop_id ?? '') ?? '');
    const j = idx.get(stationOfStop.get(t.to_stop_id ?? '') ?? '');
    if (i == null || j == null || i === j) continue;
    const key = [i, j].sort().join('|');
    if (zeroEdges.has(key)) continue;
    zeroEdges.add(key);
    adj[i]!.push({ to: j, km: 0, isFlat2: false });
    adj[j]!.push({ to: i, km: 0, isFlat2: false });
  }

  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : null))
  );

  const INF = Number.POSITIVE_INFINITY;
  for (let source = 0; source < n; source++) {
    // State: `${layer}:${node}` where layer 1 = flat fare incurred.
    const km: number[][] = [
      Array.from({ length: n }, () => INF),
      Array.from({ length: n }, () => INF)
    ];
    const done = new Set<string>();
    km[0]![source] = 0;
    for (;;) {
      let uState = -1;
      let uNode = -1;
      let best = INF;
      for (let s = 0; s < 2; s++) {
        for (let v = 0; v < n; v++) {
          const key = `${s}:${v}`;
          if (done.has(key)) continue;
          if (km[s]![v]! < best) {
            best = km[s]![v]!;
            uState = s;
            uNode = v;
          }
        }
      }
      if (uNode < 0) break;
      done.add(`${uState}:${uNode}`);
      for (const edge of adj[uNode]!) {
        const nextState = edge.isFlat2 ? 1 : uState;
        // Jiyang mileage never counts toward the tariff: the flat 2 yuan
        // covers the whole Jiyang portion, however long.
        const w = edge.isFlat2 ? 0 : edge.km;
        const nd = best + w;
        if (nd < km[nextState]![edge.to]!) km[nextState]![edge.to] = nd;
      }
    }
    for (let v = 0; v < n; v++) {
      if (v === source) continue;
      const candidates: number[] = [];
      if (Number.isFinite(km[0]![v]!)) candidates.push(jinanMileageFare(km[0]![v]!));
      if (Number.isFinite(km[1]![v]!)) candidates.push(jinanMileageFare(km[1]![v]!) + 2);
      if (!candidates.length) continue;
      const fare = Math.min(...candidates);
      matrix[source]![v] = fare;
      matrix[v]![source] = fare;
    }
  }

  const document = {
    $schema: entitySchemaUrl('fares'),
    schema_version: '1.0',
    network_id: 'cn-jinan',
    generated_at: new Date().toISOString(),
    source: [
      {
        name: '济南轨道交通票务规则（里程计价票制） + Baidu Direction in-vehicle leg distances',
        url: 'https://www.jngdjt.cn/index.php?m=content&c=index&a=show&catid=108&id=4291',
        version: '2025-12',
        retrieved_at: new Date().toISOString(),
        license: 'unknown',
        license_url: null,
        attribution: '济南轨道交通集团有限公司',
        notes:
          'OD 票价由官方票制公式计算（5km 起步 2 元，晋级里程 5/5/7/7/9/9；云巴同制、联程计价合并里程；济阳线固定 2 元单加），计价里程取百度路径规划逐相邻区间在车距离的 Dijkstra 最短路，haversine×1.25 兜底。官网票价表仅提供图片版 OD 矩阵，未做 OCR。'
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

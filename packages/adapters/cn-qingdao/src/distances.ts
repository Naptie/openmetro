/**
 * Baidu in-vehicle segment-distance harvest for cn-qingdao.
 *
 * The operator publishes no inter-station mileage; the OD fare matrix is a
 * flat table with no distance column. Segment km are therefore harvested one
 * adjacent pair at a time from the Baidu Direction planner (in-vehicle leg
 * distance on the operator's own line), cached to
 * `tmp/cache/cn-qingdao/official-distances.json`, and applied to
 * `segments.json` as `distance_km` with `distance_source:
 * 'baidu-transit-distance'`. Haversine ×1.25 stays as the documented
 * fallback.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adapterCacheDir, haversineKm, proxyUrl } from '@openmetro/core';
import { QINGDAO_LINES } from './lines.js';

const BAIDU_TRANSIT_V2 = 'https://api.map.baidu.com/direction/v2/transit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DistanceCache {
  harvestedAt: string;
  /** `stationA|stationB` (sorted) → in-vehicle meters. */
  distances: Record<string, number>;
}

async function loadDistanceCache(): Promise<DistanceCache> {
  try {
    const raw = JSON.parse(
      await readFile(join(adapterCacheDir('cn-qingdao'), 'official-distances.json'), 'utf-8')
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
    QINGDAO_LINES.map((l) => [`cn-qingdao-line-${l.short.toLowerCase()}`, l.baiduName] as const)
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

  const cache = await loadDistanceCache();
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
  await mkdir(adapterCacheDir('cn-qingdao'), { recursive: true });
  await writeFile(
    join(adapterCacheDir('cn-qingdao'), 'official-distances.json'),
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

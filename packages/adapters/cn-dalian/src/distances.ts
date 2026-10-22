/**
 * Baidu in-vehicle segment-distance harvest for cn-dalian.
 *
 * The operator publishes no inter-station mileage and no fare workbook, but the
 * fare is a pure function of **ride distance** (see `fares.ts`) — so accurate
 * segment km are load-bearing, not cosmetic. Segment distances are harvested one
 * adjacent pair at a time from the Baidu Direction planner (the in-vehicle leg
 * distance on the operator's own line), cached to
 * `tmp/cache/cn-dalian/official-distances.json`, and applied to
 * `segments.json` as `distance_km` with `distance_source:
 * 'baidu-transit-distance'`.
 *
 * Measured 2026-10: this matters a lot. Straight-line distance understates the
 * official fare ladder badly on the long suburban alignments (普兰店振兴街→
 * 金石滩 is 39.1 km as the crow flies but ~60 km of rail and is quoted ¥10, not
 * the ¥7 a straight-line ladder yields). Haversine ×1.25 is the documented
 * fallback and is recorded as such.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adapterCacheDir, haversineKm, proxyUrl } from '@openmetro/core';
import { dalianPatternBaiduNames } from './lines.js';

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
      await readFile(join(adapterCacheDir('cn-dalian'), 'official-distances.json'), 'utf-8')
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
      from_stop_id: string;
      to_stop_id: string;
      from_station_id: string;
      to_station_id: string;
      distance_km?: number;
      source_id?: string;
      extras?: Record<string, unknown>;
    }[];
  };
  const segs = segDoc.records;

  // A segment must be resolved to an *alignment*, not a line: the 3号线 九里
  // 支线 shares `line_id` with the mainline but the planner reports its legs
  // under 地铁3号线支线. `patterns.json` is the topology source of truth, so an
  // adjacent stop pair belongs to whichever pattern lists it consecutively.
  const patterns = (
    JSON.parse(await readFile(join(dataDir, 'patterns.json'), 'utf-8')).records as {
      id: string;
      line_id: string;
      stop_ids: string[];
    }[]
  ).sort((a, b) => a.id.localeCompare(b.id));
  const patternBaiduName = dalianPatternBaiduNames();
  const baiduNameByStopPair = new Map<string, string>();
  for (const p of patterns) {
    const name = patternBaiduName.get(p.id);
    if (!name) continue;
    for (let i = 0; i + 1 < p.stop_ids.length; i++) {
      const key = [p.stop_ids[i]!, p.stop_ids[i + 1]!].sort().join('|');
      // First match wins; a shared trunk resolves to the primary alignment,
      // whose vehicle name is the one the planner uses for the trunk too.
      if (!baiduNameByStopPair.has(key)) baiduNameByStopPair.set(key, name);
    }
  }

  const stationById = new Map(stations.map((s) => [s.id, s] as const));

  // Undirected adjacent station pairs per line (the planner OD is per line).
  const pairs = new Map<
    string,
    {
      lineId: string;
      baiduName: string;
      a: { id: string; lon: number; lat: number };
      b: { id: string; lon: number; lat: number };
    }
  >();
  const missingAlignment: string[] = [];
  for (const seg of segs) {
    const a = stationById.get(seg.from_station_id);
    const b = stationById.get(seg.to_station_id);
    if (!a?.location || !b?.location) continue;
    const stopKey = [seg.from_stop_id, seg.to_stop_id].sort().join('|');
    const baiduName = baiduNameByStopPair.get(stopKey);
    if (!baiduName) {
      missingAlignment.push(`${a.name}→${b.name} (${seg.line_id})`);
      continue;
    }
    // Keyed by line + station pair so the same pair on two lines stays separate,
    // while the lookup key the apply pass uses (station pair only) still dedupes.
    const key = `${seg.line_id}|${[seg.from_station_id, seg.to_station_id].sort().join('|')}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        lineId: seg.line_id,
        baiduName,
        a: { id: a.id, lon: a.location.lon, lat: a.location.lat },
        b: { id: b.id, lon: b.location.lon, lat: b.location.lat }
      });
    }
  }
  if (missingAlignment.length > 0) {
    console.log(
      `  WARN: ${missingAlignment.length} segment(s) not on any pattern, distances skipped: ${missingAlignment.slice(0, 8).join(', ')}`
    );
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
    let meters = await fetchBaiduLegDistance(ak, pair.a, pair.b, pair.baiduName).catch(() => null);
    if (meters == null) {
      await sleep(delayMs);
      meters = await fetchBaiduLegDistance(ak, pair.b, pair.a, pair.baiduName).catch(() => null);
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
  await mkdir(adapterCacheDir('cn-dalian'), { recursive: true });
  await writeFile(
    join(adapterCacheDir('cn-dalian'), 'official-distances.json'),
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
    // A planner miss still has to be labelled: `fillStraightLineDistances`
    // already put an estimate on every segment before this pass runs, so the
    // value may exist while its provenance is unrecorded. The fare ladder
    // reads these, so "unverified" must be visible in the data.
    const a = stationById.get(seg.from_station_id);
    const b = stationById.get(seg.to_station_id);
    if (a?.location && b?.location) {
      if (seg.distance_km == null || !(seg.distance_km > 0)) {
        seg.distance_km = Math.round(haversineKm(a.location, b.location) * 1.25 * 1000) / 1000;
        fallbackHaversine++;
      }
      seg.extras = { ...(seg.extras ?? {}), distance_source: 'haversine-detour' };
    }
  }
  segDoc.generated_at = new Date().toISOString();
  await writeFile(segmentsPath, `${JSON.stringify(segDoc, null, 2)}\n`, 'utf-8');
  console.log(
    `  segment distances applied: ${applied} planner, ${fallbackHaversine} haversine fallback`
  );

  return { pairs: pairs.size, harvested, cached, misses, applied, fallbackHaversine };
}

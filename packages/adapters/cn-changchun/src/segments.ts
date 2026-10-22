/**
 * Baidu in-vehicle segment-metric harvest for cn-changchun.
 *
 * The operator publishes no inter-station mileage, but the fare is a pure
 * function of the **ride distance** (see `fares.ts`) — so accurate segment km
 * are load-bearing, not cosmetic. Segment distances are harvested one adjacent
 * pair at a time from the Baidu Direction planner (the in-vehicle leg
 * distance on the operator's own line), cached under
 * `tmp/cache/cn-changchun/segment-metrics.json`, and applied to
 * `segments.json` as `distance_km` with `distance_source:
 * 'baidu-transit-distance'`.
 *
 * Only the **distance** is taken from the planner for the canonical record.
 * Its per-hop durations are rounded to whole minutes (60 s / 120 s / 180 s …),
 * which is coarser than the last-train chain that `deriveSegmentTimes`
 * derives from the timetable, so the travel times keep the derived precision.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adapterCacheDir } from '@openmetro/core';
import { fetchBaiduTransitLegs, foldStopName } from './baidu.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MetricCache {
  harvestedAt: string;
  /** `lineId|fromStationId|toStationId` → in-vehicle meters / seconds. */
  metrics: Record<string, { meters: number; seconds: number | null }>;
}

function cacheKey(lineId: string, fromId: string, toId: string): string {
  return `${lineId}|${[fromId, toId].sort().join('|')}`;
}

async function loadCache(): Promise<MetricCache> {
  try {
    const raw = JSON.parse(
      await readFile(join(adapterCacheDir('cn-changchun'), 'segment-metrics.json'), 'utf-8')
    ) as MetricCache;
    if (raw && typeof raw.metrics === 'object') return raw;
  } catch {
    // first run
  }
  return { harvestedAt: new Date().toISOString(), metrics: {} };
}

export interface SegmentPairQuery {
  lineId: string;
  fromStopId: string;
  toStopId: string;
  fromStationId: string;
  toStationId: string;
  from: { name: string; lon: number; lat: number };
  to: { name: string; lon: number; lat: number };
  /** Baidu vehicle-name fragment for the line. */
  baiduName: string;
}

export interface HarvestedSegmentMetric {
  lineId: string;
  fromStopId: string;
  toStopId: string;
  fromStationId: string;
  toStationId: string;
  durationSeconds: number | null;
  distanceMeters: number | null;
  sourceId: string;
}

export interface SegmentMetricResult {
  harvested: number;
  cached: number;
  misses: number;
  metrics: HarvestedSegmentMetric[];
}

/**
 * The rail leg that runs from `from` to `to` on the given line.
 *
 * The planner occasionally routes an adjacent pair in the opposite direction,
 * so both orientations are tried.
 */
async function findLeg(
  ak: string,
  q: SegmentPairQuery
): Promise<{ meters: number | null; seconds: number | null }> {
  const attempt = async (
    a: { name: string; lon: number; lat: number },
    b: { name: string; lon: number; lat: number }
  ) => {
    const legs = await fetchBaiduTransitLegs(ak, a, b).catch(() => []);
    const leg = legs.find(
      (l) =>
        l.lineName.includes(q.baiduName) &&
        foldStopName(l.onStation) === foldStopName(a.name) &&
        foldStopName(l.offStation) === foldStopName(b.name)
    );
    if (!leg) return null;
    return {
      meters: leg.distanceMeters != null && leg.distanceMeters > 0 ? leg.distanceMeters : null,
      seconds: leg.durationSeconds
    };
  };

  const forward = await attempt(q.from, q.to);
  if (forward) return forward;
  return (await attempt(q.to, q.from)) ?? { meters: null, seconds: null };
}

/**
 * Harvest the in-vehicle distance of every adjacent stop pair.
 *
 * Cached between runs under `tmp/cache/cn-changchun/`, so a re-run of the
 * topology layer does not re-query the planner for pairs it already knows.
 */
export async function harvestSegmentMetrics(
  ak: string,
  queries: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetricResult> {
  const delayMs = opts.delayMs ?? 320;
  const retries = opts.retries ?? 1;
  const cache = await loadCache();
  const metrics: HarvestedSegmentMetric[] = [];
  let harvested = 0;
  let cached = 0;
  let misses = 0;

  for (const q of queries) {
    const key = cacheKey(q.lineId, q.fromStationId, q.toStationId);
    const cachedMetric = cache.metrics[key];
    let meters: number | undefined = cachedMetric?.meters;
    let seconds: number | null = cachedMetric?.seconds ?? null;

    // A cached pair without a duration still needs one query (the duration is
    // applied to `segments.travel_time_seconds`, the distance to
    // `segments.distance_km`).
    if (meters == null || seconds == null) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const leg = await findLeg(ak, q);
        meters = leg.meters ?? undefined;
        seconds = leg.seconds;
        if (meters != null) break;
        await sleep(delayMs);
      }
      if (meters != null) {
        cache.metrics[key] = { meters, seconds };
        harvested++;
      } else {
        misses++;
      }
      await sleep(delayMs);
    } else {
      cached++;
    }

    metrics.push({
      lineId: q.lineId,
      fromStopId: q.fromStopId,
      toStopId: q.toStopId,
      fromStationId: q.fromStationId,
      toStationId: q.toStationId,
      durationSeconds: seconds,
      distanceMeters: meters ?? null,
      sourceId: 'baidu-transit-distance'
    });
  }

  cache.harvestedAt = new Date().toISOString();
  await mkdir(adapterCacheDir('cn-changchun'), { recursive: true });
  await writeFile(
    join(adapterCacheDir('cn-changchun'), 'segment-metrics.json'),
    `${JSON.stringify(cache, null, 2)}\n`,
    'utf-8'
  );
  console.log(
    `  segment metrics: ${harvested} harvested, ${cached} cached, ${misses} misses (${queries.length} pairs)`
  );

  return { harvested, cached, misses, metrics };
}

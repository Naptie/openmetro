/**
 * Segment metric harvest for cn-changsha: one planner query per undirected
 * adjacent stop pair, measuring the rail leg's in-vehicle duration and
 * distance between exactly the pair's two stops (boarding/alighting validated
 * by folded stop name).
 *
 * The operator publishes no per-segment metrics and no per-segment distance
 * table, so these planner measurements — with the last-train diffs derived
 * from the official first/last table as fallbacks — are the routing weights.
 * The distances also feed the fare layer, which prices the operator's own
 * 《票务规则》 mileage ladder over the network's shortest riding path.
 *
 * `direction/v2/transit` serves a rail leg even for a one-hop OD on this
 * network (verified: 五一广场 → 湘江中路 returns an `轨道交通2号线` leg with
 * 1 stop, 686 m / 60 s), which is what makes per-pair harvesting possible.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adapterCacheDir, type BaiduStationRef } from '@openmetro/core';
import { fetchBaiduTransitLegs, foldStopName } from './baidu.js';
import type { ChangshaLineConfig } from './lines.js';

export interface SegmentPairQuery {
  line: ChangshaLineConfig;
  fromStopId: string;
  toStopId: string;
  from: BaiduStationRef;
  to: BaiduStationRef;
}

export interface SegmentMetrics {
  fromStopId: string;
  toStopId: string;
  durationSeconds: number | null;
  distanceMeters: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cached planner measurements, keyed by the sorted stop-id pair.
 *
 * The cache lives under the git-ignored `tmp/cache/` scratch dir and only
 * exists to spare repeat planner queries: the pairs are keyed by the
 * canonical stop ids, so a re-run over an unchanged network reuses them and
 * a changed network simply misses on the new pairs.
 */
interface MetricsCache {
  harvestedAt: string;
  /** `fromStopId|toStopId` (sorted) → `{ durationSeconds, distanceMeters }`. */
  metrics: Record<string, { durationSeconds: number | null; distanceMeters: number | null }>;
}

async function loadCache(): Promise<MetricsCache> {
  try {
    const raw = JSON.parse(
      await readFile(join(adapterCacheDir('cn-changsha'), 'segment-metrics.json'), 'utf-8')
    ) as MetricsCache;
    if (raw && typeof raw.metrics === 'object') return raw;
  } catch {
    // first run
  }
  return { harvestedAt: new Date().toISOString(), metrics: {} };
}

async function measurePair(
  ak: string,
  pair: SegmentPairQuery,
  opts: { delayMs: number; retries: number }
): Promise<SegmentMetrics> {
  const out: SegmentMetrics = {
    fromStopId: pair.fromStopId,
    toStopId: pair.toStopId,
    durationSeconds: null,
    distanceMeters: null
  };
  const match = (on: string, off: string) =>
    (foldStopName(on) === foldStopName(pair.from.name) &&
      foldStopName(off) === foldStopName(pair.to.name)) ||
    (foldStopName(on) === foldStopName(pair.to.name) &&
      foldStopName(off) === foldStopName(pair.from.name));
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const legs = await fetchBaiduTransitLegs(ak, pair.from, pair.to).catch(() => []);
    const leg = legs.find(
      (l) => l.lineName.includes(pair.line.baiduNameHint) && match(l.onStation, l.offStation)
    );
    if (leg) {
      out.durationSeconds = leg.durationSeconds;
      out.distanceMeters = leg.distanceMeters;
      return out;
    }
    await sleep(opts.delayMs);
  }
  return out;
}

/**
 * Harvest one in-vehicle duration/distance per undirected adjacent pair.
 *
 * Pairs are keyed by the sorted stop-id pair, so the same physical pair
 * appearing on two lines collapses into one planner query. Measurements from
 * a previous run are reused; only the missing pairs are queried.
 */
export async function harvestSegmentMetrics(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 320;
  const retries = opts.retries ?? 1;
  const cache = await loadCache();
  const out: SegmentMetrics[] = [];
  let harvested = 0;
  let cached = 0;

  for (const pair of pairs) {
    const key = [pair.fromStopId, pair.toStopId].sort().join('|');
    const hit = cache.metrics[key];
    if (hit) {
      cached++;
      out.push({
        fromStopId: pair.fromStopId,
        toStopId: pair.toStopId,
        durationSeconds: hit.durationSeconds,
        distanceMeters: hit.distanceMeters
      });
      continue;
    }
    const measured = await measurePair(ak, pair, { delayMs, retries });
    harvested++;
    if (measured.durationSeconds != null || measured.distanceMeters != null) {
      cache.metrics[key] = {
        durationSeconds: measured.durationSeconds,
        distanceMeters: measured.distanceMeters
      };
    }
    out.push(measured);
    await sleep(delayMs);
  }

  cache.harvestedAt = new Date().toISOString();
  await mkdir(adapterCacheDir('cn-changsha'), { recursive: true });
  await writeFile(
    join(adapterCacheDir('cn-changsha'), 'segment-metrics.json'),
    `${JSON.stringify(cache, null, 2)}\n`,
    'utf-8'
  );
  console.log(`  segment metrics: ${harvested} harvested, ${cached} cached`);

  return out;
}

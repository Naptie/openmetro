/**
 * Segment metric harvest for cn-xuzhou: one planner query per undirected
 * adjacent stop pair, measuring the rail leg's in-vehicle duration and
 * distance between exactly the pair's two stops (boarding/alighting validated
 * by folded stop name).
 *
 * The operator publishes no per-segment metrics and no per-segment distance
 * table, so these planner measurements — with the last-train diffs and the
 * distance/speed model as fallbacks — are the routing weights.
 *
 * `direction/v2/transit` serves a rail leg even for a one-hop OD on this
 * network (verified 2026-10-23: 路窝 → 杏山子 returns a `地铁1号线` leg with
 * the in-vehicle distance and duration), which is what makes per-pair
 * harvesting possible.
 */
import type { BaiduStationRef } from '@openmetro/core';
import { fetchBaiduTransitLegs, foldStopName } from './baidu.js';
import type { XuzhouLineConfig } from './lines.js';

export interface SegmentPairQuery {
  line: XuzhouLineConfig;
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
 * appearing on two lines collapses into one planner query.
 */
export async function harvestSegmentMetrics(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 320;
  const retries = opts.retries ?? 1;
  const out: SegmentMetrics[] = [];
  for (const pair of pairs) {
    out.push(await measurePair(ak, pair, { delayMs, retries }));
    await sleep(delayMs);
  }
  return out;
}

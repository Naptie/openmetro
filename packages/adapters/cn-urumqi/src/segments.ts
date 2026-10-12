/**
 * Segment metric harvest for cn-urumqi: one planner query per undirected
 * adjacent stop pair, measuring the rail leg's in-vehicle duration and
 * distance between exactly the pair's two stops (boarding/alighting
 * validated by folded stop name). The operator publishes no segment
 * metrics, so these planner measurements — with last-train diffs and the
 * distance-speed model as fallbacks — are the routing weights.
 */
import type { BaiduStationRef } from '@openmetro/core';
import { fetchBaiduTransitLegs, foldStopName } from './baidu.js';
import type { UrumqiLineConfig } from './lines.js';

export interface SegmentPairQuery {
  line: UrumqiLineConfig;
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

export async function harvestSegmentMetrics(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 380;
  const retries = opts.retries ?? 1;
  const out: SegmentMetrics[] = [];
  for (const pair of pairs) {
    out.push(await measurePair(ak, pair, { delayMs, retries }));
    await sleep(delayMs);
  }
  return out;
}

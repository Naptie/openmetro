/**
 * Segment metric harvest for cn-lanzhou.
 *
 * The operator publishes no per-segment run times and no distance table, so
 * the planner measurements below are the source for the segment distance and
 * the primary source for the segment time (the last-train chain and the
 * distance/speed model remain as fallbacks).
 *
 * One planner query per undirected adjacent stop pair. The leg is matched by
 * **boarding station** and operator line (see `./baidu.ts`): for a one-hop OD
 * the planner may also offer a bus or a walk route, and at an interchange it
 * may offer a leg that boards somewhere else entirely.
 *
 * The planner is direction-sensitive — a one-hop OD is sometimes only offered
 * in the opposite direction (e.g. 西站什字 → 七里河 is only answered as
 * 七里河 → 西站什字). A segment is undirected, so the reverse OD is measured
 * as a fallback; the two directions agree to within a metre on the pairs that
 * answer both ways (1563 m vs 1562 m on 陈官营 → 奥体中心).
 */
import type { BaiduStationRef } from '@openmetro/core';
import { type BaiduRailLeg, fetchBaiduRailLegs, pickOriginLeg, stopNameMatches } from './baidu.js';
import type { LanzhouLineConfig } from './lines.js';

export interface SegmentPairQuery {
  line: LanzhouLineConfig;
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
 * The one-hop leg between exactly the pair's two stations.
 *
 * The leg must board at `from` and alight at `to` — a leg that passes through
 * more stops is a different segment and must not be used.
 */
function oneHopLeg(
  legs: readonly BaiduRailLeg[],
  from: BaiduStationRef,
  to: BaiduStationRef,
  lineHint: string
): BaiduRailLeg | undefined {
  const candidate = pickOriginLeg(legs, { originName: from.name, lineHint });
  if (!candidate) return undefined;
  if (!stopNameMatches(candidate.offStation, to.name)) return undefined;
  return candidate;
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
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    for (const [a, b] of [
      [pair.from, pair.to],
      [pair.to, pair.from]
    ] as const) {
      const legs = await fetchBaiduRailLegs(ak, a, b).catch(() => []);
      const leg = oneHopLeg(legs, a, b, pair.line.baiduNameHint);
      if (leg) {
        out.durationSeconds = leg.durationSeconds;
        out.distanceMeters = leg.distanceMeters;
        return out;
      }
    }
    await sleep(opts.delayMs);
  }
  return out;
}

/**
 * Harvest one in-vehicle duration/distance per undirected adjacent pair.
 *
 * Pairs are keyed by the sorted stop-id pair, so a physical pair that
 * appeared on two lines would collapse into one planner query.
 */
export async function harvestSegmentMetrics(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 300;
  const retries = opts.retries ?? 1;
  const out: SegmentMetrics[] = [];
  for (const pair of pairs) {
    out.push(await measurePair(ak, pair, { delayMs, retries }));
    await sleep(delayMs);
  }
  return out;
}

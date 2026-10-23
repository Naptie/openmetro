/**
 * Segment distances for cn-hefei.
 *
 * The operator publishes **no** distances — not per segment, not per line, not
 * per OD. The official 《首末班车时间及行车间隔》 carries only times, and the
 * official tariff is a *distance* ladder, so the OD matrix cannot be computed
 * from the straight line between two stations: a metro alignment is never as
 * straight as it looks (Hefei's 3 号线 swings from 省儿童医院新区 in the
 * north-west to 相城路 in the south-east, and its two branches around 朱岗
 * make the rail distance materially longer than the crow flight).
 *
 * So the in-vehicle distance of every adjacent hop is measured with the Baidu
 * planner, one query per undirected pair. The leg must board at one end and
 * alight at the other — a leg that passes through more stops is a different
 * segment and must not be used.
 *
 * The core `gapfill` layer cannot do this: it only fills distances that are
 * *missing*, and the topology pass has already written the haversine estimate
 * as a placeholder. The measured distances are therefore patched onto
 * `segments.json` after the canonical write (see `./run.ts`), the same way
 * cn-dalian and cn-nanchang do it.
 */
import { type BaiduRailLeg, fetchBaiduRailLegs, pickOneHopLeg } from './baidu.js';
import type { HefeiLineConfig } from './lines.js';

/** A station reference for the planner, in the canonical GCJ-02 datum. */
export interface HefeiStationPoint {
  /** Canonical station name. */
  name: string;
  lon: number;
  lat: number;
}

/** One adjacent stop pair to measure. */
export interface SegmentPairQuery {
  line: HefeiLineConfig;
  fromStopId: string;
  toStopId: string;
  from: HefeiStationPoint;
  to: HefeiStationPoint;
}

/** The measured metrics of one adjacent pair. */
export interface SegmentMetrics {
  fromStopId: string;
  toStopId: string;
  /** In-vehicle metres for the hop (planner measurement). */
  distanceMeters: number | null;
  /** In-vehicle seconds for the hop (planner measurement). */
  durationSeconds: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The one-hop leg between exactly the pair's two stations.
 *
 * The leg must board at `from` and alight at `to`; the planner's own
 * `off_station` carries the exit suffix, which `stopNameMatches` folds away.
 */
function oneHopLeg(
  legs: readonly BaiduRailLeg[],
  from: HefeiStationPoint,
  to: HefeiStationPoint,
  lineNumber: string
): BaiduRailLeg | undefined {
  return pickOneHopLeg(legs, from, to, lineNumber);
}

/**
 * Measure one in-vehicle distance per undirected adjacent pair.
 *
 * The planner is direction-sensitive — a one-hop OD is sometimes only offered
 * in the opposite direction — so the reverse OD is measured as a fallback.
 */
export async function harvestSegmentDistances(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 120;
  const retries = opts.retries ?? 1;
  const out: SegmentMetrics[] = [];

  for (const pair of pairs) {
    const metrics: SegmentMetrics = {
      fromStopId: pair.fromStopId,
      toStopId: pair.toStopId,
      distanceMeters: null,
      durationSeconds: null
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      for (const [a, b] of [
        [pair.from, pair.to],
        [pair.to, pair.from]
      ] as const) {
        const legs = await fetchBaiduRailLegs(ak, a, b, 1).catch(() => []);
        const leg = oneHopLeg(legs, a, b, pair.line.officialId);
        if (leg) {
          metrics.durationSeconds = leg.durationSeconds;
          metrics.distanceMeters = leg.distanceMeters;
          break;
        }
      }
      if (metrics.distanceMeters != null) break;
      await sleep(delayMs);
    }
    out.push(metrics);
    await sleep(delayMs);
  }
  return out;
}

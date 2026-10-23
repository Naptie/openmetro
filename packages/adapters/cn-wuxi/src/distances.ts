/**
 * Segment distances for cn-wuxi.
 *
 * The operator publishes **no** distances — not per segment, not per line, not
 * per OD. The official 票务服务 column carries only the tariff *formula*, and
 * that formula is a **distance** ladder, so the OD matrix cannot be computed
 * from the straight line between two stations: a metro alignment is never as
 * straight as it looks (Wuxi's 1 号线 runs north–south through the city while
 * its 4 号线 loops around the 蠡湖 in the south-west, and the S1 line reaches
 * down to 江阴外滩).
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
 * `cn-dalian`, `cn-hefei` and `cn-nanchang` do it.
 */
import { type BaiduRailLeg, fetchBaiduRailLegs, pickOneHopLeg } from './baidu.js';
import type { WuxiLineConfig } from './lines.js';

/** A station reference for the planner, in the canonical GCJ-02 datum. */
export interface WuxiStationPoint {
  /** Canonical station name. */
  name: string;
  lon: number;
  lat: number;
}

/** One adjacent stop pair to measure. */
export interface SegmentPairQuery {
  line: WuxiLineConfig;
  fromStopId: string;
  toStopId: string;
  from: WuxiStationPoint;
  to: WuxiStationPoint;
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
 * Measure one in-vehicle distance per undirected adjacent pair.
 *
 * The planner is direction-sensitive — a one-hop OD is sometimes only offered
 * in the opposite direction — so the reverse OD is measured as a fallback.
 */
export async function harvestSegmentDistances(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number; concurrency?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 120;
  const retries = opts.retries ?? 1;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const out: SegmentMetrics[] = new Array(pairs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= pairs.length) return;
      const pair = pairs[i]!;
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
          const leg: BaiduRailLeg | undefined = pickOneHopLeg(legs, a, b, pair.line);
          if (leg) {
            metrics.durationSeconds = leg.durationSeconds;
            metrics.distanceMeters = leg.distanceMeters;
            break;
          }
        }
        if (metrics.distanceMeters != null) break;
        await sleep(delayMs);
      }
      out[i] = metrics;
      await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
  return out.filter((m): m is SegmentMetrics => m != null);
}

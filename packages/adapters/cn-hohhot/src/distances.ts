/**
 * Per-segment track metrics for cn-hohhot, harvested from the Baidu planner.
 *
 * The operator publishes no per-segment run times or distances, and the
 * straight-line distance between two stations understates the length of the
 * alignment (the line runs along 新华大街 / 锡林郭勒南路 and out to the
 * airport on a viaduct). The planner's metro leg carries the in-vehicle
 * distance along the alignment, which is the network's own track distance.
 *
 * The harvested leg is validated: it must board at the from-station and
 * alight at the to-station, otherwise the planner offered a bus or a
 * walk-then-ride alternative (see `baidu.ts`).
 */
import { fetchBaiduMetroLegMetrics } from './baidu.js';

export interface SegmentPairQuery {
  fromStopId: string;
  toStopId: string;
  from: { name: string; lon: number; lat: number };
  to: { name: string; lon: number; lat: number };
}

export interface SegmentMetric {
  fromStopId: string;
  toStopId: string;
  durationSeconds: number | null;
  distanceMeters: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function harvestSegmentMetrics(
  ak: string,
  queries: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetric[]> {
  const delayMs = opts.delayMs ?? 380;
  const retries = opts.retries ?? 1;
  const out: SegmentMetric[] = [];
  for (const q of queries) {
    let metric: Awaited<ReturnType<typeof fetchBaiduMetroLegMetrics>> = null;
    for (let attempt = 0; attempt <= retries && !metric; attempt++) {
      metric = await fetchBaiduMetroLegMetrics(ak, q.from, q.to, 0).catch(() => null);
      if (!metric && attempt < retries) await sleep(delayMs);
    }
    out.push({
      fromStopId: q.fromStopId,
      toStopId: q.toStopId,
      durationSeconds: metric?.durationSeconds ?? null,
      distanceMeters: metric ? metric.distanceKm * 1000 : null
    });
    await sleep(delayMs);
  }
  return out;
}

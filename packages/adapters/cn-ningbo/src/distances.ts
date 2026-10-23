/**
 * Segment distances for cn-ningbo.
 *
 * The operator publishes **no** distances: its tariff is mileage-based, but
 * the prices come from the operator's own route query, so no per-segment
 * distance is ever published. The in-vehicle distance of every adjacent hop
 * is therefore measured with the Baidu planner, one query per undirected
 * pair — the leg must board at one end and alight at the other, because a leg
 * that passes through more stops is a different segment.
 *
 * The core `gapfill` layer cannot do this: it only fills distances that are
 * *missing*, and the topology pass has already written the haversine estimate
 * as a placeholder. The measured distances are therefore patched onto
 * `segments.json` after the canonical write (see `./run.ts`), the same way
 * cn-dalian, cn-nanchang, cn-hefei and cn-wuxi do it.
 */
import {
  BAIDU_SOURCE_ID,
  BaiduPlannerClient,
  type BaiduTransitStep,
  loadBaiduGapfillConfig,
  pureMetroSteps
} from '@openmetro/core';

/** A station reference for the planner, in the canonical GCJ-02 datum. */
export interface NingboStationPoint {
  /** Canonical station name. */
  name: string;
  lon: number;
  lat: number;
}

/** One adjacent stop pair to measure. */
export interface SegmentPairQuery {
  fromStopId: string;
  toStopId: string;
  from: NingboStationPoint;
  to: NingboStationPoint;
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
 * Fold a planner stop label to the station name the canonical data uses.
 *
 * The planner appends the exit (`矮柳站(A口)`) and the operator's own `站`
 * suffix; both are stripped on the same side of the comparison, so the two
 * spellings still match.
 */
function normName(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/站.*$/, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim();
}

function nameMatches(hay: string, needle: string): boolean {
  if (!hay || !needle) return false;
  return hay === needle || hay.includes(needle) || needle.includes(hay);
}

/**
 * The one-hop ride between exactly the pair's two stations.
 *
 * The leg must board at one end and alish at the other: a leg that passes
 * through more stops is a different segment and must not be used. A route
 * that does not match is discarded rather than guessed, so a hop the planner
 * routes with a change keeps the straight-line estimate instead of
 * inheriting another segment's distance.
 */
function oneHopRide(
  steps: readonly BaiduTransitStep[],
  fromName: string,
  toName: string
): { duration?: number; distance?: number } | undefined {
  const a = normName(fromName);
  const b = normName(toName);
  for (const s of steps) {
    if (s.type !== 3) continue;
    const v = s.vehicle ?? {};
    const names = [
      normName(v.start_name),
      normName(v.end_name),
      ...(v.stop_info ?? []).map((x) => normName(x.stop_name))
    ];
    const hasA = names.some((n) => nameMatches(n, a));
    const hasB = names.some((n) => nameMatches(n, b));
    if (!hasA || !hasB) continue;
    return { duration: s.duration, distance: s.distance };
  }
  return undefined;
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
  opts: {
    delayMs?: number;
    retries?: number;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 120;
  const retries = opts.retries ?? 1;
  const cfg = loadBaiduGapfillConfig({ ...process.env, OPENMETRO_BAIDU_AK: ak });
  if ('error' in cfg) throw new Error(cfg.error);
  const client = new BaiduPlannerClient(cfg);
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
        const resp = await client
          .transit({ lat: a.lat, lng: a.lon }, { lat: b.lat, lng: b.lon })
          .catch(() => undefined);
        for (const route of resp?.result?.routes ?? []) {
          const hit = oneHopRide(pureMetroSteps(route.steps), a.name, b.name);
          if (hit?.distance != null && hit.distance > 0) {
            metrics.distanceMeters = hit.distance;
            metrics.durationSeconds = hit.duration ?? null;
            break;
          }
        }
        if (metrics.distanceMeters != null) break;
      }
      if (metrics.distanceMeters != null) break;
      await sleep(delayMs);
    }
    out.push(metrics);
    opts.onProgress?.(out.length, pairs.length);
    await sleep(delayMs);
  }
  return out;
}

/** The source id written onto a segment whose distance was measured here. */
export const SEGMENT_DISTANCE_SOURCE = BAIDU_SOURCE_ID;

/**
 * Segment metrics for cn-nanning.
 *
 * ## Distances — planner
 *
 * The operator publishes no distances at all (its site states the first/last
 * train sheets and the fare policy, never a per-hop mileage), so the in-vehicle
 * distance of every adjacent hop is measured with the Baidu planner — one query
 * per undirected pair, where the leg must board at one end and alight at the
 * other.
 *
 * The measured distances are what the fare layer needs: the operator's tariff
 * is a **mileage ladder** over the ride distance, and a straight-line distance
 * would understate the charged mileage by roughly one price step (measured:
 * applying the ladder to AMap straight-line distances disagrees with the
 * operator's own quote on ~4 % of OD pairs, with a mean bias of −1.00 yuan).
 */
import type { BaiduStationRef } from '@openmetro/core';
import { type BaiduRailLeg, fetchBaiduRoutes, lineNumberOf, pickOriginLeg } from './baidu.js';
import { plannerStopMatches } from './lines.js';

export interface SegmentPairQuery {
  fromStopId: string;
  toStopId: string;
  /** The operator's own station name for the origin. */
  fromOfficialName: string;
  /** The operator's own station name for the destination. */
  toOfficialName: string;
  /** Line number of the pair's line (`'1'` … `'5'`). */
  lineNumber: string;
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
export function oneHopLeg(
  legs: readonly BaiduRailLeg[],
  from: BaiduStationRef,
  to: BaiduStationRef,
  lineNumber: string
): BaiduRailLeg | undefined {
  const candidate = pickOriginLeg(legs, { originName: from.name, lineNumber });
  if (!candidate) return undefined;
  if (!plannerStopMatches(candidate.offStation, to.name)) return undefined;
  if (lineNumberOf(candidate.lineName) !== lineNumber) return undefined;
  return candidate;
}

/**
 * Measure one in-vehicle distance per undirected adjacent pair.
 *
 * The planner is direction-sensitive — a one-hop OD is sometimes only offered
 * in the opposite direction — so the reverse OD is measured as a fallback.
 */
export async function harvestSegmentMetrics(
  ak: string,
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<SegmentMetrics[]> {
  const delayMs = opts.delayMs ?? 250;
  const retries = opts.retries ?? 1;
  const out: SegmentMetrics[] = [];
  for (const pair of pairs) {
    const row: SegmentMetrics = {
      fromStopId: pair.fromStopId,
      toStopId: pair.toStopId,
      durationSeconds: null,
      distanceMeters: null
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      for (const [a, b] of [
        [pair.from, pair.to],
        [pair.to, pair.from]
      ] as const) {
        const routes = await fetchBaiduRoutes(ak, a, b).catch(() => []);
        const leg = oneHopLeg(
          routes.flatMap((r) => r.legs),
          a,
          b,
          pair.lineNumber
        );
        if (leg) {
          row.durationSeconds = leg.durationSeconds;
          row.distanceMeters = leg.distanceMeters;
          break;
        }
      }
      if (row.distanceMeters != null) break;
      await sleep(delayMs);
    }
    out.push(row);
    await sleep(delayMs);
  }
  return out;
}

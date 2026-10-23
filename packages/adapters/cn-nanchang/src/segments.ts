/**
 * Segment metrics for cn-nanchang.
 *
 * ## Run times — official
 *
 * The operator's route planner (`POST .../newselectByTowSiteName`) returns
 * `gegeshijiantime`, the run time in minutes **per leg of the path**. A leg is
 * a contiguous run on one line, so a whole-line query answers with a single
 * value (昌北机场 → 麻丘, 33 hops → `[80]`), not a per-hop breakdown.
 *
 * Querying **adjacent stations** therefore turns the planner into a per-hop
 * timer: 昌北机场 → 汇贤大道 answers `[6]`, 汇贤大道 → 建业大道 `[2]`,
 * 八一广场 → 丁公路北 `[3]`. Those values are the operator's own run times and
 * land in `segments.travel_time_seconds` with `travel_time_source: "source"` —
 * the only network in the repository whose segment times are official.
 *
 * Cross-check against the operator's published Line 1 / Line 3 sheets: the
 * first train toward 麻丘 leaves 昌北机场 at 06:00 and 汇贤大道 at 06:06 — the
 * same 6 minutes the planner quotes for that hop.
 *
 * ## Distances — planner
 *
 * The operator publishes no distances, so the in-vehicle distance of every
 * adjacent hop is measured with the Baidu planner (one query per undirected
 * pair; the leg must board at one end and alight at the other).
 */
import type { BaiduStationRef } from '@openmetro/core';
import { type BaiduRailLeg, fetchBaiduRailLegs, pickOriginLeg, stopNameMatches } from './baidu.js';
import { fetchOfficialRoute } from './fetch.js';
import type { NanchangLineConfig } from './lines.js';

export interface SegmentPairQuery {
  line: NanchangLineConfig;
  fromStopId: string;
  toStopId: string;
  /** The operator's own station name for the origin (with 站). */
  fromOfficialName: string;
  /** The operator's own station name for the destination (with 站). */
  toOfficialName: string;
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
  lineNumber: string
): BaiduRailLeg | undefined {
  const candidate = pickOriginLeg(legs, { originName: from.name, lineNumber });
  if (!candidate) return undefined;
  if (!stopNameMatches(candidate.offStation, to.name)) return undefined;
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
    const out0: SegmentMetrics = {
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
        const legs = await fetchBaiduRailLegs(ak, a, b).catch(() => []);
        const leg = oneHopLeg(legs, a, b, pair.line.short);
        if (leg) {
          out0.durationSeconds = leg.durationSeconds;
          out0.distanceMeters = leg.distanceMeters;
          break;
        }
      }
      if (out0.distanceMeters != null) break;
      await sleep(delayMs);
    }
    out.push(out0);
    await sleep(delayMs);
  }
  return out;
}

/**
 * The operator's own run time for one adjacent hop, in seconds.
 *
 * The planner answers a one-hop query with a single leg, so `gegeshijiantime`
 * holds exactly that hop's minutes. A multi-leg answer means the planner
 * routed the hop with a change — that is not the hop's run time, so it is
 * discarded and the segment falls back to the derived chain.
 */
export async function harvestOfficialSegmentTimes(
  pairs: SegmentPairQuery[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<Map<string, { seconds: number; minutes: number }>> {
  const delayMs = opts.delayMs ?? 120;
  const retries = opts.retries ?? 2;
  const out = new Map<string, { seconds: number; minutes: number }>();

  for (const pair of pairs) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const route = await fetchOfficialRoute(
        pair.fromOfficialName,
        pair.toOfficialName,
        pair.line.officialId,
        pair.line.officialId
      ).catch(() => undefined);
      const legs = route?.gegeshijiantime ?? [];
      if (legs.length === 1 && Number.isFinite(legs[0]) && legs[0]! > 0) {
        out.set(`${pair.fromStopId}|${pair.toStopId}`, {
          minutes: legs[0]!,
          seconds: Math.round(legs[0]! * 60)
        });
        break;
      }
      await sleep(delayMs);
    }
    await sleep(delayMs);
  }
  return out;
}

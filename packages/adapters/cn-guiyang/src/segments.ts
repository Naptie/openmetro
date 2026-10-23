/**
 * Per-segment in-vehicle time and distance from the operator's planner.
 *
 * The planner reports the duration and distance of a whole ride (e.g. 28
 * stops, 64 minutes, 42 786 m), not per segment. Querying **one adjacent
 * pair** at a time yields exactly that segment's own numbers:
 *
 * ```
 * GET …getSubwayLines?origin=<A>&destination=<B>
 * → list[0].duration = "2分钟", list[0].distance = 1071
 * ```
 *
 * so one query per adjacent pair (99 stops → 98 pairs) covers every ride edge
 * with the operator's own published figures.
 *
 * The operator rounds durations to whole minutes, which is the published
 * granularity; distances are exact metres.
 */
import { type PlannerPlan, queryPlanner } from './planner.js';

export interface HarvestedSegment {
  /** Canonical name of the segment's origin stop. */
  fromName: string;
  /** Canonical name of the segment's destination stop. */
  toName: string;
  /** In-vehicle time in seconds (operator granularity: whole minutes). */
  travelTimeSeconds: number;
  /** Ride distance in metres. */
  distanceMeters: number;
}

export interface SegmentHarvestPair {
  /** Canonical name of the origin stop. */
  fromName: string;
  /** Canonical name of the destination stop. */
  toName: string;
  /** The operator's coordinate string of the origin stop. */
  fromCoord: string;
  /** The operator's coordinate string of the destination stop. */
  toCoord: string;
  /** Operator line id the pair belongs to. */
  lineId: string;
}

export interface HarvestSegmentsResult {
  segments: HarvestedSegment[];
  /** Pairs the planner did not answer with a matching ride leg. */
  gaps: string[];
}

export interface SegmentHarvestOptions {
  delayMs?: number;
  retries?: number;
}

/**
 * Harvest one duration/distance sample per adjacent stop pair.
 */
export async function harvestSegmentMetrics(
  pairs: SegmentHarvestPair[],
  opts: SegmentHarvestOptions = {}
): Promise<HarvestSegmentsResult> {
  const delayMs = opts.delayMs ?? 120;
  const segments: HarvestedSegment[] = [];
  const gaps: string[] = [];

  for (const pair of pairs) {
    let plan: PlannerPlan | undefined;
    try {
      plan = await queryPlanner(pair.fromCoord, pair.toCoord, { retries: opts.retries ?? 2 });
    } catch (err) {
      gaps.push(
        `${pair.fromName}→${pair.toName}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const leg = plan?.legs.find(
      (l) => !l.isWalk && l.onStation === pair.fromName && l.offStation === pair.toName
    );
    if (!leg) {
      gaps.push(`${pair.fromName}→${pair.toName}: planner returned no matching ride leg`);
      continue;
    }
    const minutes = leg.durationMinutes;
    const meters = leg.distanceMeters;
    if (!minutes || minutes <= 0 || !meters || meters <= 0) {
      gaps.push(`${pair.fromName}→${pair.toName}: no usable duration/distance`);
      continue;
    }
    segments.push({
      fromName: pair.fromName,
      toName: pair.toName,
      travelTimeSeconds: minutes * 60,
      distanceMeters: meters
    });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { segments, gaps };
}

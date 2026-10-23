/**
 * Interchange walk distances from the operator's planner.
 *
 * When a journey changes lines, the planner inserts a walking leg:
 *
 * ```
 * { "name": "", "instructions": "站厅换乘 步行72米", "distance": 72, "duration": "0分钟" }
 * ```
 *
 * The **distance** is the operator's published figure. The duration is
 * rounded to whole minutes and therefore unusable, so the walk *time* is left
 * to the core `gapfill` layer, which measures it with the Baidu planner.
 *
 * To make the planner produce a transfer at a given interchange, the query has
 * to start on one line on the far side of the station and end on the other
 * line on the far side as well — then the only sensible route is
 * ride → walk → ride. Candidate pairs are tried in order and the first one
 * that yields a walk leg at the interchange wins.
 */
import { type PlannerPlan, queryPlanner } from './planner.js';

export interface HarvestedInterchange {
  /** Canonical name of the interchange station. */
  stationName: string;
  /** Operator line id of the line the traveller arrives on. */
  fromLineId: string;
  /** Operator line id of the line the traveller leaves on. */
  toLineId: string;
  /** Published walk distance in metres. */
  walkDistanceMeters: number;
  /** The operator's instruction sentence, e.g. `站厅换乘 步行72米`. */
  instructions: string;
}

export interface InterchangeCandidate {
  /** Canonical name of the interchange station. */
  stationName: string;
  /** Operator line id of the arrival line. */
  fromLineId: string;
  /** Operator line id of the departure line. */
  toLineId: string;
  /** Candidate origin: a station on the arrival line, beyond the interchange. */
  fromCoord: string;
  /** Candidate origin name. */
  fromName: string;
  /** Candidate destination: a station on the departure line, beyond it. */
  toCoord: string;
  /** Candidate destination name. */
  toName: string;
}

export interface HarvestInterchangesResult {
  interchanges: HarvestedInterchange[];
  /** Candidates that did not produce a usable walk leg. */
  gaps: string[];
}

export interface InterchangeHarvestOptions {
  delayMs?: number;
  retries?: number;
}

/**
 * Harvest the published walk distance of every candidate interchange.
 *
 * A candidate only counts when the planner actually produced a walking leg
 * for it, so a query that the planner answers with a different route cannot
 * silently attach a wrong distance to an interchange.
 */
export async function harvestInterchangeWalks(
  candidates: InterchangeCandidate[],
  opts: InterchangeHarvestOptions = {}
): Promise<HarvestInterchangesResult> {
  const delayMs = opts.delayMs ?? 120;
  const interchanges: HarvestedInterchange[] = [];
  const gaps: string[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const key = `${c.stationName}|${c.fromLineId}|${c.toLineId}`;
    if (seen.has(key)) continue;
    let plan: PlannerPlan | undefined;
    try {
      plan = await queryPlanner(c.fromCoord, c.toCoord, { retries: opts.retries ?? 2 });
    } catch (err) {
      gaps.push(`${c.stationName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const walk = plan?.legs.find((l) => l.isWalk && (l.distanceMeters ?? 0) > 0);
    if (!walk) {
      gaps.push(`${c.stationName}: planner returned no walking leg`);
      continue;
    }
    seen.add(key);
    interchanges.push({
      stationName: c.stationName,
      fromLineId: c.fromLineId,
      toLineId: c.toLineId,
      walkDistanceMeters: walk.distanceMeters!,
      instructions: walk.instructions
    });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { interchanges, gaps };
}

/**
 * Per-station, per-direction first/last trains from the operator's planner.
 *
 * The operator publishes a station's first and last train for a direction in
 * the planner response of any journey that **boards** at that station in that
 * direction — the response's `firstTime` / `lastTime` belong to the boarding
 * station, not to the destination.
 *
 * So the harvest walks each line and queries every station against its
 * neighbour in both directions:
 *
 * - station *i* → station *i+1* yields the service heading toward the line's
 *   last station (the operator labels it `窦官方向` and friends);
 * - station *i* → station *i-1* yields the service heading toward the line's
 *   first station.
 *
 * A line's terminals therefore yield one direction each and every other
 * station yields two. Measured on the live endpoint this covers
 * 190/190 (station × line × direction) combinations with no conflicts.
 */
import { type PlannerPlan, queryPlanner } from './planner.js';

export interface HarvestedTimetable {
  /** Canonical name of the boarding station. */
  stationName: string;
  /** Operator line id (`1`, `2`, `3`, `S1`). */
  lineId: string;
  /** Direction label as printed by the operator, e.g. `窦官`. */
  direction: string;
  /** Canonical name of the terminal the service heads toward. */
  destinationName: string;
  /** First train, `HH:MM`. */
  first: string;
  /** Last train, `HH:MM`. */
  last: string;
}

export interface TimetableHarvestLine {
  /** Operator line id. */
  lineId: string;
  /** The line's stations in official order. */
  stations: { name: string; coord: string }[];
}

export interface HarvestTimetablesResult {
  rows: HarvestedTimetable[];
  /** Stations/directions the planner did not answer. */
  gaps: string[];
}

const TIME_RE = /^\d{1,2}:\d{2}$/;

export interface TimetableHarvestOptions {
  delayMs?: number;
  retries?: number;
}

/**
 * Harvest every station's first/last train in both directions.
 *
 * Queries run sequentially with a small delay: the endpoint is a small
 * production service and 190 rapid-fire requests would be inconsiderate.
 */
export async function harvestStationTimetables(
  lines: TimetableHarvestLine[],
  opts: TimetableHarvestOptions = {}
): Promise<HarvestTimetablesResult> {
  const delayMs = opts.delayMs ?? 120;
  const rows: HarvestedTimetable[] = [];
  const gaps: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const n = line.stations.length;
    for (let i = 0; i < n; i++) {
      const here = line.stations[i]!;
      const targets: { dest: string; coord: string }[] = [];
      const ahead = line.stations[i + 1];
      const behind = line.stations[i - 1];
      if (ahead) targets.push({ dest: ahead.name, coord: ahead.coord });
      if (behind) targets.push({ dest: behind.name, coord: behind.coord });

      for (const target of targets) {
        let plan: PlannerPlan | undefined;
        try {
          plan = await queryPlanner(here.coord, target.coord, { retries: opts.retries ?? 2 });
        } catch (err) {
          gaps.push(
            `${here.name}→${target.dest}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
        if (!plan) {
          gaps.push(`${here.name}→${target.dest}: no plan`);
          continue;
        }
        // The boarding leg is the one whose boarding station is this station.
        const leg = plan.legs.find(
          (l) => !l.isWalk && l.onStation === here.name && l.offStation === target.dest
        );
        if (!leg) {
          gaps.push(`${here.name}→${target.dest}: planner returned no matching ride leg`);
          continue;
        }
        const first = leg.firstTime?.trim();
        const last = leg.lastTime?.trim();
        if (!first || !last || !TIME_RE.test(first) || !TIME_RE.test(last)) {
          gaps.push(
            `${here.name}→${target.dest}: no usable first/last (${first ?? '-'}/${last ?? '-'})`
          );
          continue;
        }
        // The direction label may itself contain parentheses (3 号线 heads
        // toward `桐木岭(省委党校)`), so the line name is matched without them.
        const direction = /轨道交通[^()（）]*\((.+?)方向\)/.exec(leg.instructions)?.[1]?.trim();
        if (!direction) {
          gaps.push(`${here.name}→${target.dest}: no direction in "${leg.instructions}"`);
          continue;
        }
        const key = `${here.name}|${line.lineId}|${direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          stationName: here.name,
          lineId: line.lineId,
          direction,
          destinationName: direction,
          first,
          last
        });
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  return { rows, gaps };
}

/**
 * First/last-train + in-vehicle segment metrics for Harbin, harvested live
 * from Baidu Direction v2.
 *
 * One pass over the adjacent station pairs yields both:
 *   - the boarding station's own first/last train per direction
 *   - the rail leg's in-vehicle duration and distance (track-to-track km)
 *
 * **Linear lines.** `down` = toward the last stop of the line order, `up` =
 * toward the first. Pair (i, i+1) is queried in both directions:
 *   i → i+1  → station i's `down` times
 *   i+1 → i  → station i+1's `up` times
 * The two termini therefore have one direction each, as they should.
 *
 * **Line 3 (closed ring).** The inner ring runs with increasing station order
 * and the outer ring against it (verified against the operator's timetable
 * sheet: 进乡街 内环 5:30/22:32, 外环 5:41/22:30). The same pair sweep covers
 * both senses: leg 1 of pair (i, i+1) is station i's inner ring, leg 2 is
 * station i+1's outer ring. A ring has no terminus, so `destination_stop_id`
 * stays unset and `direction_type` carries the meaning.
 */
import { type BaiduLeg, fetchHarbinLeg, foldStopName, type RingDirection } from './baidu.js';
import type { HarbinLineConfig } from './lines.js';
import type { HarbinStationTimes } from './normalize.js';

export interface StationRef {
  name: string;
  lon: number;
  lat: number;
}

export interface SegmentMetric {
  durationSeconds: number | null;
  distanceMeters: number | null;
}

export interface HarbinHarvest {
  /** Per-station first/last trains, in the line's station order. */
  rows: HarbinStationTimes[];
  /** In-vehicle metrics per adjacent pair, keyed by sorted `a|b` station names. */
  metrics: Map<string, SegmentMetric>;
  /** Planner legs that could not be resolved. */
  misses: string[];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface HarvestOptions {
  delayMs?: number;
  retries?: number;
}

export async function harvestHarbinLine(
  ak: string,
  cfg: HarbinLineConfig,
  refs: StationRef[],
  opts: HarvestOptions = {}
): Promise<HarbinHarvest> {
  const delay = opts.delayMs ?? 420;
  const n = refs.length;
  const rows: HarbinStationTimes[] = refs.map((r) => ({ stationName: r.name }));
  const metrics = new Map<string, SegmentMetric>();
  const misses: string[] = [];

  const record = (leg: BaiduLeg | null, label: string): boolean => {
    if (!leg?.firstTime || !leg.lastTime) {
      misses.push(label);
      return false;
    }
    return true;
  };

  const edgeCount = cfg.loop ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = refs[i]!;
    const b = refs[(i + 1) % n]!;
    const key = pairKey(a.name, b.name);

    // a → b : a's "down" times (inner ring on the loop)
    const downRing: RingDirection | undefined = cfg.loop ? 'loop_inner' : undefined;
    const legDown = await fetchHarbinLeg(
      ak,
      { from: a, to: b },
      {
        lineNameHint: cfg.baiduNameHint,
        wantOn: foldStopName(a.name),
        wantOff: foldStopName(b.name),
        wantRing: downRing
      }
    );
    if (record(legDown, `${cfg.short} ${a.name}→${b.name}`)) {
      rows[i]!.downFirst = legDown!.firstTime;
      rows[i]!.downLast = legDown!.lastTime;
    }
    if (legDown) {
      metrics.set(key, {
        durationSeconds: legDown.durationSeconds,
        distanceMeters: legDown.distanceMeters
      });
    }

    // b → a : b's "up" times (outer ring on the loop)
    const upRing: RingDirection | undefined = cfg.loop ? 'loop_outer' : undefined;
    const legUp = await fetchHarbinLeg(
      ak,
      { from: b, to: a },
      {
        lineNameHint: cfg.baiduNameHint,
        wantOn: foldStopName(b.name),
        wantOff: foldStopName(a.name),
        wantRing: upRing
      }
    );
    if (record(legUp, `${cfg.short} ${b.name}→${a.name}`)) {
      rows[(i + 1) % n]!.upFirst = legUp!.firstTime;
      rows[(i + 1) % n]!.upLast = legUp!.lastTime;
    }
    if (legUp && !metrics.has(key)) {
      metrics.set(key, {
        durationSeconds: legUp.durationSeconds,
        distanceMeters: legUp.distanceMeters
      });
    }

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  return { rows, metrics, misses };
}

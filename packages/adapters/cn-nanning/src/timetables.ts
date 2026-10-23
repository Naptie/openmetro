/**
 * Per-station first/last-train harvest for cn-nanning.
 *
 * The operator publishes its first/last-train sheets only as **PNG images** on
 * the 地铁服务 page (one sheet per line, six time columns: 首班车 ×2 directions
 * and 末班车 for 周一–周四 and 周五–周六). There is no OCR path, so every sync
 * re-queries the Baidu planner so `data/` stays live.
 *
 * Direction convention (the canonical one used throughout the repo):
 * - `down` = toward the **last** stop of the line's official order,
 * - `up`   = toward the **first** stop of the line's official order.
 *
 * The planner reports the service window at the **boarding** station, so
 * `firstTime` / `lastTime` map straight onto `first_train` / `last_train`.
 *
 * ## The weekday/weekend split
 *
 * The operator's sheets distinguish **周一至周四** from **每周五、周末及节假日**
 * — e.g. 1 号线 会展中心站 toward 火车东站 departs last at 23:41 on a weekday
 * and at 次0:41 on a Friday. The planner only ever answers for the day it is
 * queried, so the value it returns is the current day's band. The harvest
 * therefore records the band it observed, and the caller may run it once per
 * band (see `./run.ts`), because the canonical model expresses a split as a
 * 7-element weekday array.
 */
import type { BaiduStationRef } from '@openmetro/core';
import { fetchBaiduOriginLeg } from './baidu.js';
import type { NanningLineConfig } from './lines.js';

export interface HarvestedStationTimes {
  /** Canonical station name (the operator's own spelling). */
  stationName: string;
  /** Toward the last stop of the line order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Planner direction label for the `down` leg, e.g. `石埠方向`. */
  downDirection?: string | null;
  /** Toward the first stop of the line order. */
  upFirst?: string | null;
  upLast?: string | null;
  /** Planner direction label for the `up` leg, e.g. `火车东站方向`. */
  upDirection?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Which band of the operator's weekday/weekend split the planner is answering
 * for on a given day.
 *
 * The operator's sheets carry two bands — **周一至周四** and
 * **每周五、周末及节假日** — and the planner always answers for the day it is
 * queried, so the harvested value belongs to the band of the harvest date.
 * The band is published alongside the times so a consumer can tell which
 * half of the split the numbers describe.
 */
export type ServiceBand = 'mon_thu' | 'fri_weekend';

export function serviceBandFor(date: Date): ServiceBand {
  const dow = date.getDay(); // 0 = Sunday
  return dow >= 1 && dow <= 4 ? 'mon_thu' : 'fri_weekend';
}

/**
 * Destinations tried in order for one direction.
 *
 * The planner reports the **boarding station's** service window, and the leg
 * it returns travels *towards the requested destination* — so the destination
 * must lie in the intended direction, and any destination in that direction
 * yields the same answer.
 *
 * The **far** end of the direction is tried first: the planner routes a long
 * ride reliably, while an adjacent hop is often answered with a bus or a
 * BRT route. Nearer stations are only fallbacks for the planner's routing
 * holes, so the pool is capped to keep the query count bounded.
 */
export function destinationPool(
  refs: readonly BaiduStationRef[],
  originIndex: number,
  direction: 'down' | 'up',
  limit = 6
): BaiduStationRef[] {
  const n = refs.length;
  const pool: BaiduStationRef[] = [];
  if (direction === 'down') {
    // Toward the last stop: the far terminus first, then progressively nearer.
    for (let idx = n - 1; idx > originIndex; idx--) pool.push(refs[idx]!);
  } else {
    // Toward the first stop: the far terminus first, then progressively nearer.
    for (let idx = 0; idx < originIndex; idx++) pool.push(refs[idx]!);
  }
  return pool.slice(0, limit);
}

async function harvestDirection(
  ak: string,
  cfg: NanningLineConfig,
  refs: readonly BaiduStationRef[],
  index: number,
  direction: 'down' | 'up',
  opts: { delayMs: number; retries: number }
): Promise<{ first: string | null; last: string | null; label: string | null }> {
  const origin = refs[index]!;
  // The direction label the planner uses for this direction names the line's
  // terminus in that direction (石埠方向 / 火车东站方向 / …), which pins the
  // service window to the right direction.
  const terminus = refs[direction === 'down' ? refs.length - 1 : 0]!;
  const pool = destinationPool(refs, index, direction);
  for (const [i, dest] of pool.entries()) {
    if (dest.name === origin.name) continue;
    // The first candidate gets the retries; the rest are tried once each, so a
    // routing hole costs one query per destination rather than a retry storm.
    const attempts = i === 0 ? opts.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const leg = await fetchBaiduOriginLeg(
          ak,
          { name: origin.name, lon: origin.lon, lat: origin.lat },
          { lon: dest.lon, lat: dest.lat },
          cfg.short,
          { directionTerminus: terminus.name }
        );
        if (leg?.firstTime || leg?.lastTime) {
          return {
            first: leg.firstTime ?? null,
            last: leg.lastTime ?? null,
            label: leg.direction || null
          };
        }
      } catch {
        // fall through to the retry / next destination
      }
      await sleep(opts.delayMs);
    }
  }
  return { first: null, last: null, label: null };
}

/**
 * Harvest the first/last train at every station of one line, in both
 * directions.
 */
export async function harvestStationTimetables(
  ak: string,
  cfg: NanningLineConfig,
  refs: readonly BaiduStationRef[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedStationTimes[]> {
  const delayMs = opts.delayMs ?? 250;
  const retries = opts.retries ?? 1;
  const out: HarvestedStationTimes[] = [];

  for (let i = 0; i < refs.length; i++) {
    const row: HarvestedStationTimes = { stationName: refs[i]!.name };

    if (i < refs.length - 1) {
      const down = await harvestDirection(ak, cfg, refs, i, 'down', { delayMs, retries });
      row.downFirst = down.first;
      row.downLast = down.last;
      row.downDirection = down.label;
    }
    if (i > 0) {
      const up = await harvestDirection(ak, cfg, refs, i, 'up', { delayMs, retries });
      row.upFirst = up.first;
      row.upLast = up.last;
      row.upDirection = up.label;
    }

    out.push(row);
  }
  return out;
}

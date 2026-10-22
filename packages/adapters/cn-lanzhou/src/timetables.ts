/**
 * Per-station first/last-train harvest for cn-lanzhou.
 *
 * The operator publishes its first/last-train sheets only as JPEG images on
 * `/lzgd/serve.jsp` (`sbskb.jpg` / `mbskb.jpg` for Line 1, `sbskb2.jpg` /
 * `mbskb2.jpg` for Line 2). There is no OCR path, so every sync re-queries the
 * Baidu planner so `data/` stays live.
 *
 * Direction convention (the canonical one used throughout the repo):
 * - `down` = toward the **last** stop of the line's official order,
 * - `up`   = toward the **first** stop of the line's official order.
 *
 * For Line 1 (陈官营 → 东岗) that means `down` rides toward 东岗 and `up`
 * toward 陈官营; for Line 2 (东方红广场 → 雁白大桥) the other way round. The
 * terminus of a direction has no service in that direction, so it gets no
 * entry — matching the "—" cells on the operator's sheets.
 *
 * The planner reports the service window at the boarding station, so
 * `firstTime` / `lastTime` map straight onto `first_train` / `last_train`
 * (see `./baidu.ts` for the field semantics and the leg-selection rule).
 * Caveat inherited from the source: the operator's sheets carry a single
 * first/last pair per station and direction. Seasonal and holiday adjustments
 * (the operator publishes a notice whenever the service window changes) are
 * picked up because the planner is queried live, but a weekday/weekend split
 * is not expressible in any machine-readable source, so this layer publishes
 * one variant per station and direction.
 */
import type { BaiduStationRef } from '@openmetro/core';
import { fetchBaiduOriginLeg } from './baidu.js';
import type { LanzhouLineConfig } from './lines.js';

export interface HarvestedStationTimes {
  /** Station name as the operator publishes it (no 站 suffix). */
  stationName: string;
  /** Toward the last stop of the line order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Planner direction label for the `down` leg, e.g. `东岗方向`. */
  downDirection?: string | null;
  /** Toward the first stop of the line order. */
  upFirst?: string | null;
  upLast?: string | null;
  /** Planner direction label for the `up` leg, e.g. `陈官营方向`. */
  upDirection?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Destinations tried in order for one direction.
 *
 * The planner reports the **boarding station's** service window, and the leg
 * it returns travels *towards the requested destination* — so the destination
 * must lie in the intended direction, and any destination in that direction
 * yields the same answer.
 *
 * That makes the destination a free parameter for working around the
 * planner's routing holes, which are substantial: at the moment
 * 东方红广场 → 东岗 is answered with a route that has no rail leg at all,
 * while 东方红广场 → 五里铺 (same direction) returns the Line 1 leg with the
 * right window. The holes are not contiguous, so **every** station in the
 * direction is tried — nearest first, which is also the cheapest to reach.
 */
export function destinationPool(
  refs: readonly BaiduStationRef[],
  originIndex: number,
  direction: 'down' | 'up'
): BaiduStationRef[] {
  const n = refs.length;
  const step = direction === 'down' ? 1 : -1;
  const pool: BaiduStationRef[] = [];
  for (let k = 1; originIndex + step * k >= 0 && originIndex + step * k < n; k++) {
    const ref = refs[originIndex + step * k]!;
    if (!pool.some((p) => p.name === ref.name)) pool.push(ref);
  }
  return pool;
}

async function harvestDirection(
  ak: string,
  cfg: LanzhouLineConfig,
  refs: readonly BaiduStationRef[],
  index: number,
  direction: 'down' | 'up',
  opts: { delayMs: number; retries: number }
): Promise<{ first: string | null; last: string | null; label: string | null }> {
  const origin = refs[index]!;
  // The direction label the planner uses for this direction names the line's
  // terminus in that direction (东岗方向 / 陈官营方向 / 雁白大桥方向 /
  // 东方红广场方向), which pins the service window to the right direction.
  const terminus = refs[direction === 'down' ? refs.length - 1 : 0]!;
  const pool = destinationPool(refs, index, direction);
  for (const [i, dest] of pool.entries()) {
    if (dest.name === origin.name) continue;
    // The first candidate gets the retries; the rest are tried once each, so
    // a routing hole costs one query per station rather than a retry storm.
    const attempts = i === 0 ? opts.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const leg = await fetchBaiduOriginLeg(
          ak,
          { name: origin.name, lon: origin.lon, lat: origin.lat },
          { lon: dest.lon, lat: dest.lat },
          cfg.baiduNameHint,
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
  cfg: LanzhouLineConfig,
  refs: readonly BaiduStationRef[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedStationTimes[]> {
  const delayMs = opts.delayMs ?? 300;
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

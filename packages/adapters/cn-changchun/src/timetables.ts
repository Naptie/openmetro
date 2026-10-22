/**
 * First/last-train harvest for cn-changchun via the Baidu planner.
 *
 * The operator publishes its per-station timetable only as JPEG images
 * (`/1hx4` … `/8hx4`, plus the combined 首末班及换乘时间表 notice of
 * 2026-09-28), so — like cn-jinan, cn-urumqi, cn-xian and cn-shijiazhuang —
 * every sync re-queries the planner so `data/` stays live. There is no OCR
 * path.
 *
 * Two properties of the Changchun feed shape this module:
 *
 * 1. **The official API and the published sheet disagree on line 1.** The
 *    operator's own `POST /api/v1/getLines` carries per-station first/last
 *    trains, and they match the published sheet on lines 2–8 — but on line 1
 *    the down-first is 10 minutes early and the up-last 12–14 minutes late
 *    (北环城路: API 05:40 / Baidu 05:50, sheet 05:50). The planner agrees with
 *    the sheet on every probed pair, so the planner is the primary source and
 *    the official feed only fills gaps.
 *
 * 2. **The planner's `first_time` / `last_time` are the boarding station's
 *    own departures** in that direction, so one query per station and
 *    direction is enough — the destination only has to lie ahead on the same
 *    line, so the nearest stop ahead is tried first.
 *
 * The official feed's direction convention differs from the operator's
 * timetable sheet: the API's `up` points at `standList[0]` and its `down` at
 * `standList[last]`, while the sheet's 上行/下行 labels are chosen per line.
 * This module works in the API's convention (`up` / `down`) and never mixes
 * the two.
 */
import type { BaiduStationRef } from '@openmetro/core';
import { fetchBaiduTransitLegs, foldStopName } from './baidu.js';
import type { ChangchunLineConfig } from './lines.js';

export interface HarvestedStationTimes {
  /** Station name as the operator publishes it. */
  stationName: string;
  /** Towards the last station of the line order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Planner direction label for the `down` leg, e.g. `红嘴子方向`. */
  downDirection?: string | null;
  /** Towards the first station of the line order. */
  upFirst?: string | null;
  upLast?: string | null;
  /** Planner direction label for the `up` leg, e.g. `北环城路方向`. */
  upDirection?: string | null;
}

/** Destinations tried in order; the nearest stop ahead is the cheapest query. */
const DEST_OFFSETS = [1, 2, 3, 5, 8];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Does a planner direction label point at `terminus`?
 *
 * Changchun's termini are unambiguous (北环城路/红嘴子, 汽车公园/雾开河大街,
 * 伪满皇宫/长影世纪城, 长春站北/天新路, 卓越大街/东大桥, 双丰/长影世纪城,
 * 汽车公园/东环城路, 北环城路/广通路), so a plain substring test is enough.
 */
export function directionTargets(directText: string, terminus: string): boolean {
  if (!directText || !terminus) return false;
  return directText.includes(terminus);
}

async function harvestDirection(
  ak: string,
  cfg: ChangchunLineConfig,
  refs: BaiduStationRef[],
  index: number,
  direction: 'down' | 'up',
  opts: { delayMs: number; retries: number }
): Promise<{ first: string | null; last: string | null; label: string | null }> {
  const n = refs.length;
  const terminusIdx = direction === 'down' ? n - 1 : 0;
  const terminus = refs[terminusIdx]!;

  const destIdxs: number[] = [];
  for (const off of DEST_OFFSETS) {
    const idx = direction === 'down' ? index + off : index - off;
    if (idx >= 0 && idx < n && !destIdxs.includes(idx)) destIdxs.push(idx);
  }
  if (!destIdxs.includes(terminusIdx)) destIdxs.push(terminusIdx);

  for (const destIdx of destIdxs) {
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      const legs = await fetchBaiduTransitLegs(ak, refs[index]!, refs[destIdx]!).catch(() => []);
      const leg = legs.find(
        (l) =>
          l.lineName.includes(cfg.baiduNameHint) &&
          foldStopName(l.onStation) === foldStopName(refs[index]!.name) &&
          directionTargets(l.direction, terminus.name) &&
          l.firstTime != null &&
          l.lastTime != null
      );
      if (leg) return { first: leg.firstTime, last: leg.lastTime, label: leg.direction };
      await sleep(opts.delayMs);
    }
  }
  return { first: null, last: null, label: null };
}

/**
 * Harvest the first/last train at every station of one line, in both
 * directions.
 *
 * The terminus of a direction has no departure in it, so it is left empty.
 */
export async function harvestStationTimetables(
  ak: string,
  cfg: ChangchunLineConfig,
  refs: BaiduStationRef[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedStationTimes[]> {
  const delayMs = opts.delayMs ?? 320;
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

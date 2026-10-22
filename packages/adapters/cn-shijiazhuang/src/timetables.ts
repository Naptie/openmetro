/**
 * First/last-train harvest for cn-shijiazhuang via Baidu Direction v2.
 *
 * The operator publishes its per-station first/last-train sheet only as PNG
 * images on `/service/routes.html` (3 lines × 工作日/双休日); there is no OCR
 * path, so — like cn-jinan and cn-urumqi — every sync re-queries the planner
 * so `data/` stays live.
 *
 * The operator's own route planner cannot be used for this: `/metro/
 * recommend.html` returns the **network-wide** operating window (a flat
 * 06:30/22:30 for every station on a line) instead of per-station first/last
 * trains, and its 工作日/双休日 columns always carry the same pair. The
 * planner's `detail.first_time` / `detail.last_time`, by contrast, are the
 * boarding station's own first/last **departures** and match the published
 * sheet on every probed pair (see `baidu.ts`).
 *
 * One caveat is inherent to the source: the sheet distinguishes 工作日 from
 * 双休日 per station, but neither the planner nor any official machine
 * readable endpoint exposes that split. This adapter therefore publishes a
 * single timetable variant per station and direction; the weekday/weekend
 * difference is only available from the operator's image sheets.
 */
import type { BaiduStationRef } from '@openmetro/core';
import { fetchBaiduTransitLegs, foldStopName } from './baidu.js';
import type { ShijiazhuangLineConfig } from './lines.js';

export interface HarvestedStationTimes {
  /** Station name as the operator publishes it (no 站 suffix). */
  stationName: string;
  /** Toward the last station of the line order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Planner direction label for the `down` leg, e.g. `福泽方向`. */
  downDirection?: string | null;
  /** Toward the first station of the line order. */
  upFirst?: string | null;
  upLast?: string | null;
  /** Planner direction label for the `up` leg, e.g. `西王方向`. */
  upDirection?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Destination offsets tried in order; 1 hop is enough on v2, the terminus is the backstop. */
const DEST_OFFSETS = [1, 2, 3, 5, 8];

/**
 * Does a planner direction label point at `terminus`?
 *
 * Shijiazhuang's termini are unambiguous (西王/福泽, 嘉华路/柳辛庄,
 * 西三庄/乐乡), but 石家庄东站 and 石家庄站 share a prefix, so a label that
 * names a longer station must not validate for the shorter one.
 */
export function directionTargets(directText: string, terminus: string): boolean {
  if (!directText || !terminus) return false;
  return directText.includes(terminus);
}

async function harvestDirection(
  ak: string,
  cfg: ShijiazhuangLineConfig,
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
 */
export async function harvestStationTimetables(
  ak: string,
  cfg: ShijiazhuangLineConfig,
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

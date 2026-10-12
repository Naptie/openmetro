/**
 * First/last-train harvest for cn-urumqi via Baidu Direction v2.
 *
 * The operator publishes its timetable only as a static image on
 * urumqimtr.com; there is no OCR path, so — like cn-jinan — every sync
 * re-queries the planner. The city-agnostic core harvest
 * (`harvestBaiduTimetables`) cannot be used as-is for this network:
 *
 * 1. It targets the far terminus over the shared `directionlite/v1` API and
 *    derives the last train as `end_info.end_time` − leg duration (arrival
 *    semantics). On Ürümqi data `v1` offers no rail legs for short hops or
 *    the APM at all, and `direction/v2`'s `detail.last_time` is verified
 *    (see `baidu.ts`) to already BE the last departure at the boarding
 *    station — subtracting the ride time would understate every last train
 *    by up to ~50 minutes.
 * 2. It does not verify that the returned leg actually boards at the queried
 *    station; Ürümqi probes produced planner routes whose rail leg boards
 *    elsewhere (e.g. a 南门→二道桥 OD returning a 二道桥→三屯碑 leg).
 *
 * This module therefore harvests per adjacent station pair (the planner
 * serves rail legs for 1-hop ODs on v2), validating the boarding station and
 * the direction label for every leg.
 *
 * Schedule caveat: the operator temporarily extends operating hours by ~1 h
 * during the summer peak season and reverts afterwards (latest cycle:
 * 2026-07-01 extension, 2026-10-08 reversion). The planner keeps the
 * regular timetable, so last trains harvested during an extension run
 * ~1 h earlier than the operator's extended service; first trains are
 * unaffected. Operator announcements are authoritative during extensions
 * (see `baidu.ts` and the network notes).
 */
import type { BaiduStationRef } from '@openmetro/core';
import { directionTargets, fetchBaiduTransitLegs, foldStopName } from './baidu.js';
import type { UrumqiLineConfig } from './lines.js';

export interface HarvestedStationTimes {
  stationName: string;
  /** Toward the last station of the AMap order (line headsign: last stop). */
  downFirst?: string | null;
  downLast?: string | null;
  /** Toward the first station of the AMap order. */
  upFirst?: string | null;
  upLast?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Destination offsets tried in order; 1 hop is enough on v2, terminus is the backstop. */
const DEST_OFFSETS = [1, 2, 3, 5, 8];

async function harvestDirection(
  ak: string,
  cfg: UrumqiLineConfig,
  refs: BaiduStationRef[],
  index: number,
  direction: 'down' | 'up',
  opts: { delayMs: number; retries: number }
): Promise<{ first: string | null; last: string | null }> {
  const n = refs.length;
  const terminusIdx = direction === 'down' ? n - 1 : 0;
  const otherIdx = direction === 'down' ? 0 : n - 1;
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
          directionTargets(l.direction, refs[terminusIdx]!.name, refs[otherIdx]!.name) &&
          l.firstTime != null &&
          l.lastTime != null
      );
      if (leg) return { first: leg.firstTime, last: leg.lastTime };
      await sleep(opts.delayMs);
    }
  }
  return { first: null, last: null };
}

export async function harvestStationTimetables(
  ak: string,
  cfg: UrumqiLineConfig,
  refs: BaiduStationRef[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedStationTimes[]> {
  const delayMs = opts.delayMs ?? 380;
  const retries = opts.retries ?? 1;
  const n = refs.length;
  const out: HarvestedStationTimes[] = [];
  for (let i = 0; i < n; i++) {
    const row: HarvestedStationTimes = { stationName: refs[i]!.name };
    if (i < n - 1) {
      const down = await harvestDirection(ak, cfg, refs, i, 'down', { delayMs, retries });
      row.downFirst = down.first;
      row.downLast = down.last;
    }
    if (i > 0) {
      const up = await harvestDirection(ak, cfg, refs, i, 'up', { delayMs, retries });
      row.upFirst = up.first;
      row.upLast = up.last;
    }
    out.push(row);
  }
  return out;
}

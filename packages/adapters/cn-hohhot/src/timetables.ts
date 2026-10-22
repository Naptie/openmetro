/**
 * First/last-train harvest for cn-hohhot via Baidu Direction v2.
 *
 * The operator publishes its 首末班车时刻一览表 as a sheet image on
 * `www.hhhtmetro.com`; there is no OCR path, so — like `cn-jinan` and
 * `cn-urumqi` — every sync re-queries the planner. The city-agnostic core
 * harvest (`harvestBaiduTimetables`) cannot be used as-is for this network:
 *
 * 1. It targets the far terminus over the shared `directionlite/v1` API and
 *    derives the last train as `end_info.end_time` − leg duration (arrival
 *    semantics). On Hohhot data `v2`'s `detail.last_time` is verified (see
 *    `baidu.ts`) to already BE the last departure at the boarding station —
 *    subtracting the ride time would understate every last train by up to
 *    ~50 minutes.
 * 2. It does not verify that the returned leg actually boards at the queried
 *    station.
 *
 * This module therefore queries `direction/v2/transit` per station and
 * direction, validating the operator line, the boarding station and the
 * direction label for every leg.
 *
 * Two official cross-checks run against the harvest (see
 * `OFFICIAL_TERMINUS_TIMES` / `OFFICIAL_TIMETABLE_SAMPLE` in `lines.ts`):
 * the end-of-line times the operator publishes must match exactly, and a
 * sample of the per-station sheet must not differ by more than 15 minutes —
 * the sheet is a 2020-07 reading whose end-of-line times have since been
 * revised, so a small drift is expected there.
 */
import {
  type BaiduStationRef,
  deriveSegmentTimes,
  type PatternEncoded,
  parseHHMM,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';
import { directionTargets, fetchBaiduTransitLegs, foldPlannerStopName } from './baidu.js';
import {
  type HohhotLineConfig,
  OFFICIAL_TERMINUS_TIMES,
  OFFICIAL_TIMETABLE_SAMPLE
} from './lines.js';

export interface HarvestedStationTimes {
  /** Canonical station name. */
  stationName: string;
  /** Toward the last station of the AMap order (line headsign: last stop). */
  downFirst?: string | null;
  downLast?: string | null;
  /** Toward the first station of the AMap order. */
  upFirst?: string | null;
  upLast?: string | null;
}

export interface LineHarvest {
  cfg: HohhotLineConfig;
  /** Canonical station names in AMap order. */
  order: string[];
  rows: HarvestedStationTimes[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Destinations tried in order; the far terminus is the primary target. */
const DEST_OFFSETS = [1, 2, 3, 5, 8];

async function harvestDirection(
  ak: string,
  cfg: HohhotLineConfig,
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
          foldPlannerStopName(l.onStation) === foldPlannerStopName(refs[index]!.name) &&
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

/**
 * Harvest the first/last departure at every station in both directions of one
 * line. The station that is a line's terminus has no departure in the
 * direction pointing away from the line, so that slot stays empty.
 *
 * A second pass re-queries any direction the first pass missed: the planner
 * occasionally drops a rail leg for one OD, and losing a single row would
 * leave a station without a timetable in that direction.
 */
export async function harvestStationTimetables(
  ak: string,
  cfg: HohhotLineConfig,
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

  // Second pass for the directions the first pass left empty.
  for (let i = 0; i < n; i++) {
    const row = out[i]!;
    if (i < n - 1 && !(row.downFirst || row.downLast)) {
      const down = await harvestDirection(ak, cfg, refs, i, 'down', {
        delayMs,
        retries: retries + 2
      });
      row.downFirst = down.first;
      row.downLast = down.last;
    }
    if (i > 0 && !(row.upFirst || row.upLast)) {
      const up = await harvestDirection(ak, cfg, refs, i, 'up', {
        delayMs,
        retries: retries + 2
      });
      row.upFirst = up.first;
      row.upLast = up.last;
    }
  }

  return out;
}

/** Minutes since midnight, or null when the value is not a time. */
function minutesOf(hhmm: string | null | undefined): number | null {
  const t = parseHHMM(hhmm ?? '');
  return t == null ? null : t;
}

/**
 * Derive segment times from **both** ends of every pattern.
 *
 * `deriveSegmentTimes` derives one orientation per pattern — the one that
 * covers more stops. On a linear line both orientations cover the same number
 * of stops, so the segment *into* the far terminus (which has no departure in
 * that direction) is never derived. Deriving the reversed pattern as well
 * covers it: the two chains read the same undirected edges from opposite
 * ends, and `applyDerivedTimes` accepts either orientation of a stop pair.
 */
export function deriveSegmentTimesBothDirections(
  patterns: PatternEncoded[],
  stops: StopEncoded[],
  timetables: TimetableEncoded[]
): ReturnType<typeof deriveSegmentTimes> {
  const forward = deriveSegmentTimes(patterns, stops, timetables, {});
  const reversed = patterns.map((p) => ({
    ...p,
    stop_ids: [...p.stop_ids].reverse(),
    origin_stop_id: p.terminal_stop_id,
    terminal_stop_id: p.origin_stop_id
  }));
  const backward = deriveSegmentTimes(reversed, stops, timetables, {});
  return [...forward, ...backward];
}

/**
 * Cross-check the harvest against the operator's published sheets.
 *
 * - `OFFICIAL_TERMINUS_TIMES` (current): must match exactly (2-minute
 *   tolerance for rounding). A larger drift means the planner data moved
 *   away from the published end-of-line times and needs review.
 * - `OFFICIAL_TIMETABLE_SAMPLE` (2020-07 sheet): may differ by up to 15
 *   minutes — the sheet's end-of-line times have been revised since, so the
 *   per-station values drift by a few minutes.
 */
export function checkOfficialTimetableAgreement(harvests: LineHarvest[]): void {
  const rowByStation = new Map<string, HarvestedStationTimes>();
  const slotByStation = new Map<string, 'down' | 'up'>();

  for (const h of harvests) {
    for (const row of h.rows) {
      rowByStation.set(`${h.cfg.slug}:${row.stationName}`, row);
      // A terminus departs only toward the other end of its line.
      const isFirst = h.order[0] === row.stationName;
      slotByStation.set(`${h.cfg.slug}:${row.stationName}`, isFirst ? 'down' : 'up');
    }
  }

  const findSlot = (
    station: string
  ): { row: HarvestedStationTimes; slot: 'down' | 'up' } | undefined => {
    for (const h of harvests) {
      const key = `${h.cfg.slug}:${station}`;
      const row = rowByStation.get(key);
      const slot = slotByStation.get(key);
      if (row && slot) return { row, slot };
    }
    return undefined;
  };

  let terminusChecked = 0;
  let terminusDrift = 0;
  for (const check of OFFICIAL_TERMINUS_TIMES) {
    const hit = findSlot(check.station);
    if (!hit) continue;
    const got = hit.slot === 'down' ? hit.row.downLast : hit.row.upLast;
    const gotFirst = hit.slot === 'down' ? hit.row.downFirst : hit.row.upFirst;
    if (got == null) continue;
    terminusChecked++;
    const drift = Math.abs((minutesOf(got) ?? 0) - (minutesOf(check.last) ?? 0));
    if (drift > 2) {
      terminusDrift++;
      console.log(
        `  OFFICIAL TIMETABLE MISMATCH ${check.station}: planner=${got} official=${check.last} ` +
          `(drift ${drift} min) — review the operator's published 首末站首末班车时间一览表`
      );
    }
    const firstDrift = Math.abs((minutesOf(gotFirst) ?? 0) - (minutesOf(check.first) ?? 0));
    if (firstDrift > 2) {
      terminusDrift++;
      console.log(
        `  OFFICIAL TIMETABLE MISMATCH ${check.station} first train: planner=${gotFirst} ` +
          `official=${check.first} (drift ${firstDrift} min) — review the operator's published sheet`
      );
    }
  }

  let sampleChecked = 0;
  let sampleDrift = 0;
  for (const check of OFFICIAL_TIMETABLE_SAMPLE) {
    // The sheet names the direction by its terminus. A station served by two
    // lines (新华广场) has a different direction on each, so pick the line
    // that actually heads toward the sampled terminus.
    const target = harvests.find((h) => {
      if (!h.order.includes(check.station)) return false;
      return (
        (h.order[h.order.length - 1]?.startsWith(check.toward) ?? false) ||
        (h.order[0]?.startsWith(check.toward) ?? false)
      );
    });
    if (!target) continue;
    const row = target.rows.find((r) => r.stationName === check.station);
    if (!row) continue;
    const isTowardLast = target.order[target.order.length - 1]?.startsWith(check.toward);
    const got = isTowardLast ? row.downLast : row.upLast;
    const gotFirst = isTowardLast ? row.downFirst : row.upFirst;
    if (got == null || gotFirst == null) continue;
    sampleChecked++;
    const lastDrift = Math.abs((minutesOf(got) ?? 0) - (minutesOf(check.last) ?? 0));
    const firstDrift = Math.abs((minutesOf(gotFirst) ?? 0) - (minutesOf(check.first) ?? 0));
    if (lastDrift > 15 || firstDrift > 15) {
      sampleDrift++;
      console.log(
        `  OFFICIAL TIMETABLE DRIFT ${check.station} 往${check.toward}: planner=${gotFirst}/${got} ` +
          `official-sheet=${check.first}/${check.last} — review the published 时刻表`
      );
    }
  }

  console.log(
    `  official timetable check: ${terminusChecked} end-of-line rows ` +
      `(${terminusDrift} mismatches), ${sampleChecked} sampled rows (${sampleDrift} drifted)`
  );
}

/**
 * First/last-train handling for cn-dalian.
 *
 * The operator publishes timetables only through the 大连地铁 APP / WeChat
 * mini-program (as images); no machine-readable timetable has ever existed on
 * the web. Every sync therefore re-queries the Baidu Direction Lite planner via
 * the city-agnostic core harvest (`harvestBaiduTimetables`) and no OCR is used.
 *
 * Measured 2026-10: all six lines (seven alignments incl. the 3号线 九里支线)
 * return a metro leg for every station in both directions — 202/202 slots.
 * Times cross-check against the operator's published timetable (1/2/3/5/12/13
 * 号线 全部精确一致, including the 13号线 2025-11-03 revision).
 */
import { parseHHMM } from '@openmetro/core';

export interface LinearStationTimes {
  stationName: string;
  /** Toward the last station of the alignment order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Toward the first station of the alignment order. */
  upFirst?: string | null;
  upLast?: string | null;
}

export type HarvestedStationTimes = LinearStationTimes;

/**
 * First/last times must be non-decreasing along the alignment order in the
 * departure direction; if the planner mirrored the two ends, swap them.
 *
 * Dalian's planner direction labels are reliable, but the 3号线 保税区小交路
 * makes one OD expose two distinct 地铁3号线 legs — `harvestBaiduTimetables`
 * already returns the first, and this guard catches the remaining mirror case.
 */
export function fixLinearRowDirection(rows: LinearStationTimes[]): {
  rows: LinearStationTimes[];
  swapped: boolean;
} {
  const mins = (s: string | null | undefined) => (s ? parseHHMM(s) : null);
  let inc = 0;
  let dec = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = mins(rows[i - 1]!.downFirst);
    const b = mins(rows[i]!.downFirst);
    if (a == null || b == null) continue;
    if (b >= a) inc++;
    else dec++;
  }
  if (dec > inc && dec >= 2) {
    return {
      swapped: true,
      rows: rows.map((r) => ({
        stationName: r.stationName,
        downFirst: r.upFirst,
        downLast: r.upLast,
        upFirst: r.downFirst,
        upLast: r.downLast
      }))
    };
  }
  return { rows, swapped: false };
}

/** Merge a core harvest into per-station linear times (alignment order). */
export function linearTimesFromHarvest(
  stationNames: readonly string[],
  harvested: readonly {
    stationName: string;
    direction: 'down' | 'up';
    first?: string | null;
    last?: string | null;
  }[]
): LinearStationTimes[] {
  const rows: LinearStationTimes[] = stationNames.map((stationName) => ({ stationName }));
  const idx = new Map(stationNames.map((n, i) => [n.trim(), i] as const));
  for (const h of harvested) {
    const i = idx.get(h.stationName.trim());
    if (i == null) continue;
    const row = rows[i]!;
    if (h.direction === 'down') {
      row.downFirst = h.first ?? row.downFirst;
      row.downLast = h.last ?? row.downLast;
    } else {
      row.upFirst = h.first ?? row.upFirst;
      row.upLast = h.last ?? row.upLast;
    }
  }
  return rows;
}

/** All Dalian services run a single daily schedule → Mon..Sun array. */
export function weekArray(std: string | null | undefined): string[] {
  const s = std ?? undefined;
  return s ? [s] : [];
}

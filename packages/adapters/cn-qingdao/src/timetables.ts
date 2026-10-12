/**
 * First/last-train harvest for cn-qingdao via Baidu Direction Lite.
 *
 * The operator publishes its timetables only through the 青岛地铁 APP / WeChat
 * (as images) — the website has never carried a machine-readable timetable
 * (the Wayback-archived ditieadmin pages were 720° station tours). Every line
 * is linear, so the city-agnostic core harvest (`harvestBaiduTimetables`)
 * covers the whole network; every sync re-queries the planner so `data/`
 * stays live.
 */
import { parseHHMM } from '@openmetro/core';

export interface LinearStationTimes {
  stationName: string;
  /** Toward the last station of the line order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Toward the first station of the line order. */
  upFirst?: string | null;
  upLast?: string | null;
}

export type HarvestedStationTimes = LinearStationTimes;

/**
 * First/last times must be non-decreasing along the line order in the
 * departure direction; if the planner mirrored the two ends, swap them.
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

/** Merge a core harvest into per-station linear times (line order). */
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

/** All Qingdao services run a single daily schedule → Mon..Sun array. */
export function weekArray(std: string | null | undefined): string[] {
  const s = std ?? undefined;
  return s ? [s] : [];
}

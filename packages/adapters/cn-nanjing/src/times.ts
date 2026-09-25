/**
 * Timetable cell helpers. First/last trains come from Baidu Direction Lite
 * (`baidu-timetables.ts`) — there is no OCR path and no local cache: every
 * sync re-queries the official/route sources so `data/` stays live.
 */

export interface ParsedTimetableImage {
  stem: string;
  rows: StationTimes[];
  coverage: { stations: number; withTimes: number };
  notes: string[];
}

export interface StationTimes {
  stationName: string;
  downFirst?: string | null;
  downLastStd?: string | null;
  downLastFri?: string | null;
  upFirst?: string | null;
  upLastStd?: string | null;
  upLastFri?: string | null;
}

/**
 * Official stationOrder is one terminus → the other. Down-side times should
 * have first/last non-decreasing along that order; if a source mirrors
 * left/right, swap the two directions.
 */
export function fixRowDirection(rows: StationTimes[]): {
  rows: StationTimes[];
  swapped: boolean;
} {
  const mins = (s: string | null | undefined) => {
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
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
        downLastStd: r.upLastStd,
        downLastFri: r.upLastFri,
        upFirst: r.downFirst,
        upLastStd: r.downLastStd,
        upLastFri: r.downLastFri
      }))
    };
  }
  return { rows, swapped: false };
}

/** Nanjing: 周日至周四 standard, 周五周六 extended → Mon..Sun array. */
export function weekArray(
  std: string | null | undefined,
  friSat: string | null | undefined
): string[] {
  const s = std ?? undefined;
  const f = friSat ?? std ?? undefined;
  if (!s && !f) return [];
  const stdVal = s ?? f!;
  const friVal = f ?? s!;
  return [stdVal, stdVal, stdVal, stdVal, friVal, friVal, stdVal];
}

import type { HarvestedStationDir } from './baidu-timetables.js';

/** Merge Baidu harvest rows into per-station times (official order). */
export function stationTimesFromBaidu(
  stationNames: readonly string[],
  harvested: readonly HarvestedStationDir[]
): StationTimes[] {
  const rows: StationTimes[] = stationNames.map((stationName) => ({ stationName }));
  const idx = new Map(stationNames.map((n, i) => [n.trim(), i]));
  for (const h of harvested) {
    const i = idx.get(h.stationName.trim());
    if (i == null) continue;
    const row = rows[i]!;
    if (h.direction === 'down') {
      row.downFirst = h.first ?? row.downFirst;
      row.downLastStd = h.last ?? row.downLastStd;
      row.downLastFri = h.last ?? row.downLastFri;
    } else {
      row.upFirst = h.first ?? row.upFirst;
      row.upLastStd = h.last ?? row.upLastStd;
      row.upLastFri = h.last ?? row.upLastFri;
    }
  }
  return rows;
}

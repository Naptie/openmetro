import {
  hasValidTimes,
  normalizeTimetableTimes,
  type PatternEncoded,
  type StationEncoded,
  type StopEncoded,
  type TimetableEncoded
} from '@openmetro/core';
import type { ZdxxDayRow, ZdxxStationResponse } from './fetch.js';

const SOURCE_ID = 'szmc-zdxx';

function foldName(zh: string): string {
  return (zh || '').replace(/站$/, '').trim();
}

/** Official clock string → HH:MM; `--` / empty → undefined. */
function toHHMM(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t || t === '--' || t === '—' || t === '-') return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m) return undefined;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** `"13号线"` / `"6号线支线"` → line short_name key. */
export function lineShortFromZdxx(suoshuluxian: string | undefined): string | undefined {
  if (!suoshuluxian) return undefined;
  const s = suoshuluxian.trim();
  if (/6号线支线|6支/.test(s)) return '6支';
  const m = /(\d+)\s*号线/.exec(s);
  if (m) return m[1];
  return undefined;
}

type DayBucket = { first?: string; last?: string };

function extractDayBucket(row: ZdxxDayRow): {
  destA?: string;
  destB?: string;
  destAEn?: string;
  destBEn?: string;
  a: DayBucket;
  b: DayBucket;
  lineLabel?: string;
  headwayPeak?: string;
  headwayOff?: string;
} {
  return {
    destA: foldName(row.xinshifangxiang || ''),
    destB: foldName(row.xinshifangxiangxia || ''),
    destAEn: row.xinshifangxiangen?.trim() || undefined,
    destBEn: row.xinshifangxiangxiaen?.trim() || undefined,
    a: { first: toHHMM(row.shoubanche), last: toHHMM(row.mobanche) },
    b: { first: toHHMM(row.shoubanchexia), last: toHHMM(row.mobanchexia) },
    lineLabel: row.suoshuluxian?.trim() || undefined,
    headwayPeak: row.gaofenjiange?.trim() || undefined,
    headwayOff: row.pingjunjiange?.trim() || undefined
  };
}

function timesEqual(x?: string, y?: string): boolean {
  return (x ?? '') === (y ?? '');
}

export type ZdxxTimetableInput = {
  networkId: string;
  records: Map<string, ZdxxStationResponse | null>;
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
};

/**
 * Schema mapping for SZMC `/zdxx`:
 *
 * - `first_train` / `last_train` — length 7 (Mon..Sun): Mon–Fri = 工作日,
 *   Sat–Sun = 休息日. Length 1 when both calendars agree.
 * - Holiday calendar is not a weekly slot; keep official holiday first/last
 *   in `extras.holidays` and `first_train_desc`.
 * - `service`: `all_days` (len 1) or `weekly` (len 7).
 * - `extras` also stores headways + raw direction labels + raw buckets.
 */
export function buildTimetablesFromZdxx(input: ZdxxTimetableInput): TimetableEncoded[] {
  const patternByLine = new Map(input.patterns.map((p) => [p.line_id, p]));
  const lineByShort = new Map<string, string>();
  for (const stop of input.stops) {
    const short = (stop.extras as { line_short_name?: string } | undefined)?.line_short_name;
    if (short) {
      lineByShort.set(short, stop.line_id);
    } else {
      const m = /cn-shenzhen-line-(.+)$/.exec(stop.line_id);
      if (m) {
        const key = m[1] === '6z' ? '6支' : m[1];
        if (!lineByShort.has(key)) lineByShort.set(key, stop.line_id);
      }
    }
  }

  const stationsOnLine = new Map<string, StationEncoded[]>();
  for (const stop of input.stops) {
    const list = stationsOnLine.get(stop.line_id) ?? [];
    const st = input.stations.find((s) => s.id === stop.station_id);
    if (st && !list.some((x) => x.id === st.id)) list.push(st);
    stationsOnLine.set(stop.line_id, list);
  }

  const stopIdByLineStation = new Map<string, string>();
  for (const stop of input.stops) {
    stopIdByLineStation.set(`${stop.line_id}|${stop.station_id}`, stop.id);
  }

  const out: TimetableEncoded[] = [];
  const seen = new Set<string>();

  const resolveDestStop = (
    lineId: string,
    destZh: string,
    originStationId: string
  ): string | undefined => {
    const target = foldName(destZh);
    if (!target) return undefined;
    const pattern = patternByLine.get(lineId);
    const cands = stationsOnLine.get(lineId) ?? [];
    let hit = cands.find(
      (s) => foldName(s.name) === target || foldName(s.names?.zh || '') === target
    );
    if (!hit) {
      hit = cands.find((s) => {
        const n = foldName(s.name);
        return n.includes(target) || target.includes(n);
      });
    }
    if (hit) {
      return stopIdByLineStation.get(`${lineId}|${hit.id}`) ?? pattern?.terminal_stop_id;
    }
    const origin = input.stations.find((s) => s.id === originStationId);
    if (origin && foldName(origin.name) === target) {
      return stopIdByLineStation.get(`${lineId}|${originStationId}`);
    }
    return pattern?.terminal_stop_id;
  };

  for (const [stationCode, resp] of input.records) {
    if (!resp) continue;
    if (!resp.siteName && !resp.workDay?.length && !resp.dayoff?.length) continue;
    const siteName = foldName(resp.siteName || stationCode);
    const station =
      input.stations.find((s) => {
        const codes = (s.extras as { official_codes?: string[] } | undefined)?.official_codes;
        return codes?.includes(stationCode);
      }) || input.stations.find((s) => foldName(s.name) === siteName);
    if (!station) continue;

    const workRows = resp.workDay ?? [];
    const dayoffRows = resp.dayoff ?? [];
    const holidayRows = resp.holidays ?? [];

    const lineShorts = new Set<string>();
    for (const row of [...workRows, ...dayoffRows, ...holidayRows]) {
      const short = lineShortFromZdxx(row.suoshuluxian);
      if (short) lineShorts.add(short);
    }
    if (lineShorts.size === 0) {
      for (const stop of input.stops.filter((s) => s.station_id === station.id)) {
        const short = (stop.extras as { line_short_name?: string } | undefined)?.line_short_name;
        if (short) lineShorts.add(short);
      }
    }

    for (const short of lineShorts) {
      const lineId = lineByShort.get(short);
      if (!lineId) continue;
      const stopId = stopIdByLineStation.get(`${lineId}|${station.id}`);
      const pattern = patternByLine.get(lineId);
      if (!stopId || !pattern) continue;

      // Match rows by official line label; do not fall back to another line's row.
      const workRow = workRows.find((r) => lineShortFromZdxx(r.suoshuluxian) === short);
      const dayRow = dayoffRows.find((r) => lineShortFromZdxx(r.suoshuluxian) === short);
      const holRow = holidayRows.find((r) => lineShortFromZdxx(r.suoshuluxian) === short);
      const work = workRow ? extractDayBucket(workRow) : undefined;
      const rest = dayRow ? extractDayBucket(dayRow) : undefined;
      const hol = holRow ? extractDayBucket(holRow) : undefined;

      for (const dir of ['A', 'B'] as const) {
        const destZh =
          dir === 'A'
            ? work?.destA || rest?.destA || hol?.destA
            : work?.destB || rest?.destB || hol?.destB;
        const destEn = dir === 'A' ? work?.destAEn : work?.destBEn;
        const w = dir === 'A' ? work?.a : work?.b;
        const r = dir === 'A' ? rest?.a : rest?.b;
        const h = dir === 'A' ? hol?.a : hol?.b;
        if (!w?.first && !w?.last && !r?.first && !r?.last && !h?.first && !h?.last) continue;

        const weekFirst = w?.first ?? r?.first ?? h?.first;
        const weekLast = w?.last ?? r?.last ?? h?.last;
        const restFirst = r?.first ?? weekFirst;
        const restLast = r?.last ?? weekLast;
        const same = timesEqual(weekFirst, restFirst) && timesEqual(weekLast, restLast);

        let first_train: string[];
        let last_train: string[];
        if (same) {
          first_train = weekFirst ? [weekFirst] : [];
          last_train = weekLast ? [weekLast] : [];
        } else {
          first_train = [0, 1, 2, 3, 4, 5, 6].map((i) =>
            i < 5 ? (weekFirst ?? '') : (restFirst ?? '')
          );
          last_train = [0, 1, 2, 3, 4, 5, 6].map((i) =>
            i < 5 ? (weekLast ?? '') : (restLast ?? '')
          );
        }
        if (!first_train.some(Boolean) || !last_train.some(Boolean)) continue;

        const destination_stop_id = destZh
          ? resolveDestStop(lineId, destZh, station.id)
          : pattern.terminal_stop_id;
        const shortKey = short === '6支' ? '6z' : short;
        const id = `${input.networkId}-${stopId}-${shortKey}-to-${
          destination_stop_id ?? 'unknown'
        }-zdxx-${dir}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const descParts: string[] = [];
        if (w?.first || w?.last) descParts.push(`工作日 ${w.first ?? '--'}~${w.last ?? '--'}`);
        if (r?.first || r?.last) descParts.push(`休息日 ${r.first ?? '--'}~${r.last ?? '--'}`);
        if (h?.first || h?.last) descParts.push(`节假日 ${h.first ?? '--'}~${h.last ?? '--'}`);

        const rec: TimetableEncoded = {
          id,
          station_id: station.id,
          stop_id: stopId,
          line_id: lineId,
          station_code: stationCode,
          source_id: SOURCE_ID,
          destination_stop_id,
          origin_stop_id: stopId,
          pattern_id: pattern.id,
          direction_type: 'linear',
          direction_label: destZh || destEn || undefined,
          first_train,
          last_train,
          first_train_desc: descParts.length ? descParts.join('; ') : undefined,
          service: same ? 'all_days' : 'weekly',
          extras: {
            site_name: resp.siteName,
            station_code: stationCode,
            direction_zh: destZh,
            direction_en: destEn,
            line_label: work?.lineLabel || rest?.lineLabel,
            calendar: {
              mon_fri: 'workDay',
              sat_sun: 'dayoff',
              note: 'Official holidays kept in extras.holidays (schema has no holiday calendar slot)'
            },
            workday: w
              ? {
                  first: w.first,
                  last: w.last,
                  headway_peak: work?.headwayPeak,
                  headway_offpeak: work?.headwayOff
                }
              : undefined,
            dayoff: r
              ? {
                  first: r.first,
                  last: r.last,
                  headway_peak: rest?.headwayPeak,
                  headway_offpeak: rest?.headwayOff
                }
              : undefined,
            holidays: h
              ? {
                  first: h.first,
                  last: h.last,
                  headway_peak: hol?.headwayPeak,
                  headway_offpeak: hol?.headwayOff
                }
              : undefined,
            raw_workday: workRow,
            raw_dayoff: dayRow,
            raw_holidays: holRow
          }
        };

        if (!hasValidTimes(rec)) continue;
        out.push(normalizeTimetableTimes(rec) as TimetableEncoded);
      }
    }
  }

  return out;
}

export { SOURCE_ID as ZDXX_SOURCE_ID };

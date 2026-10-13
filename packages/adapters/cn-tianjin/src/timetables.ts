/**
 * First/last-train mapping for cn-tianjin.
 *
 * The operator's official H5 "运营时刻表" app embeds every published service
 * alignment with the first/last departure time of **every station in both
 * directions** (each direction's list omits its own destination terminus, so
 * the two directions together cover every stop of the alignment). This maps
 * those rows onto canonical `Timetable` records keyed by the alignment's
 * pattern and the destination terminus — no planner harvest needed.
 *
 * Short-turn/split rows can duplicate the primary alignment's rows (9号线
 * 区间车 toward 天津站 quotes exactly the main line's values; its outbound
 * 新立-direction rows are its own, with a later last train). A duplicated
 * row only restates the primary alignment, so it is dropped — genuine
 * divergences (like the late-night outbound shuttle rows) are kept.
 */
import { cleanTime, foldStationName, type TimetableEncoded } from '@openmetro/core';
import type { H5LineEntry } from './fetch.js';
import {
  H5_SKIPPED_ALIGNMENTS,
  type TianjinAlignmentConfig,
  type TianjinLineConfig
} from './lines.js';

const TT_SOURCE = 'tjgdjt-train-time-h5';
const NETWORK_ID = 'cn-tianjin';

export interface AlignmentIndexEntry {
  line: TianjinLineConfig;
  lineId: string;
  alignment: TianjinAlignmentConfig;
  patternId: string;
  /** Station display names of the alignment's two termini (AMap order). */
  originName: string;
  terminalName: string;
}

export interface TimetableSourceIndex {
  /** H5 alignment label → its canonical pattern + termini. */
  byAlignment: Map<string, AlignmentIndexEntry>;
  /** line slug → folded station name → stop id on that line. */
  stopIdByStation: Map<string, Map<string, string>>;
  /** stop id → station id. */
  stationIdByStop: Map<string, string>;
  /** line slug → folded station name → station id. */
  stationIdByStation: Map<string, Map<string, string>>;
}

/** `6:30`/`06:30` → `06:30`; passes service-day `24:xx`+ through. */
function padTime(raw: string | undefined): string | undefined {
  const t = cleanTime(raw);
  if (!t) return undefined;
  const [h, m] = t.split(':');
  if (h!.length < 2) return `${h!.padStart(2, '0')}:${m}`;
  return t;
}

export function buildTianjinTimetables(
  h5Lines: H5LineEntry[],
  index: TimetableSourceIndex
): TimetableEncoded[] {
  const out: TimetableEncoded[] = [];
  const seen = new Set<string>();
  /** station|line|dest|up_down_type → time payload of the primary's row. */
  const primaryRows = new Map<string, { first: string; last: string }>();

  // Pass 1: record the primary alignments' row payloads so branch/short-turn
  // rows can be compared against them (mains may appear after branches in the
  // chunk's array order).
  for (const entry of h5Lines) {
    const info = index.byAlignment.get(entry.lineName);
    if (info?.alignment.key !== 'main') continue;
    for (const dir of entry.directions) {
      for (const row of dir.direction) {
        const stationId = index.stationIdByStation
          .get(info.line.slug)
          ?.get(foldStationName(row.name));
        if (!stationId) continue;
        primaryRows.set(
          `${stationId}|${info.line.slug}|${foldStationName(dir.dstName)}|${dir.up_down_type}`,
          {
            first: padTime(row.startTime) ?? '',
            last: padTime(row.endTime) ?? ''
          }
        );
      }
    }
  }

  for (const entry of h5Lines) {
    if (H5_SKIPPED_ALIGNMENTS[entry.lineName]) continue;
    const info = index.byAlignment.get(entry.lineName);
    if (!info) {
      throw new Error(
        `H5 alignment ${entry.lineName} has no line/pattern mapping — update lines.ts`
      );
    }
    const slug = info.line.slug;
    const stopsOfLine = index.stopIdByStation.get(slug);
    const stationsOfLine = index.stationIdByStation.get(slug);
    if (!stopsOfLine || !stationsOfLine) continue;

    const termini = [foldStationName(info.originName), foldStationName(info.terminalName)];
    for (const dir of entry.directions) {
      const dstFold = foldStationName(dir.dstName);
      const dstStopId = stopsOfLine.get(dstFold);
      if (!dstStopId) {
        throw new Error(
          `H5 ${entry.lineName}: destination ${dir.dstName} not on ${info.line.name}`
        );
      }
      if (!termini.includes(dstFold)) {
        throw new Error(
          `H5 ${entry.lineName}: destination ${dir.dstName} is not an alignment terminus (${info.originName}/${info.terminalName})`
        );
      }
      const originFold = termini.find((t) => t !== dstFold)!;
      const originStopId = stopsOfLine.get(originFold);
      let rows = 0;
      for (const row of dir.direction) {
        const fold = foldStationName(row.name);
        if (fold === dstFold) continue;
        const stopId = stopsOfLine.get(fold);
        if (!stopId) {
          throw new Error(`H5 ${entry.lineName}: station ${row.name} not on ${info.line.name}`);
        }
        const first = padTime(row.startTime);
        const last = padTime(row.endTime);
        if (!first && !last) continue;
        const stationId = index.stationIdByStop.get(stopId);
        if (!stationId) continue;
        // A short-turn alignment's row that exactly restates the primary
        // alignment's row for the same station+destination is redundant.
        if (info.alignment.key !== 'main') {
          const primary = primaryRows.get(`${stationId}|${slug}|${dstFold}|${dir.up_down_type}`);
          if (primary && primary.first === (first ?? '') && primary.last === (last ?? '')) {
            continue;
          }
        }
        const id = `${NETWORK_ID}-${stationId}-${slug}-${info.alignment.key}-d${dir.up_down_type}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rows++;
        out.push({
          id,
          station_id: stationId,
          stop_id: stopId,
          line_id: info.lineId,
          source_id: TT_SOURCE,
          destination_stop_id: dstStopId,
          origin_stop_id: originStopId,
          pattern_id: info.patternId,
          direction_type: 'linear',
          direction_label: `${dir.dstName}方向`,
          first_train: first ? [first] : [],
          last_train: last ? [last] : [],
          extras: {
            line_short_name: info.line.short,
            alignment: entry.lineName,
            calendar: 'all_days'
          }
        });
      }
      console.log(`    ${entry.lineName} → ${dir.dstName}方向: ${rows} stations`);
    }
  }

  return out;
}

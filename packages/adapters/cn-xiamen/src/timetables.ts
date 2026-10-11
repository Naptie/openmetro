/**
 * First/last-train assembly for cn-xiamen.
 *
 * The operator CMS publishes per-station first/last trains with an explicit
 * destination (headsign) for lines 1–3; lines 4/6 have no timetable records
 * at all. Every direction therefore normalises to `{station, destination,
 * first, last}`:
 * - CMS rows are mapped by the operator's station id, destination resolved
 *   against the AMap station order of the line. Rows without a destination
 *   name are duplicated line-level records and are skipped.
 * - The city-agnostic core harvest (`harvestBaiduTimetables`) supplies lines
 *   4/6 wholesale, plus targeted queries for the few CMS-covered stops that
 *   carry no rows. Official CMS times always win over planner estimates.
 */
import { foldStationName, type HarvestedStationDir, parseHHMM } from '@openmetro/core';
import type { XiamenSources } from './fetch.js';
import type { XiamenLineConfig } from './lines.js';
import { XIAMEN_LINES } from './lines.js';

export const TT_SOURCE_CMS = 'xmgdjt-cms-timetable';
export const TT_SOURCE_BAIDU = 'baidu-directionlite-transit';

export interface DirectedTimes {
  /** AMap station name (no 站 suffix). */
  stationName: string;
  /** Destination station name in the AMap form (no 站 suffix). */
  destName: string;
  /** down = toward the last AMap station of the line, up = toward the first. */
  direction: 'down' | 'up';
  first: string | null;
  last: string | null;
  source: string;
}

/** `HH:MM:SS` → `HH:MM`; rejects anything else. */
export function parseCmsTime(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((raw ?? '').trim().replace('：', ':'));
  if (!m) return null;
  return `${m[1]!.padStart(2, '0')}:${m[2]!}`;
}

export interface CmsTimesResult {
  /** CMS line id → times (deduped per station×destination). */
  timesByCmsLine: Map<string, DirectedTimes[]>;
  /** Station/destination names that could not be matched to the AMap order. */
  issues: string[];
}

/**
 * Map CMS timetable rows onto the AMap station order. The CMS shares one
 * station id across lines at interchanges, so rows are matched by
 * `row.lineId` + `row.stationId` (via the line-station lists), never by
 * name alone.
 */
export function mapCmsDirectedTimes(
  sources: XiamenSources,
  stationsByAmapLine: Map<string, string[]>
): CmsTimesResult {
  const timesByCmsLine = new Map<string, DirectedTimes[]>();
  const issues: string[] = [];

  for (const cfg of XIAMEN_LINES) {
    const amapNames = stationsByAmapLine.get(cfg.amapName) ?? [];
    const foldToAmap = new Map<string, string>();
    for (const n of amapNames) {
      const key = foldStationName(n);
      if (!foldToAmap.has(key)) foldToAmap.set(key, n);
    }
    /** fold → CMS station id, from the operator's own line-station list. */
    const foldToCmsId = new Map<string, string>();
    for (const s of sources.cmsLineStations.get(cfg.cmsLineId) ?? []) {
      const key = foldStationName(s.stationName);
      if (!foldToCmsId.has(key)) foldToCmsId.set(key, s.stationId);
    }

    const times: DirectedTimes[] = [];
    const seen = new Set<string>();
    for (const [fold, cmsId] of foldToCmsId) {
      const rows = sources.cmsTimetables.get(cmsId) ?? [];
      for (const row of rows) {
        if (row.lineId !== cfg.cmsLineId) continue;
        if (!row.destinationStationName) continue; // duplicated line-level record
        const destAmap = foldToAmap.get(foldStationName(row.destinationStationName));
        if (!destAmap) {
          issues.push(`${cfg.name}: destination ${row.destinationStationName} not on line`);
          continue;
        }
        if (destAmap === foldToAmap.get(fold)) continue; // terminus self-direction
        const key = `${fold}|${foldStationName(row.destinationStationName)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const stationIdx = amapNames.indexOf(foldToAmap.get(fold)!);
        const destIdx = amapNames.indexOf(destAmap);
        const direction: 'down' | 'up' = destIdx < stationIdx ? 'up' : 'down';
        const first = parseCmsTime(row.firstTime);
        const last = parseCmsTime(row.lastTime);
        if (!first && !last) continue;
        times.push({
          stationName: foldToAmap.get(fold)!,
          destName: destAmap,
          direction,
          first,
          last,
          source: TT_SOURCE_CMS
        });
      }
    }
    timesByCmsLine.set(cfg.cmsLineId, times);
  }
  return { timesByCmsLine, issues };
}

/** Convert the core Baidu harvest (down/up toward the line termini) to times. */
export function baiduTimesFromHarvest(harvested: HarvestedStationDir[]): DirectedTimes[] {
  const out: DirectedTimes[] = [];
  for (const h of harvested) {
    if (h.direction !== 'down' && h.direction !== 'up') continue;
    if (!h.first && !h.last) continue;
    out.push({
      stationName: h.stationName,
      destName: h.destName ?? '',
      direction: h.direction,
      first: h.first ?? null,
      last: h.last ?? null,
      source: TT_SOURCE_BAIDU
    });
  }
  return out;
}

export interface BaiduGapQuery {
  line: XiamenLineConfig;
  stationName: string;
  destName: string;
  direction: 'down' | 'up';
}

/**
 * CMS-covered stops that carry no rows for one direction: the planner is
 * queried once per gap toward the direction's terminus (lines 4/6 are
 * harvested wholesale, so only lines 1–3 reach here).
 */
export function planBaiduGapQueries(
  cmsTimes: DirectedTimes[],
  amapNames: string[],
  line: XiamenLineConfig
): BaiduGapQuery[] {
  const have = new Set(
    cmsTimes.map((t) => `${foldStationName(t.stationName)}|${foldStationName(t.destName)}`)
  );
  const queries: BaiduGapQuery[] = [];
  const n = amapNames.length;
  if (n < 2) return queries;
  for (let i = 0; i < n; i++) {
    for (const [direction, destIdx] of [
      ['down', n - 1],
      ['up', 0]
    ] as const) {
      const destName = amapNames[destIdx]!;
      if (destName === amapNames[i]) continue; // terminus self-direction
      if (have.has(`${foldStationName(amapNames[i]!)}|${foldStationName(destName)}`)) continue;
      queries.push({ line, stationName: amapNames[i]!, destName, direction });
    }
  }
  return queries;
}

/**
 * Official CMS times win per (station, destination); planner times only fill
 * the gaps.
 */
export function mergeDirectedTimes(cms: DirectedTimes[], baidu: DirectedTimes[]): DirectedTimes[] {
  const keyOf = (t: DirectedTimes) =>
    `${foldStationName(t.stationName)}|${foldStationName(t.destName)}`;
  const byKey = new Map<string, DirectedTimes>();
  for (const t of baidu) byKey.set(keyOf(t), t);
  for (const t of cms) byKey.set(keyOf(t), t); // official wins
  return [...byKey.values()];
}

/**
 * The planner sometimes mirrors the two directions wholesale. First times
 * must be non-decreasing along the line order in the travel direction; when
 * the harvest fails that on both groups, swap the time payloads between the
 * two destination groups (station/destination identities stay fixed).
 */
export function fixMirroredTimes(
  amapNames: string[],
  times: DirectedTimes[]
): { times: DirectedTimes[]; swapped: boolean } {
  const mins = (s: string | null | undefined) => (s ? parseHHMM(s) : null);
  const order = new Map(amapNames.map((n, i) => [foldStationName(n), i] as const));
  const groups = new Map<string, DirectedTimes[]>();
  for (const t of times) {
    const key = foldStationName(t.destName);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const scores = new Map<string, { inc: number; dec: number }>();
  for (const [key, list] of groups) {
    let inc = 0;
    let dec = 0;
    const sorted = [...list].sort(
      (a, b) =>
        (order.get(foldStationName(a.stationName)) ?? 0) -
        (order.get(foldStationName(b.stationName)) ?? 0)
    );
    for (let i = 1; i < sorted.length; i++) {
      const a = mins(sorted[i - 1]!.first);
      const b = mins(sorted[i]!.first);
      if (a == null || b == null) continue;
      if (b >= a) inc++;
      else dec++;
    }
    scores.set(key, { inc, dec });
  }
  const keys = [...groups.keys()];
  if (keys.length !== 2) return { times, swapped: false };
  const a = scores.get(keys[0]!)!;
  const b = scores.get(keys[1]!)!;
  const aMirrored = a.dec > a.inc && a.dec >= 2;
  const bMirrored = b.dec > b.inc && b.dec >= 2;
  if (!aMirrored || !bMirrored) return { times, swapped: false };
  const partnerByStation = (key: string) => {
    const m = new Map<string, DirectedTimes>();
    for (const t of groups.get(key)!) {
      const k = foldStationName(t.stationName);
      if (!m.has(k)) m.set(k, t);
    }
    return m;
  };
  const swap = (list: DirectedTimes[], otherKey: string): DirectedTimes[] => {
    const partner = partnerByStation(otherKey);
    return list.map((t) => {
      const p = partner.get(foldStationName(t.stationName));
      if (!p) return t;
      return { ...t, first: p.first, last: p.last };
    });
  };
  return {
    times: [...swap(groups.get(keys[0]!)!, keys[1]!), ...swap(groups.get(keys[1]!)!, keys[0]!)],
    swapped: true
  };
}

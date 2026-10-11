/**
 * First/last-train harvest for cn-jinan via Baidu Direction Lite.
 *
 * The operator publishes its timetable only as a JPEG; there is no OCR path.
 * Linear lines use the city-agnostic core harvest (`harvestBaiduTimetables`);
 * the SkyShuttle loop needs an adapter-local ring harvest because the core
 * harvest assumes two linear termini. Every sync re-queries the planner so
 * `data/` stays live.
 */
import {
  type BaiduLegTimes,
  type BaiduStationRef,
  fetchBaiduSubwayLeg,
  lastDepartureFromArrival,
  parseHHMM
} from '@openmetro/core';

export interface LinearStationTimes {
  stationName: string;
  /** Toward the last station of the line order. */
  downFirst?: string | null;
  downLast?: string | null;
  /** Toward the first station of the line order. */
  upFirst?: string | null;
  upLast?: string | null;
}

export interface LoopStationTimes {
  stationName: string;
  /** 外环 — decreasing station order, per planner direction labels. */
  outerFirst?: string | null;
  outerLast?: string | null;
  /** 内环 — increasing station order. */
  innerFirst?: string | null;
  innerLast?: string | null;
}

export type HarvestedStationTimes = LinearStationTimes | LoopStationTimes;

export function isLoopTimes(row: HarvestedStationTimes): row is LoopStationTimes {
  return 'outerFirst' in row;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * First/last times must be non-decreasing along the line order in the
 * departure direction; if the planner mirrored the two ends, swap them.
 */
export function fixLinearRowDirection(rows: LinearStationTimes[]): {
  rows: LinearStationTimes[];
  swapped: boolean;
} {
  const mins = (s: string | null | undefined) => {
    if (!s) return null;
    const m = parseHHMM(s);
    return m;
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

/**
 * SkyShuttle loop harvest: query each station toward a target roughly a
 * quarter-ring away so the planner must pick the shorter arc, then confirm
 * which ring direction the returned leg actually runs. Verified against the
 * planner: 外环 runs toward decreasing station order.
 */
export async function harvestLoopTimetables(
  ak: string,
  stations: BaiduStationRef[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<LoopStationTimes[]> {
  const delay = opts.delayMs ?? 250;
  const retries = opts.retries ?? 2;
  const n = stations.length;
  const out: LoopStationTimes[] = stations.map((s) => ({ stationName: s.name }));

  /** Ring offsets that keep the wanted arc strictly shorter than the other. */
  const offsets = [12, 10, 14, 8, 16];

  /** Ring order lookup tolerant of Baidu's bare / re-suffixed stop names. */
  const ringIndexByName = new Map<string, number>();
  stations.forEach((s, i) => {
    ringIndexByName.set(s.name, i);
    const bare = s.name
      .replace(/[(（][^)）]*[)）]/g, '')
      .replace(/站$/, '')
      .trim();
    if (bare && !ringIndexByName.has(bare)) ringIndexByName.set(bare, i);
  });

  /**
   * Which way the leg runs around the ring: the vehicle name carries the
   * marker ("云巴1号线外环"); otherwise the first intermediate stop in travel
   * order tells the arc (外环 = decreasing station order).
   */
  const ringDirectionOf = (leg: BaiduLegTimes, index: number): 'outer' | 'inner' | null => {
    const name = leg.lineName ?? '';
    if (name.includes('外环')) return 'outer';
    if (name.includes('内环')) return 'inner';
    for (const raw of leg.stopNames ?? []) {
      const trimmed = raw.trim();
      const i =
        ringIndexByName.get(trimmed) ??
        ringIndexByName.get(trimmed.replace(/站$/, '').trim()) ??
        ringIndexByName.get(trimmed.replace(/[(（][^)）]*[)）]/g, '').trim());
      if (i == null || i === index) continue;
      return i < index ? 'outer' : 'inner';
    }
    return null;
  };

  const tryDirection = async (
    index: number,
    ringDir: 'outer' | 'inner'
  ): Promise<BaiduLegTimes | null> => {
    for (const k of offsets) {
      const targetIdx = ringDir === 'outer' ? (index - k + n * 2) % n : (index + k) % n;
      const target = stations[targetIdx]!;
      if (target.name === stations[index]!.name) continue;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const leg = await fetchBaiduSubwayLeg(ak, stations[index]!, target, {
          // Near metro interchanges the planner leads with a metro leg;
          // only the SkyShuttle's own leg carries ring-direction semantics.
          lineNameHint: '云巴'
        });
        if (delay > 0) await sleep(delay);
        if (leg && ringDirectionOf(leg, index) === ringDir) return leg;
      }
    }
    return null;
  };

  for (let i = 0; i < n; i++) {
    const row = out[i]!;
    const outer = await tryDirection(i, 'outer');
    row.outerFirst = outer?.firstDeparture ?? null;
    row.outerLast = lastDepartureFromArrival(
      outer?.lastArrival ?? null,
      outer?.firstDeparture ?? null,
      outer?.durationSeconds ?? null
    );
    const inner = await tryDirection(i, 'inner');
    row.innerFirst = inner?.firstDeparture ?? null;
    row.innerLast = lastDepartureFromArrival(
      inner?.lastArrival ?? null,
      inner?.firstDeparture ?? null,
      inner?.durationSeconds ?? null
    );
    const withTimes =
      (row.outerFirst || row.outerLast ? 1 : 0) + (row.innerFirst || row.innerLast ? 1 : 0);
    console.log(`    YB ${row.stationName}: ${withTimes}/2 ring directions`);
  }
  return out;
}

/** 周一至周四 standard, 周五至周日 extended → Mon..Sun array (idx 0 = Monday). */
export function weekArrayJinan(std: string | null | undefined, ext?: string | null): string[] {
  const s = std ?? undefined;
  if (!s) return [];
  const e = ext ?? s;
  return [s, s, s, s, e, e, e];
}

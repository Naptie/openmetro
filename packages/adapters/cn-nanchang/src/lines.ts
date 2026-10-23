/**
 * Nanchang Rail Transit (南昌轨道交通) line registry and published tariff.
 *
 * The operator (南昌轨道交通集团有限公司, www.ncmtr.com) runs four metro lines.
 * Its official backend publishes the whole network as JSON
 * (`GET .../AllLine`, see `./fetch.ts`), so the registry below only adds the two
 * facts that payload does not carry: the canonical id slug and the Baidu
 * planner's vehicle-name fragment.
 *
 * Line facts (from the operator's own `AllLine` payload):
 * - 1 号线 — 昌北机场 → 麻丘, 34 stations, red.
 * - 2 号线 — 南路 → 南昌东站, 37 stations, orange.
 * - 3 号线 — 银三角北 → 京东大道, 22 stations, blue.
 * - 4 号线 — 白马山 → 鱼尾洲, 29 stations, green.
 * - Interchanges (9): 八一广场 (1/2), 地铁大厦 (1/2), 八一馆 (1/3),
 *   丁公路北 (1/4), 青山路口 (2/3), 西站南广场 (2/4), 丁公路南 (2/4),
 *   绳金塔 (3/4), 上沙沟 (3/4).
 *
 * Every line is a single chain with no branch, so each one owns exactly one
 * primary pattern.
 *
 * ## Station names
 *
 * The operator's payload appends `站` to every station name
 * (`昌北机场站`, `八一广场站`, …). The AMap dataset drops that suffix on most
 * stations but **keeps** it on the three Line 2 compounds (`南昌西站`,
 * `南昌火车站`, `南昌东站`).
 *
 * Both feeds are therefore folded by removing one trailing `站`, which makes
 * them match one-to-one on all 122 line-stop records — no alias table needed.
 * The canonical display name follows the same fold, except for `南昌火车站`,
 * whose published name really does end in 站 (it is the railway station).
 */
import type { LineMode } from '@openmetro/core';

export interface NanchangLineConfig {
  /** Official line id in the operator's payload (`'1'` … `'4'`). */
  officialId: string;
  /** Compact display code for badges (`1`, `2`, …). */
  short: string;
  /** Official Chinese display name (`1号线` … `4号线`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Baidu planner vehicle name for this line (`地铁1号线`). */
  baiduNameHint: string;
}

export const NANCHANG_LINES: NanchangLineConfig[] = [
  {
    officialId: '1',
    short: '1',
    name: '1号线',
    slug: '1',
    mode: 'metro',
    baiduNameHint: '地铁1号线'
  },
  {
    officialId: '2',
    short: '2',
    name: '2号线',
    slug: '2',
    mode: 'metro',
    baiduNameHint: '地铁2号线'
  },
  {
    officialId: '3',
    short: '3',
    name: '3号线',
    slug: '3',
    mode: 'metro',
    baiduNameHint: '地铁3号线'
  },
  {
    officialId: '4',
    short: '4',
    name: '4号线',
    slug: '4',
    mode: 'metro',
    baiduNameHint: '地铁4号线'
  }
];

/** Official line id → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_ID = new Map<string, NanchangLineConfig>(
  NANCHANG_LINES.map((l) => [l.officialId, l])
);

/**
 * Stations whose published name ends in 站 as part of the name itself.
 *
 * `南昌火车站` is the railway station — the `站` is not the metro-stop suffix.
 */
export const STATION_NAMES_KEEPING_SUFFIX = new Set(['南昌火车站']);

/**
 * Fold an official or AMap station name to a comparable key.
 *
 * Both feeds are folded the same way (one trailing `站` removed), so the
 * operator's `南昌西站` and AMap's `南昌西站` both become `南昌西`, while the
 * operator's `八一广场站` and AMap's `八一广场` both become `八一广场`.
 */
export function foldNanchangStationName(name: string): string {
  const t = name.trim().replace(/\s+/g, '');
  if (!t) return '';
  return t.replace(/站$/, '');
}

/**
 * The canonical display name for a station.
 *
 * Same fold as `foldNanchangStationName`, except that a station whose
 * published name ends in 站 as part of the name itself keeps it.
 */
export function canonicalStationName(name: string): string {
  const t = name.trim().replace(/\s+/g, '');
  if (STATION_NAMES_KEEPING_SUFFIX.has(t)) return t;
  return foldNanchangStationName(t);
}

/**
 * Official single-journey tariff (计程票制按里程分段计价), published by the
 * operator's 购票指南 (`https://www.ncmtr.com/yyfw/1.html`):
 *
 * > 南昌轨道交通票制采用计程票制按里程分段计价，依照"分级递进、递远递减"的原则，
 * > 起步价为 2 元，起步 6 公里，6-12 公里每增 1 元可乘里程为 6 公里，
 * > 12-28 公里每增 1 元可乘里程为 8 公里，28 公里以上每增 1 元可乘里程为 10 公里。
 *
 * The ladder is the published policy. The **fares layer uses the operator's own
 * OD quote** (`Price` from the official route planner, see `./fares.ts`) — this
 * tariff is only used to cross-check that matrix.
 */
export const NANCHANG_TARIFF = {
  /** Cumulative charged mileage (km) at each price point. */
  cumulativeKm: [6, 12, 20, 28, 38],
  /** Price (yuan) for each cumulative mileage entry above. */
  yuan: [2, 3, 4, 5, 6],
  /** Above 38 km the fare grows by 1 yuan per additional 10 km. */
  beyondKm: 38,
  beyondStepKm: 10,
  beyondStepYuan: 1
} as const;

/** Official fare for a charged mileage of `km`. */
export function nanchangMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return NANCHANG_TARIFF.yuan[0];
  for (let i = 0; i < NANCHANG_TARIFF.cumulativeKm.length; i++) {
    if (km <= NANCHANG_TARIFF.cumulativeKm[i]! + 1e-9) return NANCHANG_TARIFF.yuan[i]!;
  }
  const over = km - NANCHANG_TARIFF.beyondKm;
  return (
    NANCHANG_TARIFF.yuan[NANCHANG_TARIFF.yuan.length - 1]! +
    Math.ceil(over / NANCHANG_TARIFF.beyondStepKm) * NANCHANG_TARIFF.beyondStepYuan
  );
}

/**
 * Hand-maintained English-name corrections.
 *
 * AMap's `multilang.n.en` covers all 113 physical stations, but a few entries
 * are inconsistent with the rest of the network (missing the `Road` suffix that
 * every other 街/路/大道 station uses). Only entries that are demonstrably wrong
 * are listed — everything else keeps the source's own label.
 */
export const ENGLISH_NAME_OVERRIDES: Record<string, string> = {
  珠江路: 'Zhujiang Road',
  长江路: 'Changjiang Road'
};

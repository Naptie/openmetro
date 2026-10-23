/**
 * Static configuration for cn-kunming.
 *
 * Kunming Rail Transit (昆明轨道交通) is the one network in this repository
 * whose official site is gone: `www.kmgdgs.com` — the group's own CMS, whose
 * 2019 archive still shows the 运营线路图 / 首末班车时刻表 / 路程与票价查询
 * columns — now answers `503` behind a JS WAF challenge and `502 Bad Gateway`
 * for every content path, and since 2021 the domain only serves the unrelated
 * 昆明志愿者网 columns. The operator's live data surface is the WeChat
 * mini-program (昆明地铁综合查询平台), which has no public endpoint.
 *
 * Everything therefore comes from the AMap metro dataset plus the AMap metro
 * route planner (`busExt`) — the same planner the Taiyuan adapter reads.
 * The planner is backed by the operator's running timetable: the Baidu
 * Direction v2 planner independently reports the same first/last times for the
 * same leg (e.g. 昆明火车站 → 大学城南·云南开放大学: `06:55` / `22:40` in both).
 *
 * This file holds the parts that cannot be derived from the source payloads:
 * the line roster, the service-pattern (交路) layout of Line 1, the station
 * name corrections, and the published distance-based fare ladder.
 */

/** A service pattern (交路) of one line. */
export interface KunmingPatternSpec {
  /**
   * AMap station name of the pattern's terminal. Used to pick the matching
   * AMap line entry — Line 1 is published as two entries (main line + branch).
   * Omitted for the single-pattern lines, where the only entry is used.
   */
  terminalAmapName?: string;
  /** `primary` = the line's main alignment; `branch` = a diverging alignment. */
  role: 'primary' | 'branch';
  /**
   * Official Chinese terminal name, when it differs from AMap's spelling.
   * Only needed where the AMap entry cannot be matched unambiguously.
   */
  terminalZh?: string;
}

export interface KunmingLineConfig {
  /** Short code used in ids and `short_name` (`1` … `6`). */
  short: string;
  /** Chinese line name as published (`1号线`). */
  name: string;
  /** English line name. */
  nameEn: string;
  /** AMap `ln` value of the line entry. */
  amapName: string;
  /** AMap planner vehicle name prefix, e.g. `地铁4号线`. */
  plannerName: string;
  /** Service patterns of this line, in publication order. */
  patterns: KunmingPatternSpec[];
  /**
   * Stop where a branch diverges from the primary alignment. Only for lines
   * with more than one pattern.
   */
  junction?: string;
}

/**
 * Kunming's operating lines.
 *
 * Line 1 is the interesting one: since 2016-12-28 the 支线 to 昆明南站 runs
 * through from the trunk at 春融街, and Lines 1 and 2 are through-connected at
 * 环城南路 — so Line 1 really has two alignments and the network has four
 * distinct services on it (main line each way + branch each way).
 */
export const KUNMING_LINES: readonly KunmingLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    nameEn: 'Line 1',
    amapName: '1号线',
    plannerName: '地铁1号线',
    junction: '春融街',
    patterns: [
      { role: 'primary', terminalAmapName: '大学城南·云南开放大学' },
      { role: 'branch', terminalAmapName: '昆明南火车站' }
    ]
  },
  {
    short: '2',
    name: '2号线',
    nameEn: 'Line 2',
    amapName: '2号线',
    plannerName: '地铁2号线',
    patterns: [{ role: 'primary' }]
  },
  {
    short: '3',
    name: '3号线',
    nameEn: 'Line 3',
    amapName: '3号线',
    plannerName: '地铁3号线',
    patterns: [{ role: 'primary' }]
  },
  {
    short: '4',
    name: '4号线',
    nameEn: 'Line 4',
    amapName: '4号线',
    plannerName: '地铁4号线',
    patterns: [{ role: 'primary' }]
  },
  {
    short: '5',
    name: '5号线',
    nameEn: 'Line 5',
    amapName: '5号线',
    plannerName: '地铁5号线',
    patterns: [{ role: 'primary' }]
  },
  {
    short: '6',
    name: '6号线',
    nameEn: 'Line 6',
    amapName: '6号线',
    plannerName: '地铁6号线',
    patterns: [{ role: 'primary' }]
  }
];

/**
 * Station name corrections.
 *
 * AMap publishes a disambiguated label for several stations (the physical
 * station plus its exits or neighbouring landmark) and mangles one station
 * outright. `zh` is the operator's published name; `en` overrides AMap's
 * romanisation where AMap derives it from the wrong character.
 *
 * Verified against the operator's own published station lists (the 昆明轨道
 * 通信 magazines and the line-opening announcements reproduced by 百度百科 /
 * 360百科) and Wikidata (`Q24832556` 穿心鼓楼站 → "Chuanxin Gulou Station",
 * `Q106020824` 金桂街站 → "Jingui St. station").
 */
export const STATION_NAME_OVERRIDES: Record<string, { zh?: string; en?: string }> = {
  // AMap carries the typo 眠山 for the official 岷山站 (Wikipedia transliterates
  // the station as "Minshan"; AMap's pinyin "MianShan" follows its own typo).
  眠山: { zh: '岷山', en: 'Minshan' },
  // AMap appends the adjacent flower market to the station name.
  金桂街·斗南花市: { zh: '金桂街', en: 'Jingui Street' },
  // AMap appends the square name to the administrative-centre station.
  市级行政中心清风: { zh: '市级行政中心', en: 'Municipal Administration Center' },
  // AMap appends the interchange description.
  庄家塘立交桥: { zh: '庄家塘', en: 'Zhuangjiatang' },
  昆明南火车站: { zh: '昆明南站', en: 'Kunming South Railway Station' },
  大学城南·云南开放大学: { zh: '大学城南', en: 'University Town (South)' }
};

/**
 * Published distance-based fare ladder (里程计价制).
 *
 * The operator prices rides by distance: 2 yuan for the first 4 km, then one
 * yuan per bracket with the *increment* growing as the ride gets longer
 * (「递远递减」 = the per-kilometre price falls). The brackets below were
 * fitted against the AMap planner's own quotes — 111 single-leg OD samples
 * reproduce them exactly (the operator's 昆交联发〔2021〕54 号 pricing), while
 * the announcement's literal 「跳档里程分别为 5、7、9、11、13 公里」 reading
 * disagrees with the quotes on 41 of those 111 samples.
 */
export const KUNMING_FARE_BRACKETS: readonly { upToKm: number; yuan: number }[] = [
  { upToKm: 4, yuan: 2 },
  { upToKm: 8, yuan: 3 },
  { upToKm: 13, yuan: 4 },
  { upToKm: 19, yuan: 5 },
  { upToKm: 26, yuan: 6 },
  { upToKm: 34, yuan: 7 },
  { upToKm: 43, yuan: 8 },
  { upToKm: 53, yuan: 9 }
];

/** Official fare for a ride of `km` kilometres. */
export function kunmingMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 2;
  for (const bracket of KUNMING_FARE_BRACKETS) {
    if (km <= bracket.upToKm) return bracket.yuan;
  }
  // Beyond the published ladder every additional 10 km costs one more yuan.
  const last = KUNMING_FARE_BRACKETS[KUNMING_FARE_BRACKETS.length - 1]!;
  return last.yuan + Math.ceil((km - last.upToKm) / 10);
}

/**
 * The one line pair that runs through — Lines 1 and 2 share 环城南路 and a
 * train continues from one to the other without the passenger changing trains.
 * Modeled the way cn-jinan models its 4/8 through-run: zero-second transfer
 * edges at the shared station.
 */
export const THROUGH_RUN_LINE_PAIRS: readonly [string, string][] = [['1', '2']];

/**
 * Official service window notes.
 *
 * Kunming publishes a single first/last band per direction (no weekday /
 * weekend split in the operator's tables), so the canonical timetable arrays
 * have length 1. Headways do differ between the weekday and the weekend
 * running diagrams, but the planner only ever exposes the query-day band.
 */
export const CALENDAR_NOTE = 'all_days';

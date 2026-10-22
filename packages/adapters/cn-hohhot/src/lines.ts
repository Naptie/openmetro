/**
 * City-specific facts for Hohhot Metro (呼和浩特地铁).
 *
 * The network is small and fully linear: two lines, 43 stations, one
 * interchange (新华广场). Nothing branches, so one primary pattern per line
 * covers the whole network.
 *
 * Sources of truth, and what each one is good for:
 *
 * - **Topology, coordinates, English names, colours** — the public AMap
 *   subway dataset (`1501_drw_huhehaote.json`, city code 1501). The operator
 *   publishes its network map, first/last-train sheet and fare sheets as
 *   *images* on `www.hhhtmetro.com` / its WeChat account, so there is no
 *   structured official endpoint and this adapter deliberately has no OCR path
 *   (same stance as `cn-jinan` and `cn-urumqi`).
 * - **First/last trains and OD fares** — harvested live from the Baidu
 *   Direction planner (see `baidu.ts`, `timetables.ts`, `fares.ts`).
 * - **Fare tariff** — 呼和浩特市发展和改革委员会《关于呼和浩特市轨道交通
 *   票制票价的通知》 (2019-12-20), published on the municipal portal.
 */
import type { LineMode } from '@openmetro/core';

export interface HohhotLineConfig {
  /** Compact display code for badges (`1`, `2`). */
  short: string;
  /** Official Chinese display name (AMap `ln`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  /** Name as published in the AMap subway dataset (`ln`). */
  amapName: string;
  /** English line name. */
  nameEn: string;
  mode: LineMode;
  /** Baidu planner vehicle-name fragment (`地铁1号线`). */
  baiduNameHint: string;
  /** Line length in km, as published by the operator. */
  lengthKm: number;
  /** Station count, as published by the operator. */
  stationCount: number;
  /** First day of initial operation. */
  opened: string;
}

export const HOHHOT_LINES: HohhotLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    baiduNameHint: '地铁1号线',
    lengthKm: 21.719,
    stationCount: 20,
    opened: '2019-12-29'
  },
  {
    short: '2',
    name: '2号线',
    slug: '2',
    amapName: '2号线',
    nameEn: 'Line 2',
    mode: 'metro',
    baiduNameHint: '地铁2号线',
    lengthKm: 27.32,
    stationCount: 24,
    opened: '2020-10-01'
  }
];

/**
 * Current official station names that differ from the AMap subway dataset.
 *
 * On 2023-11-01 the operator renamed two Line 1 stations to spell out which
 * terminal building they serve (呼和浩特城市交通投资建设集团有限公司,
 * 2023-10-25; mirrored by 呼和浩特市交通运输局):
 * - 坝堰(机场) → 坝堰(机场)(国内航站楼)
 * - 白塔西 → 白塔西(国际航站楼)
 *
 * AMap still carries the short forms, so the canonical name is the operator's
 * current one and the AMap name stays the lookup key.
 */
export const STATION_NAME_OVERRIDES: Record<string, string> = {
  '坝堰(机场)': '坝堰(机场)(国内航站楼)',
  白塔西: '白塔西(国际航站楼)'
};

/**
 * Station renames that took effect on 2023-11-01 (same announcement as
 * `STATION_NAME_OVERRIDES`). AMap and the planner already use the new names;
 * the operator's 2020-vintage published timetable sheet still uses the old
 * ones, so the sheet cannot be joined to the topology without this map.
 */
export const RENAMED_STATIONS_2023: { from: string; to: string }[] = [
  { from: '呼钢东路', to: '呼钢南路' },
  { from: '新城图书馆', to: '北山公园' },
  { from: '东二环路', to: '丝绸之路大道' }
];

/**
 * English names the AMap dataset gets wrong or leaves untranslated.
 * Keyed by the canonical Chinese name.
 */
export const STATION_EN_OVERRIDES: Record<string, string> = {
  // AMap publishes "BAYAN(AIRPOT)" — a typo for "Airport".
  '坝堰(机场)(国内航站楼)': 'Bayan Airport'
};

/**
 * Fare policy published by 呼和浩特市发展和改革委员会
 * (《关于呼和浩特市轨道交通票制票价的通知》, 2019-12-20, published on
 * `www.hhht.gov.cn`): 里程分段计价票制 —
 * 0-5 公里（含）2 元，5-10 公里（含）3 元，10-15 公里（含）4 元，
 * 15-21 公里（含）5 元，21-28 公里（含）6 元，28 公里以上每增加 1 元可继续
 * 乘坐 10 公里。
 */
export const HOHHOT_FARE_POLICY =
  '里程分段计价票制：0-5公里（含）2元，5-10公里（含）3元，10-15公里（含）4元，15-21公里（含）5元，21-28公里（含）6元，28公里以上每增加1元可继续乘坐10公里；普通储值卡9.5折，学生卡/老年卡/爱心卡5折，70周岁以上老年人、现役军人、残疾人、盲人及1名陪护人员、离休干部、消防人员凭有效证件免费乘车，身高1.3米（含）以下儿童须成人陪同免费。';

/**
 * Cumulative distance limits (km) reachable for each whole-yuan fare, as
 * published by the tariff above.
 */
export const HOHHOT_FARE_LADDER_KM = [5, 10, 15, 21, 28];

/**
 * Fare (yuan) for a ride of `km` km, per the published mileage ladder:
 * 0-5 km → 2 元, 5-10 → 3, 10-15 → 4, 15-21 → 5, 21-28 → 6, and above
 * 28 km one more yuan buys another 10 km (28-38 → 7 元, 38-48 → 8 元).
 */
export function hohhotFareForKm(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 0;
  let fare = 2;
  for (const limit of HOHHOT_FARE_LADDER_KM) {
    if (km <= limit) return fare;
    fare++;
  }
  // The band above the last limit runs 10 km per yuan, and its upper edge is
  // inclusive: 28.88 km is still 7 元, 38.01 km is 8 元.
  const last = HOHHOT_FARE_LADDER_KM[HOHHOT_FARE_LADDER_KM.length - 1]!;
  return fare + Math.ceil((km - last) / 10) - 1;
}

/**
 * The longest single journey in the network: Line 1's east end
 * (坝堰(机场)(国内航站楼)) to Line 2's north end (塔利东路) through the
 * 新华广场 interchange — 14.4 km on Line 1 + 14.5 km on Line 2 ≈ 29 km,
 * which lands in the "28 km 以上" band at 7 元. Same-line end-to-end trips
 * are cheaper (1号线 6 元, 2号线 6 元).
 */
export const HOHHOT_MAX_FARE = 7;

/**
 * The operator's published 首末站首末班车时间一览表 (end-of-line first/last
 * train times, as shown on `www.hhhtmetro.com` and mirrored by 百度百科
 * 「呼和浩特地铁」, 2024-12 reading).
 *
 * These are the current end-of-line times; the planner quotes reproduce them
 * exactly, which makes them a precise regression check for the timetable
 * harvest (a plain mismatch means the planner data drifted).
 */
export const OFFICIAL_TERMINUS_TIMES: { station: string; first: string; last: string }[] = [
  { station: '伊利健康谷', first: '06:00', last: '22:09' },
  { station: '坝堰(机场)(国内航站楼)', first: '06:00', last: '22:01' },
  { station: '阿尔山路', first: '06:00', last: '22:04' },
  { station: '塔利东路', first: '06:00', last: '22:00' }
];

/**
 * A sample of the operator's published per-station 首末班车时刻一览表
 * (as published on `www.hhhtmetro.com`, 2020-07 reading). The sheet is
 * image-only and its end-of-line times have since been revised, so this is a
 * *tolerant* check (see `timetables.ts`): the planner must not differ from
 * the sheet by more than 15 minutes in either direction.
 */
export const OFFICIAL_TIMETABLE_SAMPLE: {
  station: string;
  /** Direction label as published: `往X`. */
  toward: string;
  first: string;
  last: string;
}[] = [
  { station: '市政府', toward: '坝堰(机场)', first: '06:33', last: '22:33' },
  { station: '市政府', toward: '伊利健康谷', first: '06:12', last: '22:12' },
  { station: '新华广场', toward: '阿尔山路', first: '06:27', last: '22:31' },
  { station: '呼和浩特东站', toward: '坝堰(机场)', first: '06:36', last: '22:36' },
  { station: '乌兰夫纪念馆', toward: '伊利健康谷', first: '06:32', last: '22:32' }
];

/**
 * The single interchange: 新华广场, where Line 1 and Line 2 cross. The
 * operator describes it as a 十字换乘 (cross-platform transfer — passengers
 * change lines without leaving the paid area).
 */
export const HOHHOT_INTERCHANGE = '新华广场';

/**
 * Service note: the operator announces holiday operating-hour extensions on
 * its official WeChat account (e.g. 2025-12-31 → 2026-01-01 first train 06:00,
 * last train 01:30 next day). The planner keeps the regular timetable during
 * such extensions, so the harvested last trains run earlier than the extended
 * service; operator announcements are authoritative on those days.
 */
export const HOHHOT_SCHEDULE_NOTE =
  '节假日及跨年夜运营方会临时延长运营时间并加密发车间隔（以官方微信公众号公告为准）；期间规划器仍返回常规运行图，末班车数据早于实际约1小时。';

/**
 * Harbin Metro line configuration.
 *
 * The operator (哈尔滨地铁集团有限公司) publishes its network only as prose
 * and images — the official site `www.harbin-metro.com` has been serving a
 * "维护升级中" placeholder on every path, and the 运营时刻 section was never
 * populated even before that. All machine-readable facts live here and in
 * `fetch.ts` (AMap) / `baidu.ts` (Baidu Direction v2).
 */
import type { LineMode } from '@openmetro/core';

export interface HarbinLineConfig {
  /** Compact display code for badges (`1`, `2`, `3`). */
  short: string;
  /** Official Chinese display name (AMap `ln`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  /** AMap subway dataset line name (`ln`). */
  amapName: string;
  /** English name. */
  nameEn: string;
  mode: LineMode;
  /** Baidu planner vehicle-name fragment (`地铁1号线`). */
  baiduNameHint: string;
  /** Closed ring (Line 3 is the only loop in the network). */
  loop: boolean;
}

export const HARBIN_LINES: HarbinLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    baiduNameHint: '地铁1号线',
    loop: false
  },
  {
    short: '2',
    name: '2号线',
    slug: '2',
    amapName: '2号线',
    nameEn: 'Line 2',
    mode: 'metro',
    baiduNameHint: '地铁2号线',
    loop: false
  },
  {
    short: '3',
    name: '3号线',
    slug: '3',
    amapName: '3号线',
    nameEn: 'Line 3',
    mode: 'metro',
    baiduNameHint: '地铁3号线',
    loop: true
  }
];

/**
 * Stations that share a footprint with a China Railway station
 * (哈尔滨东站 / 南站 / 北站 / 站 / 西站).
 *
 * Baidu resolves the AMap centroid of these onto the *railway* POI, so an OD
 * whose destination is one of them comes back as a bus route with no metro leg.
 * Nudging the destination coordinate ~130 m lands on the metro station again.
 */
export const RAILWAY_HUB_STATIONS: readonly string[] = [
  '哈尔滨东站',
  '哈尔滨南站',
  '哈尔滨北站',
  '哈尔滨站',
  '哈尔滨西站'
];

/**
 * Official mileage tariff (官网《地铁票价及优惠政策》, 2021-12-23):
 * 起步 2 元可乘坐 6 公里，每 1 元进级，3 元 10 公里、4 元 14 公里、
 * 5 元 21 公里、6 元 28 公里，29 公里以上每增加 10 公里增加 1 元。
 */
export const HARBIN_MILEAGE_TARIFF = {
  steps: [
    { upToKm: 6, yuan: 2 },
    { upToKm: 10, yuan: 3 },
    { upToKm: 14, yuan: 4 },
    { upToKm: 21, yuan: 5 },
    { upToKm: 28, yuan: 6 }
  ],
  beyondKm: 29,
  perKm: 10
} as const;

/** Official fare for a charged mileage, in yuan. */
export function harbinMileageFare(km: number): number {
  if (!Number.isFinite(km) || km < 0) return 2;
  for (const step of HARBIN_MILEAGE_TARIFF.steps) {
    if (km <= step.upToKm) return step.yuan;
  }
  const over = km - HARBIN_MILEAGE_TARIFF.beyondKm;
  return 6 + Math.max(1, Math.ceil(over / HARBIN_MILEAGE_TARIFF.perKm));
}

/**
 * Operating-hours / schedule note. The regular timetable runs 06:00–22:30
 * (first trains from ~05:30); the operator extends the last train to 23:00 on
 * statutory holidays and peak events (announced on its official WeChat
 * account). Planners keep the regular graph, so the extension is not captured.
 */
export const SCHEDULE_NOTE =
  '常规运行图 06:00–22:30（各站首班约 05:30 起，末班 22:30–23:26）；法定节假日与大型活动期间运营方将末班延至 23:00（临时调整，规划器数据为常规图，未固化）';

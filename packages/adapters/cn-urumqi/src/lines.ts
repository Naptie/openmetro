/**
 * Ürümqi Metro line configuration — the operator's two service lines
 * (official timetable, urumqimtr.com): metro Line 1 and the airport APM
 * (机场捷运, the provisional T4-terminal operation of Line 2's first
 * section, opened 2025-04-17). All city-specific facts live here.
 */
import type { LineMode } from '@openmetro/core';

export interface UrumqiLineConfig {
  /** Compact display code for badges (`1`, `机场捷运`). */
  short: string;
  /** Official Chinese display name (timetable heading / AMap `ln`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  /** AMap subway dataset line name (`ln`). */
  amapName: string;
  /** English name (AMap multilang; "URUMQI METRO" operator branding). */
  nameEn: string;
  mode: LineMode;
  /** Baidu planner vehicle-name fragment (`地铁1号线` / `乌鲁木齐捷运线`). */
  baiduNameHint: string;
}

export const URUMQI_LINES: UrumqiLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    baiduNameHint: '地铁1号线'
  },
  {
    short: '机场捷运',
    name: '机场捷运',
    slug: 'apm',
    amapName: '机场捷运',
    nameEn: 'Airport MRT',
    mode: 'other',
    baiduNameHint: '捷运'
  }
];

/**
 * Official schedule note (operator announcements, 乌鲁木齐地铁 official
 * WeChat account): the regular timetable runs from Oct 8 to the following
 * June 30; during the summer peak season the operator temporarily extends
 * operating hours by ~1 h (latest cycle 2026-07-01 → 2026-10-07). The
 * first/last-train sheet image on urumqimtr.com can lag a reversion by days,
 * and the planners keep the regular timetable during an extension.
 */
export const SCHEDULE_NOTE =
  '常规运行图为每年10月8日至次年6月30日（休息日全日间隔15分钟）；夏季旅游旺季运营方临时延长运营约1小时（最近一次为2026-07-01至10-07），规划器数据在延长期间早于实际末班约1小时，以运营方公告为准';

/**
 * The APM is physically Line 2's first section, opened 2025-04-17 as the
 * T4-terminal people mover (国际机场 ↔ 国际机场北); the 机场东站 extension will
 * bring the through Line 2 identity (zh.wikipedia, 运营线路/在建线路).
 */
export const APM_SERVICE_NOTE =
  '机场捷运为2号线一期（南门—华山街段尚在建）先期开通段，2025-04-17开通，国际机场站与1号线换乘，未来延伸机场东站并贯通2号线';

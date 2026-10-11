/**
 * Jinan Rail Transit line configuration — the operator's eight service lines
 * (public timetable, 2026-09): metro lines 1/2/3/4/6/8, the suburban Jiyang
 * Line and the SkyShuttle (云巴) loop. All city-specific facts live here.
 */
import type { LineMode } from '@openmetro/core';

export interface JinanLineConfig {
  /** Compact display code for badges (`1` … `8`, `JY`, `YB`). */
  short: string;
  /** Official Chinese display name (map legend / timetable heading). */
  name: string;
  /** AMap subway dataset line name (`ln`). */
  amapName: string;
  /** Official English name from the network-map legend. */
  nameEn: string;
  mode: LineMode;
  loop: boolean;
  /** Baidu planner vehicle name for this line (`地铁N号线` / `地铁济阳线` / `云巴1号线`). */
  baiduName: string;
  /** `flat2`: the Jiyang Line charges a flat 2 yuan regardless of distance. */
  fare: 'mileage' | 'flat2';
  /** Through-running partner lines (official joint 4/8 timetable). */
  throughRunWith?: string;
}

export const JINAN_LINES: JinanLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    loop: false,
    baiduName: '地铁1号线',
    fare: 'mileage'
  },
  {
    short: '2',
    name: '2号线',
    amapName: '2号线',
    nameEn: 'Line 2',
    mode: 'metro',
    loop: false,
    baiduName: '地铁2号线',
    fare: 'mileage'
  },
  {
    short: '3',
    name: '3号线',
    amapName: '3号线',
    nameEn: 'Line 3',
    mode: 'metro',
    loop: false,
    baiduName: '地铁3号线',
    fare: 'mileage'
  },
  {
    short: '4',
    name: '4号线',
    amapName: '4号线',
    nameEn: 'Line 4',
    mode: 'metro',
    loop: false,
    baiduName: '地铁4号线',
    fare: 'mileage'
  },
  {
    short: '6',
    name: '6号线',
    amapName: '6号线',
    nameEn: 'Line 6',
    mode: 'metro',
    loop: false,
    baiduName: '地铁6号线',
    fare: 'mileage'
  },
  {
    short: '8',
    name: '8号线',
    amapName: '8号线',
    nameEn: 'Line 8',
    mode: 'metro',
    loop: false,
    baiduName: '地铁8号线',
    fare: 'mileage',
    throughRunWith: '4/8'
  },
  {
    short: 'JY',
    name: '济阳线',
    amapName: '济阳线',
    nameEn: 'Jiyang Line',
    mode: 'suburban_rail',
    loop: false,
    baiduName: '地铁济阳线',
    fare: 'flat2'
  },
  {
    short: 'YB',
    name: '云巴线',
    amapName: '云巴1号线',
    nameEn: 'SkyShuttle Line',
    mode: 'monorail',
    loop: true,
    baiduName: '云巴1号线',
    fare: 'mileage'
  }
];

/**
 * Official service notes (official timetable, plain text): the operator runs
 * later last trains on Friday–Sunday on these directions (Line 1 toward
 * 工研院 22:00→22:30; Line 8 toward 清源大街 22:05→22:30). The Baidu planner
 * mixes day-type schedules per station, so this fact is recorded as
 * documentation on the line rather than rebuilt into per-station arrays.
 */
export const LINE_SERVICE_NOTES: Record<string, string> = {
  '1': '往工研院方向每周五、六、日延长运营（末班约+30分钟）',
  '8': '往清源大街方向每周五至周日延长运营（末班约+25分钟）'
};

/**
 * AMap English-label fixes, verified against official signage:
 * - AMap swaps the English labels of 梁王/梁王西 (Line 6 terminus pair).
 * - AMap misspells several romanisations (SOPRTS/CNETER/QUANCHNEG).
 */
export const STATION_EN_OVERRIDES: Record<string, string> = {
  梁王: 'Liangwang',
  梁王西: 'Liangwang West',
  奥体中心: 'Olympic Sports Center',
  省体育中心: 'Shandong Sports Center',
  黄河会展中心: 'Yellow River Convention and Exhibition Center',
  泉城公园: 'Quancheng Park',
  山大南路东口: 'Shanda Nanlu East'
};

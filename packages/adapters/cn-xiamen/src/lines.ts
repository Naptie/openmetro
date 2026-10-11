/**
 * Xiamen Metro line configuration — the operator's five service lines
 * (official CMS `/api/transit/lines`, 2026-10): metro lines 1/2/3/4/6.
 * All city-specific facts live here.
 */
import type { LineMode } from '@openmetro/core';

export interface XiamenLineConfig {
  /** Compact display code for badges (`1` … `6`). */
  short: string;
  /** Official Chinese display name. */
  name: string;
  /** AMap subway dataset line name (`ln`). */
  amapName: string;
  /** Official CMS line id (xmgdjt.com.cn `/api/transit/lines`). */
  cmsLineId: string;
  /** Official English name pattern (CMS publishes none). */
  nameEn: string;
  mode: LineMode;
  /** Baidu planner vehicle name for this line (`地铁N号线`). */
  baiduName: string;
  /**
   * The CMS publishes per-station first/last trains for lines 1–3 only;
   * lines 4/6 have no timetable records (UUID-id stations carry none), so
   * their first/last trains are harvested via Baidu Direction Lite.
   */
  cmsTimetable: boolean;
}

export const XIAMEN_LINES: XiamenLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    amapName: '1号线',
    cmsLineId: 'L1001',
    nameEn: 'Line 1',
    mode: 'metro',
    baiduName: '地铁1号线',
    cmsTimetable: true
  },
  {
    short: '2',
    name: '2号线',
    amapName: '2号线',
    cmsLineId: 'L1002',
    nameEn: 'Line 2',
    mode: 'metro',
    baiduName: '地铁2号线',
    cmsTimetable: true
  },
  {
    short: '3',
    name: '3号线',
    amapName: '3号线',
    cmsLineId: 'L1003',
    nameEn: 'Line 3',
    mode: 'metro',
    baiduName: '地铁3号线',
    cmsTimetable: true
  },
  {
    short: '4',
    name: '4号线',
    amapName: '4号线',
    cmsLineId: 'L1004',
    nameEn: 'Line 4',
    mode: 'metro',
    baiduName: '地铁4号线',
    cmsTimetable: false
  },
  {
    short: '6',
    name: '6号线',
    amapName: '6号线',
    cmsLineId: 'L1006',
    nameEn: 'Line 6',
    mode: 'metro',
    baiduName: '地铁6号线',
    cmsTimetable: false
  }
];

export const LINE_BY_CMS_ID = new Map(XIAMEN_LINES.map((l) => [l.cmsLineId, l] as const));

/**
 * Qingdao Metro line configuration — the operator's eight service lines
 * (official website qd-metro.com, 2026-10): metro lines 1/2/3/4/6/8 plus the
 * 蓝谷快线 (ex-Line 11) and 西海岸快线 (ex-Line 13) suburban expresses.
 * All city-specific facts live here.
 */
import type { LineMode } from '@openmetro/core';

export interface QingdaoLineConfig {
  /** Compact display code for badges (`1` … `8`, `11`, `13`). */
  short: string;
  /** Official Chinese display name (network-map legend). */
  name: string;
  /** AMap subway dataset line name (`ln`). */
  amapName: string;
  /** Official siteSearch `line` parameter (1/2/3/4/6/8/11/13). */
  siteLine: number;
  /** Official English name from the network-map legend. */
  nameEn: string;
  mode: LineMode;
  /** Baidu planner vehicle name for this line (`地铁N号线` / `蓝谷快线`). */
  baiduName: string;
  /** Prior operator names kept as aliases (the expresses were re-branded). */
  aliases?: string[];
}

export const QINGDAO_LINES: QingdaoLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    amapName: '1号线',
    siteLine: 1,
    nameEn: 'Line 1',
    mode: 'metro',
    baiduName: '地铁1号线'
  },
  {
    short: '2',
    name: '2号线',
    amapName: '2号线',
    siteLine: 2,
    nameEn: 'Line 2',
    mode: 'metro',
    baiduName: '地铁2号线'
  },
  {
    short: '3',
    name: '3号线',
    amapName: '3号线',
    siteLine: 3,
    nameEn: 'Line 3',
    mode: 'metro',
    baiduName: '地铁3号线'
  },
  {
    short: '4',
    name: '4号线',
    amapName: '4号线',
    siteLine: 4,
    nameEn: 'Line 4',
    mode: 'metro',
    baiduName: '地铁4号线'
  },
  {
    short: '6',
    name: '6号线',
    amapName: '6号线',
    siteLine: 6,
    nameEn: 'Line 6',
    mode: 'metro',
    baiduName: '地铁6号线'
  },
  {
    short: '8',
    name: '8号线',
    amapName: '8号线',
    siteLine: 8,
    nameEn: 'Line 8',
    mode: 'metro',
    baiduName: '地铁8号线'
  },
  {
    short: '11',
    name: '蓝谷快线',
    amapName: '蓝谷快线',
    siteLine: 11,
    nameEn: 'Oceantec Valley Line',
    mode: 'suburban_rail',
    baiduName: '蓝谷快线',
    aliases: ['11号线']
  },
  {
    short: '13',
    name: '西海岸快线',
    amapName: '西海岸快线',
    siteLine: 13,
    nameEn: 'The West Coast Line',
    mode: 'suburban_rail',
    baiduName: '西海岸快线',
    aliases: ['13号线']
  }
];

/** Official routing-fare tariff for cross-checking the published matrix. */
export const FARE_TARIFF_NOTE =
  '里程计价：起步 2 元 5km，5-10/10-15/15-22/22-29km 分别 3/4/5/6 元，29km 以上每 9km 加 1 元';

/**
 * The operator swapped several AMap labels for the plain physical name.
 * Verified against qd-metro.com signage / official network map.
 */
export const STATION_EN_OVERRIDES: Record<string, string> = {
  青岛北站: 'Qingdao North Railway Station',
  青岛站: 'Qingdao Railway Station',
  红岛火车站: 'Hongdao Railway Station',
  董家口火车站: 'Dongjiakou Railway Station',
  胶州北站: 'Jiaozhou North Railway Station',
  胶东机场: 'Jiaodong Airport'
};

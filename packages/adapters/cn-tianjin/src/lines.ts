/**
 * Tianjin Rail Transit line configuration — the operator's 13 service lines
 * (tjgdjt.com official H5 timetable + AMap subway dataset, 2026-10): metro
 * lines 1/2/3/4/5/6/7/9/10/11, the Binhai Z4 line and the Jinjing suburban
 * line. All city-specific facts live here.
 *
 * Three lines operate as split/short-turn alignments and are modelled as one
 * line with several patterns:
 * - 4号线: 南段 (东南角↔新兴村) and 北段 (小街↔西站) — the middle section
 *   (西站↔东南角) is still under construction, so the two segments do not
 *   interconnect.
 * - 6号线: 主线 (南孙庄↔渌水道) plus 二期 (渌水道↔咸水沽西) joining at
 *   渌水道; the official timetable publishes the two alignments separately.
 * - 9号线: full line (天津站↔东海路) plus a 天津站↔新立 short-turn (区间).
 */
import type { LineMode } from '@openmetro/core';

export interface TianjinAlignmentConfig {
  /** Official H5 timetable alignment label (chunk `lineName`). */
  h5Name: string;
  /** Stable pattern-key fragment, e.g. `main`, `south`, `phase2`, `shuttle`. */
  key: string;
  /** First station of this alignment's AMap entry (picks among same-`ln` entries). */
  amapFirstStation?: string;
  /**
   * Short-turn alignments (9号线区间) have no separate AMap entry: their
   * stations are a contiguous slice of another alignment of the same line.
   */
  sliceOf?: string;
  /** `[fromName, toName]` in the sliced alignment's AMap order (inclusive). */
  sliceStations?: [string, string];
  /**
   * A service variant that rides an existing alignment's tracks and only
   * differs in its termini (the 区间 short-turn): it contributes timetable
   * rows (with its own destination stop) but no pattern of its own — the
   * canonical pattern is the route alignment, not the service variant.
   */
  timetableOnly?: boolean;
  /** Shared stop with the line's primary alignment (branch/short-turn attachments). */
  junctionStation?: string;
  isPrimary: boolean;
  labelZh: string;
  labelEn: string;
}

export interface TianjinLineConfig {
  /** Compact display code for badges (`1` … `11`, `Z4`, `津静线`). */
  short: string;
  /** ASCII slug used in entity ids (`1` … `11`, `z4`, `jinjing`). */
  slug: string;
  /** Official Chinese display name (map legend / timetable heading). */
  name: string;
  /** AMap subway dataset line name (`ln`). Split lines match two entries. */
  amapName: string;
  /** Official English name (operator style). */
  nameEn: string;
  mode: LineMode;
  loop: boolean;
  /** One entry per published service alignment (primary first). */
  alignments: TianjinAlignmentConfig[];
  /** Official notes carried into the line record. */
  serviceNote?: string;
}

/** 津静线跨线车 (through service onto Line 5) published departures, 2026-10. */
export const JINJING_THROUGH_DEPARTURES = {
  from_tuanbo: {
    weekdays: ['11:04', '12:07', '14:01'],
    weekends: ['10:54', '11:57', '13:57']
  },
  from_beichen: {
    weekdays: ['10:42', '12:36', '13:40'],
    weekends: ['10:29', '12:28', '13:24']
  }
} as const;

export const TIANJIN_LINES: TianjinLineConfig[] = [
  {
    short: '1',
    slug: '1',
    name: '1号线',
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '1号线',
        key: 'main',
        amapFirstStation: '刘园',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '2',
    slug: '2',
    name: '2号线',
    amapName: '2号线',
    nameEn: 'Line 2',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '2号线',
        key: 'main',
        amapFirstStation: '滨海国际机场',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '3',
    slug: '3',
    name: '3号线',
    amapName: '3号线',
    nameEn: 'Line 3',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '3号线',
        key: 'main',
        amapFirstStation: '小淀',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '4',
    slug: '4',
    name: '4号线',
    amapName: '4号线',
    nameEn: 'Line 4',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '4号线南段',
        key: 'south',
        amapFirstStation: '东南角',
        isPrimary: true,
        labelZh: '南段',
        labelEn: 'South section'
      },
      {
        h5Name: '4号线北段',
        key: 'north',
        amapFirstStation: '小街',
        isPrimary: false,
        labelZh: '北段',
        labelEn: 'North section'
      }
    ]
  },
  {
    short: '5',
    slug: '5',
    name: '5号线',
    amapName: '5号线',
    nameEn: 'Line 5',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '5号线',
        key: 'main',
        amapFirstStation: '京华东道',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '6',
    slug: '6',
    name: '6号线',
    amapName: '6号线',
    nameEn: 'Line 6',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '6号线',
        key: 'main',
        amapFirstStation: '南孙庄',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      },
      {
        h5Name: '6号线二期',
        key: 'phase2',
        amapFirstStation: '渌水道',
        junctionStation: '渌水道',
        isPrimary: false,
        labelZh: '二期',
        labelEn: 'Phase 2'
      }
    ]
  },
  {
    short: '7',
    slug: '7',
    name: '7号线',
    amapName: '7号线',
    nameEn: 'Line 7',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '7号线',
        key: 'main',
        amapFirstStation: '鼓楼',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '9',
    slug: '9',
    name: '9号线',
    amapName: '9号线',
    nameEn: 'Line 9',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '9号线',
        key: 'main',
        amapFirstStation: '东海路',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      },
      {
        h5Name: '9号线区间',
        key: 'shuttle',
        sliceOf: 'main',
        sliceStations: ['新立', '天津站'],
        timetableOnly: true,
        isPrimary: false,
        labelZh: '区间',
        labelEn: 'Short-turn'
      }
    ],
    // 津滨轻轨: 天津站—中山门 counts into the metro fare network; 中山门—东海路
    // (滨海段) has its own per-station fare table. 早间/晚间快车 run 天津站↔塘沽
    // skipping intermediate stops (no per-station first/last published).
    serviceNote: '9号线滨海段（中山门—东海路）实行独立计价；早间/晚间快车天津站—塘沽越站不停'
  },
  {
    short: '10',
    slug: '10',
    name: '10号线',
    amapName: '10号线',
    nameEn: 'Line 10',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '10号线',
        key: 'main',
        amapFirstStation: '屿东城',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '11',
    slug: '11',
    name: '11号线',
    amapName: '11号线',
    nameEn: 'Line 11',
    mode: 'metro',
    loop: false,
    alignments: [
      {
        h5Name: '11号线',
        key: 'main',
        amapFirstStation: '水上公园西路',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: 'Z4',
    slug: 'z4',
    name: 'Z4线',
    amapName: 'Z4线',
    nameEn: 'Line Z4',
    mode: 'suburban_rail',
    loop: false,
    alignments: [
      {
        h5Name: 'Z4线',
        key: 'main',
        amapFirstStation: '寨上',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ]
  },
  {
    short: '津静线',
    slug: 'jinjing',
    name: '津静线',
    amapName: '津静线',
    nameEn: 'Jinjing Line',
    mode: 'suburban_rail',
    loop: false,
    alignments: [
      {
        h5Name: '津静线',
        key: 'main',
        amapFirstStation: '京华东道',
        isPrimary: true,
        labelZh: '主线',
        labelEn: 'Main'
      }
    ],
    // 津静线 trains use Line 5's 京华东道 terminus (same platform); 跨线车
    // through-services continue onto Line 5 toward 北辰科技园北.
    serviceNote: '津静线与5号线在京华东道同台贯通；跨线车直达北辰科技园北'
  }
];

/** H5 alignment labels that carry no per-station first/last times. */
export const H5_SKIPPED_ALIGNMENTS: Record<string, string> = {
  '9号线早间快车': '早间快车（天津站—塘沽）越站运行，官方未发布逐站首末班车',
  '9号线晚间快车': '晚间快车（天津站—塘沽）越站运行，官方未发布逐站首末班车',
  津静线跨线车: '跨线车按班次发车（非逐站首末班车），班次时刻见线路备注'
};

/** Line extras: 津静线跨线车 published departure times (H5, 2026-10). */
export const THROUGH_SERVICE_NOTE =
  '津静线跨线车（经5号线至北辰科技园北）团泊医学园发车：工作日 11:04/12:07/14:01，周末及节假日 10:54/11:57/13:57；北辰科技园北发车：工作日 10:42/12:36/13:40，周末及节假日 10:29/12:28/13:24';

/**
 * Lanzhou Rail Transit line configuration.
 *
 * The operator (兰州市轨道交通有限公司, www.lzgdjt.com) runs two metro lines.
 * Its official website publishes the whole operating network as a plain
 * JavaScript literal in a production asset —
 * `/lzgd/template/js/serve.js`:
 *
 * ```js
 * const lines = [
 *   { title:'1号线', value:'1', lines:["陈官营", …, "东岗"] },
 *   { title:'2号线', value:'2', lines:["东方红广场", …, "雁白大桥"] }
 * ];
 * ```
 *
 * That literal is the **source of truth** for the line registry and the stop
 * order; the table below only adds the two facts the literal does not carry:
 * the canonical id slug and the Baidu planner's vehicle-name fragment.
 *
 * Line facts:
 * - 1 号线 — 陈官营 → 东岗, 20 stations, 25.23 km, opened 2019-06-23, blue.
 * - 2 号线 — 东方红广场 → 雁白大桥, 9 stations, 7.93 km, opened 2023-06-29, red.
 * - Interchanges: 东方红广场 (same-platform) and 五里铺 (node transfer).
 *
 * Under construction / planned lines (3/4/5/6/7 号线 per the 2023-08 线网规划
 * public notice) are deliberately not modelled: no machine-readable station
 * list exists for them, so hand-maintained tables would only drift.
 */
import type { LineMode } from '@openmetro/core';

export interface LanzhouLineConfig {
  /** Official `value` field in the operator's `serve.js` literal (`'1'`, `'2'`). */
  officialId: string;
  /** Compact display code for badges (`1`, `2`). */
  short: string;
  /** Official Chinese display name (`title` in the operator's literal). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Baidu planner vehicle name for this line (`轨道交通1号线`). */
  baiduNameHint: string;
}

export const LANZHOU_LINES: LanzhouLineConfig[] = [
  {
    officialId: '1',
    short: '1',
    name: '1号线',
    slug: '1',
    mode: 'metro',
    baiduNameHint: '轨道交通1号线'
  },
  {
    officialId: '2',
    short: '2',
    name: '2号线',
    slug: '2',
    mode: 'metro',
    baiduNameHint: '轨道交通2号线'
  }
];

/** Official `value` in the operator's literal → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_ID = new Map<string, LanzhouLineConfig>(
  LANZHOU_LINES.map((l) => [l.officialId, l])
);

/**
 * Official single-journey tariff (里程分段计价), published by the operator's
 * 票务政策:
 *
 * > 起步价 2 元，起步里程 4 公里（含 4 公里），晋级里程为「4、4、6、6、8、8」，
 * > 即 3 元可乘坐 8 公里、4 元 12 公里、5 元 18 公里、6 元 24 公里、7 元 32 公里、
 * > 8 元 40 公里，40 公里以上每加 1 元可乘 8 公里。
 *
 * The ladder is the published policy, but the **fares layer uses the
 * operator's own published OD matrix** (`fareData.js`, see `./fares.ts`) — this
 * tariff is only used to sanity-check that matrix.
 */
export const LANZHOU_TARIFF = {
  /** Cumulative charged mileage (km) at each price point. */
  cumulativeKm: [4, 8, 12, 18, 24, 32, 40],
  /** Price (yuan) for each cumulative mileage entry above. */
  yuan: [2, 3, 4, 5, 6, 7, 8],
  /** Above 40 km the fare grows by 1 yuan per additional 8 km. */
  beyondKm: 40,
  beyondStepKm: 8,
  beyondStepYuan: 1
} as const;

/** Official fare for a charged mileage of `km`. */
export function lanzhouMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return LANZHOU_TARIFF.yuan[0];
  for (let i = 0; i < LANZHOU_TARIFF.cumulativeKm.length; i++) {
    if (km <= LANZHOU_TARIFF.cumulativeKm[i]! + 1e-9) return LANZHOU_TARIFF.yuan[i]!;
  }
  const over = km - LANZHOU_TARIFF.beyondKm;
  return (
    LANZHOU_TARIFF.yuan[LANZHOU_TARIFF.yuan.length - 1]! +
    Math.ceil(over / LANZHOU_TARIFF.beyondStepKm) * LANZHOU_TARIFF.beyondStepYuan
  );
}

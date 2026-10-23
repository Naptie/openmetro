/**
 * Xuzhou Metro line configuration and the official mileage tariff.
 *
 * The operator (徐州地铁集团有限公司) runs four metro lines. The official
 * website publishes them in the `dropBox` tree embedded in its homepage, and
 * that tree is the authority for the line list, the per-line station order and
 * the global station ids (1…76).
 *
 * Two operator-side quirks this module encodes:
 *
 * 1. **The route-planner line parameter is a 0-based position**, not the line
 *    number. The site's own `<select>` options are `0`=1号线, `1`=2号线,
 *    `2`=3号线, `3`=6号线. Passing the line number (`6`) makes the backend
 *    throw `Index 6 out of bounds for length 4`. `officialIndex` below is the
 *    value the site expects.
 * 2. **Station ids are global and contiguous per line**: 1号线 owns 1–18,
 *    2号线 19–38, 3号线 39–60, 6号线 61–76. A station served by two lines has
 *    one id per line, so the same physical station appears under two ids —
 *    the interchanges are 彭城广场 (L1+L2), 徐州火车站 (L1+L3),
 *    徐州东站 (L1+L6), 淮塔 (L2+L3), 市行政中心 (L2+L6), 玉泉河 (L3+L6).
 *
 * Under construction and therefore absent from every machine-readable source —
 * 4号线一期, 5号线一期 — are deliberately not modelled: there is no structured
 * station list to sync, and hand-maintained tables would drift.
 */
import type { LineMode } from '@openmetro/core';

export interface XuzhouLineConfig {
  /** Compact display code for badges (`1`). */
  short: string;
  /** Official Chinese display name (`1号线`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /**
   * The 0-based line position the official route planner expects in its
   * `sLine` / `eLine` parameters (0 = 1号线 … 3 = 6号线).
   */
  officialIndex: number;
  /** Baidu planner vehicle-name fragment (`地铁1号线`). */
  baiduNameHint: string;
}

export const XUZHOU_LINES: XuzhouLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    mode: 'metro',
    officialIndex: 0,
    baiduNameHint: '地铁1号线'
  },
  {
    short: '2',
    name: '2号线',
    slug: '2',
    mode: 'metro',
    officialIndex: 1,
    baiduNameHint: '地铁2号线'
  },
  {
    short: '3',
    name: '3号线',
    slug: '3',
    mode: 'metro',
    officialIndex: 2,
    baiduNameHint: '地铁3号线'
  },
  {
    short: '6',
    name: '6号线',
    slug: '6',
    mode: 'metro',
    officialIndex: 3,
    baiduNameHint: '地铁6号线'
  }
];

/** Official line name (`1号线`) → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_NAME = new Map<string, XuzhouLineConfig>(
  XUZHOU_LINES.map((l) => [l.name, l] as const)
);

/** The 0-based planner position → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_INDEX = new Map<number, XuzhouLineConfig>(
  XUZHOU_LINES.map((l) => [l.officialIndex, l] as const)
);

/**
 * Official fare policy (`/article/42/pwgz/3861.html`, 票务规则):
 *
 * > 起步价2元可乘6km，6～18km每1元可乘6km，18～34km每1元可乘8km，34km～44km每1元可乘10km，
 * > 44km～59km每1元可乘15km，59km以上每1元可乘20km。
 *
 * The bands step at 6/12/18/26/34/44/59/79… km, so the tariff is a plain
 * threshold function over the charged (in-vehicle) mileage — not a per-band
 * ceiling. The operator prices every journey on its **shortest path** mileage
 * ("最短路径法"), which is exactly what the official route planner returns, so
 * this function is used to cross-check the harvested matrix rather than to
 * replace it.
 */
export const XUZHOU_TARIFF = {
  /** Charged mileage thresholds (km) — each crossed threshold adds 1 yuan. */
  thresholdsKm: [6, 12, 18, 26, 34, 44, 59, 79, 99, 119, 139, 159, 179, 199],
  /** Base fare for the 0–6 km band. */
  baseYuan: 2
} as const;

/** Official single-journey fare for a charged mileage of `km`. */
export function xuzhouMileageFare(km: number): number {
  if (!Number.isFinite(km) || km < 0) return XUZHOU_TARIFF.baseYuan;
  let yuan = XUZHOU_TARIFF.baseYuan;
  for (const threshold of XUZHOU_TARIFF.thresholdsKm) {
    if (km > threshold) yuan++;
  }
  return yuan;
}

/**
 * Official discount policy (`/article/43/pjyhzc/3862.html`, 票价政策):
 *
 * - 徐州市民卡 / 交通一卡通: 单程票价 9.5 折
 * - 60～69 周岁老人: 5 折
 * - 70 周岁（含）以上老人: 免费
 * - 身高 1.3 m 以下儿童: 免费
 * - 全日制学校学生: 5 折
 * - 轨道与公交 60 分钟内换乘: 基础票价优惠 1 元
 *
 * The canonical fare matrix publishes the **standard single-journey** fare, so
 * these discounts are recorded as documentation only.
 */
export const XUZHOU_DISCOUNTS = {
  cityCardRatio: 0.95,
  senior60to69Ratio: 0.5,
  senior70PlusRatio: 0,
  studentRatio: 0.5,
  childFreeUnderHeightM: 1.3,
  metroBusTransferDiscountYuan: 1,
  metroBusTransferWindowMinutes: 60
} as const;

/**
 * Shijiazhuang Metro line configuration.
 *
 * The operator (石家庄市轨道交通集团) runs three metro lines. The official
 * `/metro/lines.html` endpoint publishes them as `line_id` 1/2/3 with the
 * operator's own `line_name` (`1号线`) and `color_code`; the registry below
 * mirrors those ids so the adapter can cross-check the feed and so the Baidu
 * planner's vehicle-name fragment (`地铁1号线`) stays explicit.
 *
 * Under construction (二期建设规划, 58.85 km, approved 2022-08) and therefore
 * absent from every machine-readable source — 1号线二期 / 1号线三期, 4号线一期,
 * 5号线一期 and 6号线一期 — are deliberately not modelled: there is no
 * structured station list to sync, and hand-maintained tables would drift.
 */
import type { LineMode } from '@openmetro/core';

export interface ShijiazhuangLineConfig {
  /** Compact display code for badges (`1`). */
  short: string;
  /** Official Chinese display name (`/metro/lines.html` `line_name`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Baidu planner vehicle-name fragment (`地铁1号线`). */
  baiduNameHint: string;
}

export const SHIJIAZHUANG_LINES: ShijiazhuangLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    mode: 'metro',
    baiduNameHint: '地铁1号线'
  },
  {
    short: '2',
    name: '2号线',
    slug: '2',
    mode: 'metro',
    baiduNameHint: '地铁2号线'
  },
  {
    short: '3',
    name: '3号线',
    slug: '3',
    mode: 'metro',
    baiduNameHint: '地铁3号线'
  }
];

/** Official line id (`/metro/lines.html` `line_id`) → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_ID = new Map<number, ShijiazhuangLineConfig>(
  SHIJIAZHUANG_LINES.map((l, i) => [i + 1, l])
);

/**
 * Official fare policy (`/service/ticket.html`, 票务政策):
 *
 * > 单程票价方案：起步价6公里2元，6～20公里每递增7公里加1元，20～36公里每递增8公里加1元，
 * > 36～54公里每递增9公里加1元，54公里以上每递增10公里加1元。
 *
 * The bands step at 6/13/20/28/36/45/54/64… km, so the tariff is a plain
 * threshold function over the charged (in-vehicle) mileage — not a per-band
 * ceiling. The operator prices every journey on its **shortest path** mileage
 * ("采用最短路径法"), which is what the fare layer computes.
 */
export const SHIJIAZHUANG_TARIFF = {
  /** Charged mileage thresholds (km) — each crossed threshold adds 1 yuan. */
  thresholdsKm: [6, 13, 20, 28, 36, 45, 54, 64, 74, 84, 94],
  /** Base fare for the 0–6 km band. */
  baseYuan: 2
} as const;

/** Official single-journey fare for a charged mileage of `km`. */
export function shijiazhuangMileageFare(km: number): number {
  if (!Number.isFinite(km) || km < 0) return SHIJIAZHUANG_TARIFF.baseYuan;
  let yuan = SHIJIAZHUANG_TARIFF.baseYuan;
  for (const threshold of SHIJIAZHUANG_TARIFF.thresholdsKm) {
    if (km > threshold) yuan++;
  }
  return yuan;
}

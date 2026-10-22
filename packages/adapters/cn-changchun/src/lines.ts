/**
 * Changchun Rail Transit line configuration and tariff.
 *
 * The operator (长春市轨道交通集团有限公司) runs eight lines. The official
 * `POST /api/v1/getLines` feed publishes them with the operator's own names
 * (`1号线` … `8号线`) and a two-digit `linecode` (`01` … `08`); the registry
 * below mirrors those so the adapter can cross-check the feed and keep the
 * Baidu planner's vehicle-name fragment (`轨道交通1号线`) explicit.
 *
 * Line 8 is the North Lake light-rail (有轨电车) line, so it is modelled as
 * `light_rail` rather than `metro` — it runs at street level and is operated
 * separately from the underground lines.
 *
 * Under construction — 1号线南延、3号线南延、9号线一期 (15 stations, station
 * names published only as a consultation PDF/image on 2026-04-30) — is
 * deliberately not modelled: no machine-readable station list exists, and a
 * hand-maintained table would drift.
 */
import type { LineMode } from '@openmetro/core';

export interface ChangchunLineConfig {
  /** Compact display code for badges (`1`). */
  short: string;
  /** Official Chinese display name (`/api/v1/getLines` `cname`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Baidu planner vehicle-name fragment (`轨道交通1号线`). */
  baiduNameHint: string;
}

export const CHANGCHUN_LINES: ChangchunLineConfig[] = [
  { short: '1', name: '1号线', slug: '1', mode: 'metro', baiduNameHint: '轨道交通1号线' },
  { short: '2', name: '2号线', slug: '2', mode: 'metro', baiduNameHint: '轨道交通2号线' },
  { short: '3', name: '3号线', slug: '3', mode: 'metro', baiduNameHint: '轨道交通3号线' },
  { short: '4', name: '4号线', slug: '4', mode: 'metro', baiduNameHint: '轨道交通4号线' },
  { short: '5', name: '5号线', slug: '5', mode: 'metro', baiduNameHint: '轨道交通5号线' },
  { short: '6', name: '6号线', slug: '6', mode: 'metro', baiduNameHint: '轨道交通6号线' },
  { short: '7', name: '7号线', slug: '7', mode: 'metro', baiduNameHint: '轨道交通7号线' },
  { short: '8', name: '8号线', slug: '8', mode: 'light_rail', baiduNameHint: '轨道交通8号线' }
];

/** Official `linecode` (`01` … `08`) → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_CODE = new Map<string, ChangchunLineConfig>(
  CHANGCHUN_LINES.map((l) => [l.short.padStart(2, '0'), l])
);

/** Official Chinese line name → registry entry. */
export const LINE_CONFIG_BY_NAME = new Map<string, ChangchunLineConfig>(
  CHANGCHUN_LINES.map((l) => [l.name, l])
);

/**
 * Official fare policy (官网 `/pwxx` 票务信息, restated in the 2026-09-29
 * 5号线 opening notice):
 *
 * > 长春轨道交通采用里程分段计价规则
 * > 2 元可乘坐 7 公里，后按照 6 公里、8 公里、10 公里梯度置级
 * > 0—7 公里，2 元；7—13 公里，3 元；13—19 公里，4 元；19—27 公里，5 元；
 * > 27—35 公里，6 元；35 公里以上，每增加 10 公里加价 1 元
 * > 轨道交通票价按照起点至终点最短路径核算
 *
 * The bands step at 7/13/19/27/35 km and then every 10 km, so the tariff is a
 * plain threshold function over the charged mileage. The operator prices every
 * journey on its **shortest path** mileage, which is what the fare layer
 * computes.
 */
export const CHANGCHUN_TARIFF = {
  /** Charged mileage thresholds (km) — each crossed threshold adds 1 yuan. */
  thresholdsKm: [7, 13, 19, 27, 35, 45, 55, 65, 75, 85, 95],
  /** Base fare for the 0–7 km band. */
  baseYuan: 2
} as const;

/**
 * Allowance added to the planner's in-vehicle mileage before the tariff is
 * applied, in km.
 *
 * The operator charges the distance between **stopping points**, while the
 * planner measures the distance between its own station reference points, so
 * the chargeable mileage runs slightly longer than the measured one.
 * Calibrated 2026-10-22 against 32 planner quotes: every quote is reproduced
 * by adding a flat allowance in the interval **[103 m, 312 m]**, and the two
 * tight constraints are
 *
 * - 4号线 长春站北→公平路 — measured 6 898 m, quoted 3 元 (the charge must
 *   cross 7 km → ≥ 103 m);
 * - 1号线 长春站北→华庆路 — measured 12 688 m, quoted 3 元 (the charge must
 *   stay under 13 km → ≤ 312 m).
 *
 * 200 m is the mid-window value; it reproduces every sampled quote.
 */
export const FARE_MILEAGE_ALLOWANCE_KM = 0.2;

/** Official single-journey fare for a charged mileage of `km`. */
export function changchunMileageFare(km: number): number {
  if (!Number.isFinite(km) || km < 0) return CHANGCHUN_TARIFF.baseYuan;
  let yuan = CHANGCHUN_TARIFF.baseYuan;
  for (const threshold of CHANGCHUN_TARIFF.thresholdsKm) {
    if (km > threshold) yuan++;
  }
  return yuan;
}

/**
 * Published fare anchors asserted on every run.
 *
 * Each pair was cross-checked against the Baidu planner's own quote, which
 * reproduces the operator's tariff exactly (measured 2026-10-22 against the
 * operator's published distance ladder). A mismatch means the segment
 * distances drifted or the ladder is mis-encoded — both must fail loudly
 * rather than ship.
 *
 * The anchors are pairs whose **shortest path is the direct single-line
 * ride**, so they test the distance model and the ladder rather than the
 * path-choice policy. `汽车公园→雾开河大街` is deliberately not one of them:
 * the direct 2号线 ride is 34.94 km (¥7) but the network's shortest path is
 * the 7号线→3号线→2号线 combination at 33.51 km (¥6), and the operator's
 * published rule prices on the shortest path.
 */
export const FARE_ANCHORS: { from: string; to: string; yuan: number }[] = [
  { from: '北环城路', to: '人民广场', yuan: 2 },
  { from: '汽车公园', to: '双丰', yuan: 2 },
  { from: '人民广场', to: '红嘴子', yuan: 3 },
  { from: '北环城路', to: '红嘴子', yuan: 4 },
  { from: '北环城路', to: '广通路', yuan: 4 },
  { from: '长春站北', to: '天新路', yuan: 5 },
  { from: '双丰', to: '雾开河大街', yuan: 6 }
];

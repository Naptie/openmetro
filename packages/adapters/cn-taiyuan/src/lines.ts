/**
 * Line catalogue for Taiyuan Metro.
 *
 * Taiyuan operates two lines today (1号线 opened 2025-02-22, 2号线 opened
 * 2020-12-26). The official site exposes them through
 * `GET https://www.tymetro.ltd/api/lines`, keyed by a numeric `id`
 * (1 → 2号线, 2 → 1号线) — the mapping below is stable and asserted at runtime.
 */

/** Line ids published by `www.tymetro.ltd/api/lines`. */
export const TAIYUAN_LINES = [
  {
    /** `id` in the official `/api/lines` payload. */
    apiId: 2,
    name: '1号线',
    short: '1',
    slug: '1',
    /** Name as published in the AMap subway dataset. */
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    /**
     * Official line colour as rendered by the operator's own line map
     * (the official site embeds the AMap metro map, `subway("metro-map",
     * {adcode: 1401})`). OSM carries a slightly different blue/red pair
     * (#1B5EAB / #B31C21); the AMap pair is the one the operator publishes.
     */
    color: '#0065B3',
    /** Length and station count as published by the operator. */
    lengthKm: 28.737,
    stationCount: 24,
    opened: '2025-02-22'
  },
  {
    apiId: 1,
    name: '2号线',
    short: '2',
    slug: '2',
    amapName: '2号线',
    nameEn: 'Line 2',
    mode: 'metro',
    color: '#cc0000',
    lengthKm: 23.647,
    stationCount: 23,
    opened: '2020-12-26'
  }
] as const;

export type TaiyuanLineConfig = (typeof TAIYUAN_LINES)[number];

export const TAIYUAN_LINE_BY_API_ID = new Map<number, TaiyuanLineConfig>(
  TAIYUAN_LINES.map((l) => [l.apiId, l])
);

export const TAIYUAN_LINE_BY_NAME = new Map<string, TaiyuanLineConfig>(
  TAIYUAN_LINES.map((l) => [l.name, l])
);

/**
 * Fare policy published by the operator (太原市轨道交通票务规则, uid
 * `ticket-guide`): 里程分段计价票制 — 起步价 2 元可乘坐 5 公里；5 公里以上
 * 部分，票价每增加 1 元的晋级里程为 5、5、6、6、7 公里，不设置封顶票价。
 */
export const TAIYUAN_FARE_POLICY =
  '里程分段计价票制：起步价 2 元可乘坐 5 公里；5 公里以上部分，票价每增加 1 元的晋级里程为 5、5、6、6、7 公里，不设置封顶票价。地铁卡 9 折，学生卡/儿童票 5 折，部分人群免费；同站进出 10 分钟内免费；超时 120 分钟按线网最高单程票价补票。';

/** Cumulative distance limits (km) reachable for each whole-yuan fare. */
export const TAIYUAN_FARE_LADDER_KM = [5, 10, 15, 21, 27, 34, 41, 48, 55, 62, 69];

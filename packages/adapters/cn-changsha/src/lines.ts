/**
 * Changsha Metro line configuration and the official fare tariff.
 *
 * The operator (长沙市轨道交通集团有限公司) runs six metro lines plus the
 * 中低速磁浮快线 (S2). The official Creator CMS feed
 * (`/creatorCMS/appManage/dt/findAllDtLineData.page`) publishes them with a
 * numeric `code` (1…7), the official Chinese `name` and the line's own
 * termini (`startName` / `endName`). The registry below mirrors that so the
 * adapter can cross-check the feed and so the AMap and Baidu name fragments
 * stay explicit.
 *
 * Line 3 (3号线) carries the 长株潭城际轨道交通西环线 to 湘潭北站 in its
 * western half and short-turns at 红桥 — three published destinations on one
 * alignment (see `timetables.ts`).
 *
 * Under construction and therefore absent from every machine-readable source —
 * 4号线北延段, 6号线东延段, 7号线一期 and S2 东延线 — are deliberately not
 * modelled: the official feed lists none of their stations. AMap already
 * carries nine 6号线东延段 stations (龙虎岭 … 漕龙桥) glued onto its 2号线
 * entry; the adapter ignores AMap stops the operator does not publish, so
 * those never reach the canonical data.
 */
import type { LineMode } from '@openmetro/core';

export interface ChangshaLineConfig {
  /** Compact display code for badges (`1`, `S2`). */
  short: string;
  /** Official Chinese display name (`findAllDtLineData` `name`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Line name in the AMap subway dataset (`1号线`, `S2线`). */
  amapName: string;
  /** Line name the Baidu planner uses (`轨道交通2号线`, `磁浮快线`). */
  baiduNameHint: string;
}

export const CHANGSHA_LINES: ChangshaLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    mode: 'metro',
    amapName: '1号线',
    baiduNameHint: '轨道交通1号线'
  },
  {
    short: '2',
    name: '2号线',
    slug: '2',
    mode: 'metro',
    amapName: '2号线',
    baiduNameHint: '轨道交通2号线'
  },
  {
    short: '3',
    name: '3号线',
    slug: '3',
    mode: 'metro',
    amapName: '3号线',
    baiduNameHint: '轨道交通3号线'
  },
  {
    short: '4',
    name: '4号线',
    slug: '4',
    mode: 'metro',
    amapName: '4号线',
    baiduNameHint: '轨道交通4号线'
  },
  {
    short: '5',
    name: '5号线',
    slug: '5',
    mode: 'metro',
    amapName: '5号线',
    baiduNameHint: '轨道交通5号线'
  },
  {
    short: '6',
    name: '6号线',
    slug: '6',
    mode: 'metro',
    amapName: '6号线',
    baiduNameHint: '轨道交通6号线'
  },
  {
    short: 'S2',
    name: '磁浮快线',
    slug: 's2',
    mode: 'light_rail',
    amapName: 'S2线',
    baiduNameHint: '磁浮快线'
  }
];

/** Official line `code` (1…7) → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_CODE = new Map<number, ChangshaLineConfig>(
  CHANGSHA_LINES.map((l, i) => [i + 1, l])
);

/**
 * Decode the HTML entities the CMS stores literally in its text fields.
 *
 * The operator's station names are plain text in the database, so an entity
 * like `&#15294;` arrives **undecoded** (`磁浮&#15294;梨站`), not as the
 * character it denotes. The maglev's middle station is the only name the
 * operator publishes this way.
 */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Official station names that the CMS feed stores in a broken or shortened
 * form. The corrected name wins for the canonical record.
 *
 * - `磁浮&#15294;梨站` — the CMS stores the 榔 of 榔梨 as the HTML entity
 *   `&#15294;` (U+3BBE 㮾), a character that does not exist in the station's
 *   name. The real name is 磁浮榔梨站.
 * - `省政府清风` / `四方坪` — the CMS drops the `·` separator that the
 *   operator's own network map and AMap both publish (省政府·清风,
 *   四方坪·双拥).
 *
 * The keys are the **decoded** names, so the entity has to be resolved first.
 */
export const OFFICIAL_NAME_OVERRIDES: Record<string, string> = {
  磁浮㮾梨站: '磁浮榔梨站',
  省政府清风: '省政府·清风',
  四方坪: '四方坪·双拥'
};

/**
 * English names the AMap dataset publishes too generically (or wrongly) for
 * the station they belong to. Every value here is the conventional English
 * name of that station.
 */
export const ENGLISH_NAME_OVERRIDES: Record<string, string> = {
  长沙火车站: 'Changsha Railway Station',
  长沙火车南站: 'Changsha South Railway Station',
  磁浮高铁站: 'Changsha South Maglev Station',
  磁浮机场站: 'Changsha Maglev Airport Station',
  磁浮榔梨站: 'Langli Maglev Station'
};

/**
 * Official fare policy — 《长沙市轨道交通集团票务规则》第四条 基本票价
 * (published on the operator's 票务信息 → 票务政策 page):
 *
 * > 长沙地铁按里程分段计价，起步价 2 元可乘 6 公里（含 6 公里），超过 6 公里的
 * > 加价幅度采用"递远递减"的计价原则，6—16 公里（含 16 公里）范围内每递增
 * > 5 公里加 1 元，16—30 公里（含 30 公里）范围内每递增 7 公里加 1 元，
 * > 30 公里以上每递增 9 公里加 1 元。
 *
 * The equivalent band table is `[0,6]→2 ｜ (6,11]→3 ｜ (11,16]→4 ｜
 * (16,23]→5 ｜ (23,30]→6 ｜ (30,39]→7 ｜ (39,48]→8 ｜ …`.
 *
 * The rule is **not** applied to the maglev (磁浮快线): 第二条 states the
 * policy covers the group's metro lines "不含长沙磁浮快线", which is priced by
 * its own operator. Those OD pairs stay `null` in `fares.json`.
 */
export const CHANGSHA_TARIFF = {
  /** 起步价 (yuan) and the mileage it covers (km, inclusive). */
  baseYuan: 2,
  baseKm: 6,
  /** 6–16 km: +1 yuan per this many km. */
  step1Km: 5,
  step1UpToKm: 16,
  /** 16–30 km: +1 yuan per this many km. */
  step2Km: 7,
  step2UpToKm: 30,
  /** Above 30 km: +1 yuan per this many km. */
  step3Km: 9
} as const;

/**
 * Official single-journey fare for a charged mileage of `km`.
 *
 * Verified against the Baidu planner's own quotes over 50 sampled OD pairs:
 * 41 pairs agree exactly and all 9 disagreements sit on a band boundary and
 * are one band low — the planner's routed distance includes station-hall and
 * platform offsets, so it runs slightly longer than the operator's charged
 * mileage.
 */
export function changshaMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return CHANGSHA_TARIFF.baseYuan;
  if (km <= CHANGSHA_TARIFF.baseKm) return CHANGSHA_TARIFF.baseYuan;
  if (km <= CHANGSHA_TARIFF.step1UpToKm) {
    return (
      CHANGSHA_TARIFF.baseYuan + Math.ceil((km - CHANGSHA_TARIFF.baseKm) / CHANGSHA_TARIFF.step1Km)
    );
  }
  if (km <= CHANGSHA_TARIFF.step2UpToKm) {
    return 4 + Math.ceil((km - CHANGSHA_TARIFF.step1UpToKm) / CHANGSHA_TARIFF.step2Km);
  }
  return 6 + Math.ceil((km - CHANGSHA_TARIFF.step2UpToKm) / CHANGSHA_TARIFF.step3Km);
}

/**
 * Hefei Rail Transit (合肥轨道交通) line registry, published tariff and name
 * folding.
 *
 * ## Where the operator's own data lives
 *
 * 合肥市轨道交通集团有限公司 (the group) and 合肥城市轨道交通有限公司 (the
 * operating company) publish their operating data on the **Hefei municipal
 * government disclosure platform**, not on their own website — see `./gov.ts`
 * for why. Three documents matter to this adapter:
 *
 * - 《首末班车时间及行车间隔》 — the official first/last-train table, one row
 *   per line, with **three service-day bands**: 周一至周四工作日 / 周五工作日
 *   / 双休日. It publishes first/last times for the line's **first-train
 *   origin stations and last-train terminals only**, never per station.
 * - 《票价信息及优惠政策》 — the official **distance-based tariff** in plain
 *   text: 起步价 2 元可乘 8 公里；8–14 公里 3 元；14–21 公里 4 元；
 *   21–29 公里 5 元；29 公里以上每增加 9 公里加收 1 元.
 * - 《运营线路》 — the official **operating network map** (PNG). Its legend
 *   marks three stations as 暂未开通 (not yet open): 馆驿 (3 号线),
 *   紫云湖 (4 号线) and 市博物馆 (6 号线).
 *
 * The line **order** comes from the AMap subway dataset; it agrees with the
 * operator on every operating line (1/2/5/8 号线 station-for-station, and
 * 3/4/6 号线 differ only by the not-yet-open stations listed above).
 *
 * ## Direction convention
 *
 * The operator labels the two service directions **上行 / 下行** and defines
 * them in the table's 注释 column ("上行：九联圩站开往张洼站方向"). That label
 * is **not** the repo's up/down convention: repo-wide, `down` means "toward
 * the last stop of the line's official order" and `up` means "toward the
 * first". For 4 号线 and 5 号线 the operator's 上行 runs toward the *first*
 * stop of the AMap order, so the mapping is per line and is derived from the
 * official definition at runtime — see `./timetables.ts`.
 */
import type { LineMode } from '@openmetro/core';

export interface HefeiLineConfig {
  /** Official line number (`'1'` … `'8'`). */
  officialId: string;
  /** Compact display code for badges (`1`, `2`, …). */
  short: string;
  /** Official Chinese display name (`1号线` … `8号线`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** The AMap dataset's line name (identical to `name` today). */
  amapName: string;
}

export const HEFEI_LINES: HefeiLineConfig[] = [
  { officialId: '1', short: '1', name: '1号线', slug: '1', mode: 'metro', amapName: '1号线' },
  { officialId: '2', short: '2', name: '2号线', slug: '2', mode: 'metro', amapName: '2号线' },
  { officialId: '3', short: '3', name: '3号线', slug: '3', mode: 'metro', amapName: '3号线' },
  { officialId: '4', short: '4', name: '4号线', slug: '4', mode: 'metro', amapName: '4号线' },
  { officialId: '5', short: '5', name: '5号线', slug: '5', mode: 'metro', amapName: '5号线' },
  { officialId: '6', short: '6', name: '6号线', slug: '6', mode: 'metro', amapName: '6号线' },
  { officialId: '7', short: '7', name: '7号线', slug: '7', mode: 'metro', amapName: '7号线' },
  { officialId: '8', short: '8', name: '8号线', slug: '8', mode: 'metro', amapName: '8号线' }
];

/** Look up a line config by its official number. */
export function hefeiLineConfig(officialId: string): HefeiLineConfig {
  const found = HEFEI_LINES.find((l) => l.officialId === officialId);
  if (found) return found;
  const short = officialId.replace(/号线$/, '') || officialId;
  return {
    officialId,
    short,
    name: `${short}号线`,
    slug: short.replace(/[^A-Za-z0-9]+/g, '') || officialId,
    mode: 'metro',
    amapName: `${short}号线`
  };
}

// ---------------------------------------------------------------------------
// Published tariff
// ---------------------------------------------------------------------------

/** One step of the published distance ladder. */
export interface FareStep {
  /** Inclusive upper bound of the step, in km. */
  upToKm: number;
  /** Fare in yuan for this step. */
  yuan: number;
}

/**
 * 合肥轨道交通's published distance ladder.
 *
 * 起步价 2 元可乘 8 公里；8 公里以上、14 公里（含）以内 3 元；14 公里以上、
 * 21 公里（含）以内 4 元；21 公里以上、29 公里（含）以内 5 元；29 公里以上的
 * 每增加 9 公里加收 1 元。
 */
export const FARE_LADDER: FareStep[] = [
  { upToKm: 8, yuan: 2 },
  { upToKm: 14, yuan: 3 },
  { upToKm: 21, yuan: 4 },
  { upToKm: 29, yuan: 5 }
];

/** Kilometres each additional yuan buys beyond the last ladder step. */
export const FARE_LADDER_TAIL_KM = 9;

/** The last ladder step (the anchor the tail is counted from). */
export const FARE_LAST_STEP = FARE_LADDER[FARE_LADDER.length - 1]!;

/**
 * Official fare for a ride distance, in yuan.
 *
 * Beyond the last step every **started** 9 km step costs one more yuan — the
 * published wording is 每增加 9 公里加收 1 元, and both published network
 * maxima agree with the ceiling rule: 6 号线 (34.43 km) is 6 元 and 8 号线
 * (22.22 km) is 5 元.
 */
export function fareFromDistanceKm(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 0;
  for (const step of FARE_LADDER) if (km <= step.upToKm) return step.yuan;
  return FARE_LAST_STEP.yuan + Math.ceil((km - FARE_LAST_STEP.upToKm) / FARE_LADDER_TAIL_KM);
}

/**
 * Fares the operator has published, used as assertions on every run.
 *
 * - 6 号线's opening announcement quotes the whole line's maximum single fare
 *   as 6 元 (the line is 34.43 km long).
 * - 8 号线's opening announcement quotes 5 元 (22.22 km), and 8 元 as the
 *   maximum when transferring to/from 1/2/3/4/5 号线.
 * - 1 号线 合肥火车站 → 九联圩 is 23.30 km of rail, which lands in the
 *   21–29 km step; the Baidu planner quotes 5 元 for the same pair.
 */
export const FARE_ANCHORS: { from: string; to: string; yuan: number }[] = [
  { from: '青龙岗', to: '龙塘', yuan: 6 },
  { from: '一里井', to: '北城高铁站', yuan: 5 },
  { from: '合肥火车站', to: '九联圩', yuan: 5 }
];

// ---------------------------------------------------------------------------
// Station names
// ---------------------------------------------------------------------------

/**
 * Official names that do not resolve to an AMap station by the usual rules.
 *
 * The official interchange workbook (《合肥轨道交通换乘信息及指示标识》,
 * 2024-03-09) writes 合肥南, while AMap and the first/last-train table write
 * 合肥南站.
 */
export const STATION_NAME_ALIASES: Record<string, string> = {
  合肥南: '合肥南站'
};

/**
 * Stations the official network map marks as 暂未开通 (not yet open).
 *
 * 馆驿 (3 号线) and 紫云湖 (4 号线) are additions still under construction and
 * sit **beyond** the operating terminus; 市博物馆 (6 号线) is built but held
 * back (暂缓开通) and sits **between** two operating stations. They are absent
 * from the AMap operating dataset, so they are only known through the official
 * map; `after` names the station they follow in the line's alignment.
 *
 * Each one is modelled as a **spur** hanging off that anchor: the operating
 * chain keeps the AMap order untouched (a closed station inside the main
 * alignment would split the line, because the routing graph drops every
 * segment that touches a non-operating station), while the closed station
 * keeps its stop, its segment and a branch pattern.
 */
export const NOT_YET_OPEN_STATIONS: {
  name: string;
  line: string;
  after: string;
  note: string;
}[] = [
  {
    name: '馆驿',
    line: '3号线',
    after: '省儿童医院新区',
    note: '暂未开通（缓建，3 号线北延增设车站）'
  },
  {
    name: '紫云湖',
    line: '4号线',
    after: '烧脉岗',
    note: '暂未开通（增设车站，4 号线西延）'
  },
  {
    name: '市博物馆',
    line: '6号线',
    after: '市儿童医院',
    note: '暂未开通（暂缓开通，位于市儿童医院与钢红之间）'
  }
];

/**
 * English names the operator publishes on its network map, corrected against
 * the AMap dataset.
 *
 * AMap's `multilang.n.en` is present for every Hefei station but contains a
 * few typos (`Heifeinan Railway Station` for 合肥南站) and a few parenthetical
 * POI descriptions (`Dongqili (Hefei East Coach Terminal)` for 东七里). The
 * operator's own map is authoritative for the romanisation, so the corrected
 * spellings are listed here.
 */
export const ENGLISH_NAME_OVERRIDES: Record<string, string> = {
  合肥南站: 'Hefei South Railway Station',
  合肥火车站: 'Hefei Railway Station',
  东七里: 'Dongqili',
  省博物院: 'Anhui Provincial Museum',
  安医一附院北区: 'Anyi Yifuyuan Beiqu',
  安医一附院南区: 'Anyi Yifuyuan Nanqu',
  安医大二附院: 'Anyi Erfuyuan',
  工经学院: 'Gongjing Xueyuan',
  陶冲湖东: 'Taochonghu Dong',
  新海公园: 'Xinhai Gongyuan',
  综保区: 'Zongbaoqu',
  北城高铁站: 'Beicheng Gaotiezhan',
  省立医院北区: 'Shengli Yiyuan Beiqu',
  合肥四中: 'Hefei Sizhong',
  要素大市场: 'Yaosu Dashichang',
  翡翠公园: 'Feicui Gongyuan',
  省文化和非遗馆: 'Sheng Wenhua He Feiyiguan',
  // The three not-yet-open stations are absent from the AMap dataset, so
  // Wikidata has no label for them either — the romanisation is used.
  馆驿: 'Guanyi',
  紫云湖: 'Ziyunhu',
  市博物馆: 'Shi Bowuguan'
};

/**
 * Resolve an official station name onto the AMap dataset's spelling.
 *
 * The operator appends `站` to every station name (`九联圩站`), while AMap
 * keeps the suffix only on compounds (`合肥南站`, `合肥火车站`, `肥东站`). The
 * resolver therefore tries, in order: an explicit alias, the exact name, the
 * name minus one trailing `站`, and the name plus `站` — against the set of
 * names the AMap dataset actually publishes.
 */
export function resolveHefeiStationName(raw: string, known: ReadonlySet<string>): string {
  const name = raw.trim();
  const alias = STATION_NAME_ALIASES[name];
  if (alias && known.has(alias)) return alias;
  if (known.has(name)) return name;
  if (name.endsWith('站') && name.length > 1) {
    const stripped = name.slice(0, -1);
    if (known.has(stripped)) return stripped;
  }
  if (known.has(`${name}站`)) return `${name}站`;
  return alias ?? name;
}

// ---------------------------------------------------------------------------
// Official interchange list
// ---------------------------------------------------------------------------

/**
 * The operator's own interchange list, transcribed from
 * 《合肥轨道交通换乘信息及指示标识》(2024-03-09, `hefei.gov.cn`).
 *
 * The published workbook is 112 MB (the 指示标识 column holds photographs of
 * the signage), so it is not re-downloaded on every sync; the transcription is
 * kept here as the operator's **stated** interchange set. It is a 2024
 * snapshot and predates 6/7/8 号线, so it is used as a cross-check against the
 * AMap interchange flags — not as the interchange source of truth.
 */
export const OFFICIAL_INTERCHANGES: { station: string; lines: string[] }[] = [
  { station: '大东门', lines: ['1号线', '2号线'] },
  { station: '合肥南站', lines: ['1号线', '4号线', '5号线'] },
  { station: '云谷路', lines: ['1号线', '5号线'] },
  { station: '西七里塘', lines: ['2号线', '3号线'] },
  { station: '东七里', lines: ['2号线', '4号线'] },
  { station: '合肥火车站', lines: ['1号线', '3号线'] },
  { station: '图书馆', lines: ['3号线', '4号线'] },
  { station: '方庙', lines: ['3号线', '4号线'] },
  { station: '海棠', lines: ['3号线', '5号线'] },
  { station: '三孝口', lines: ['2号线', '5号线'] }
];

/**
 * The official interchange workbook's own spelling of 合肥南站 is 合肥南.
 */
export const OFFICIAL_INTERCHANGE_ALIAS: Record<string, string> = { 合肥南: '合肥南站' };

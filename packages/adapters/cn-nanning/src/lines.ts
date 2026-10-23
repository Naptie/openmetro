/**
 * Nanning Rail Transit (南宁轨道交通) line registry and published tariff.
 *
 * The operator (南宁轨道交通集团有限责任公司, www.nngdjt.com) runs five metro
 * lines. Its website is a server-rendered CMS: the 地铁服务 page carries the
 * whole network as HTML — the line order, the per-station detail blocks and
 * the first/last-train sheets — so the registry below only adds the facts the
 * page does not carry: the canonical id slug and the planner's vehicle-name
 * fragment.
 *
 * Line facts (from the operator's 地铁服务 page):
 * - 1 号线 — 火车东站 ↔ 石埠, 25 stations, green (`6CB46B`).
 * - 2 号线 — 西津 ↔ 坛泽, 23 stations, red (`CC0000`).
 * - 3 号线 — 科园大道 ↔ 平良立交, 23 stations, purple (`96499A`).
 * - 4 号线 — 洪运路 ↔ 龙岗, 19 stations, yellow (`FCD600`).
 * - 5 号线 — 国凯大道 ↔ 金桥客运站, 17 stations, blue (`027CFF`).
 * - Interchanges (11): 金湖广场 (1/3), 朝阳广场 (1/2), 火车站 (1/2),
 *   广西大学 (1/5), 安吉客运站 (2/3), 明秀路 (2/5), 大沙田 (2/4),
 *   平良立交 (2/3), 小鸡村 (3/5), 总部基地 (3/4), 那洪立交 (4/5).
 *
 * Every line is a single chain with no branch, so each one owns exactly one
 * primary pattern.
 *
 * ## Station names
 *
 * The operator's page spells the stations exactly like the AMap subway dataset
 * (`佛子岭`, `金湖广场`, `火车东站`, …) — no `站` suffix is appended, so the two
 * feeds match one-to-one without a fold. The planner is the odd one out: it
 * names every stop with the `站` suffix plus the boarding exit
 * (`会展中心站(C口)`), which `foldPlannerStopName` strips.
 *
 * ## The published tariff
 *
 * The operator's 票务须知 sheet states the mileage ladder verbatim:
 *
 * > 南宁地铁线网票价按里程分段计价：起步价2元可乘6公里，超过起步里程6公里后采取
 * > "递远递减、里程分段累进计价"的原则：6-12公里（含12公里）范围内加收1元；
 * > 12-18公里（含18公里）范围内加收1元；18-26公里（含26公里）范围内加收1元；
 * > 26-34公里（含34公里）范围内加收1元；34公里以上每10公里为一个里程计价段加收1元。
 */
import type { LineMode } from '@openmetro/core';

export interface NanningLineConfig {
  /** Line number as the operator and the planner use it (`'1'` … `'5'`). */
  officialId: string;
  /** Compact display code for badges (`1`, `2`, …). */
  short: string;
  /** Official Chinese display name (`轨道交通1号线` …). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Planner vehicle name for this line (`轨道交通1号线`). */
  baiduNameHint: string;
}

export const NANNING_LINES: NanningLineConfig[] = [
  {
    officialId: '1',
    short: '1',
    name: '轨道交通1号线',
    slug: '1',
    mode: 'metro',
    baiduNameHint: '轨道交通1号线'
  },
  {
    officialId: '2',
    short: '2',
    name: '轨道交通2号线',
    slug: '2',
    mode: 'metro',
    baiduNameHint: '轨道交通2号线'
  },
  {
    officialId: '3',
    short: '3',
    name: '轨道交通3号线',
    slug: '3',
    mode: 'metro',
    baiduNameHint: '轨道交通3号线'
  },
  {
    officialId: '4',
    short: '4',
    name: '轨道交通4号线',
    slug: '4',
    mode: 'metro',
    baiduNameHint: '轨道交通4号线'
  },
  {
    officialId: '5',
    short: '5',
    name: '轨道交通5号线',
    slug: '5',
    mode: 'metro',
    baiduNameHint: '轨道交通5号线'
  }
];

/** Official line id → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_ID = new Map<string, NanningLineConfig>(
  NANNING_LINES.map((l) => [l.officialId, l])
);

/**
 * Stations the operator lists but does not yet operate.
 *
 * The Line 4 sheet carries **五象火车站** with `/` in all six time columns and
 * the network map omits it, so it is announced but not in passenger service.
 * It is modelled the way the repo models announced extensions — a spur
 * pattern hanging off the station it follows — so the operating chain is never
 * split by a closed station.
 */
export interface NanningPlannedStation {
  name: string;
  /** Line the station belongs to (operator line number). */
  line: string;
  /** The operating station the planned one follows in the official order. */
  after: string;
  note: string;
}

export const PLANNED_STATIONS: NanningPlannedStation[] = [
  {
    name: '五象火车站',
    line: '4',
    after: '楞塘村',
    note: '官网 4 号线首末班车时刻表中该站六个时间列均为「/」，运营线网图亦未收录，属已官宣未通车。'
  }
];

/**
 * Hand-maintained English names for the stations AMap does not carry.
 *
 * AMap has no entry for 五象火车站 (the station is not in service), so the
 * adapter supplies the label in the same style AMap uses for the other
 * railway stations (火车东站 → "Nanning East Railway Station").
 */
export const ENGLISH_NAME_OVERRIDES: Record<string, string> = {
  五象火车站: 'Wuxiang Railway Station'
};

/**
 * Fold a planner stop name to the operator's spelling.
 *
 * The planner appends the `站` suffix and the boarding exit
 * (`会展中心站(C口)` → `会展中心`); the operator's page uses the bare name.
 */
export function foldPlannerStopName(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** Does a planner stop name refer to the same physical station as `name`? */
export function plannerStopMatches(plannerName: string | undefined | null, name: string): boolean {
  const a = foldPlannerStopName(plannerName);
  const b = name.replace(/\s+/g, '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.replace(/站$/, '') === b.replace(/站$/, '');
}

/**
 * Official mileage tariff (南宁轨道交通票务须知).
 *
 * Cumulative charged mileage (km) at each price point.
 */
export const NANNING_TARIFF = {
  /** Cumulative charged mileage (km) at each price point. */
  cumulativeKm: [6, 12, 18, 26, 34],
  /** Price (yuan) for each cumulative mileage entry above. */
  yuan: [2, 3, 4, 5, 6],
  /** Above 34 km the fare grows by 1 yuan per additional 10 km. */
  beyondKm: 34,
  beyondStepKm: 10,
  beyondStepYuan: 1
} as const;

/** Official fare for a charged mileage of `km`. */
export function nanningMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return NANNING_TARIFF.yuan[0];
  for (let i = 0; i < NANNING_TARIFF.cumulativeKm.length; i++) {
    if (km <= NANNING_TARIFF.cumulativeKm[i]! + 1e-9) return NANNING_TARIFF.yuan[i]!;
  }
  const over = km - NANNING_TARIFF.beyondKm;
  return (
    NANNING_TARIFF.yuan[NANNING_TARIFF.yuan.length - 1]! +
    Math.ceil(over / NANNING_TARIFF.beyondStepKm) * NANNING_TARIFF.beyondStepYuan
  );
}

/**
 * The highest fare the published tariff can produce for a ride of `km`.
 *
 * The planner quotes the operator's own price, which is computed from the
 * operator's ride distance — which is a little shorter than the polyline
 * distance the planner reports. A quote therefore sits at most one ladder step
 * **below** the ladder applied to that polyline distance, and a quote far above
 * it is a routing artefact (a mixed bus route) rather than a fare. This bound
 * is used to reject such quotes.
 */
export function nanningFareUpperBound(km: number): number {
  const ladder = nanningMileageFare(km);
  return ladder + 1;
}

/**
 * Wuxi Metro line configuration, the official mileage tariff and the
 * not-yet-open stations the operator's own network map publishes.
 *
 * ## The operator's site
 *
 * `www.wxmetro.net` (无锡地铁集团有限公司) is a corporate CMS. Its whole
 * public API is seven `/api/metrows/*` endpoints (all DES-encrypted), and
 * **none of them carries transit data** — they only serve the article and
 * image payloads of the CMS columns. The passenger-facing section
 * (乘车服务) is three columns, all of them image- or text-only:
 *
 * - 线路导览 (column 68) — the network map, one JPEG
 * - 列车时刻表 (column 70) — five timetable sheets, images
 * - 票务服务 (column 71) — the 《无锡地铁票务规则》 prose
 *
 * Everything machine-readable therefore comes from the two public planners
 * (AMap's subway dataset and the Baidu transit planner), and the official site
 * contributes the authoritative **text** (the tariff, the planned-line station
 * names) plus the **network map** (the official English names and the
 * not-yet-open stations).
 *
 * ## The operating network
 *
 * Five lines are in passenger service: 1–4 号线 and the S1 市域线. The line
 * order below is the AMap subway dataset's, which was checked cell by cell
 * against the operator's own timetable sheets (2/3/4 号线 match the published
 * station lists exactly, and 惠山古镇 — a station people expect on 3 号线 —
 * is served by 4 号线 alone).
 *
 * ## The 1 ↔ S1 through-run
 *
 * Line 1 and the S1 line are through-connected at 堰桥: a train that runs
 * 南方泉 → 堰桥 continues onto the S1 line towards 江阴外滩 and back. The repo
 * models a through-run as a **zero-second transfer edge** at the shared
 * station (`cn-kunming` does the same for its 1/2 through-run at 环城南路), so
 * `THROUGH_RUN_LINE_PAIRS` drives that edge.
 */
import type { LineMode } from '@openmetro/core';

/** The operator's own site. */
export const WX_SITE = 'https://www.wxmetro.net';

/**
 * The official network map (线路导览, column 68).
 *
 * The single most valuable artifact the operator publishes: it carries the
 * complete station list of every line **with the official English names**,
 * the line-colour legend, the interchange markers and the not-yet-open
 * stations. The map is explicitly distorted ("本图经过变形处理…不作为测量依据"),
 * so it is used for names and status only, never for coordinates.
 */
export const WX_NETWORK_MAP =
  'https://www.wxmetro.net/file/metrowebsite/2025-06/5b0ddcd9-7f96-49bf-9863-6c5a6996aa38.jpg';

/** CMS column ids of the three passenger-service columns. */
export const WX_COLUMN_ROUTE_MAP = 68;
export const WX_COLUMN_TIMETABLES = 70;
export const WX_COLUMN_TICKETING = 71;

/**
 * 《关于无锡地铁4号线二期、5号线和6号线站点标准名称的通告》(2026-03-02).
 *
 * The operator publishes the **standard station names** of the three planned
 * lines. The list is authoritative but carries no geometry, no colour and no
 * timetable, and the lines are entirely new alignments — so, like the other
 * adapters that face the same situation (`cn-xuzhou`), they are documented in
 * the network notes rather than modelled as lines. Modelling them would mean
 * hand-maintaining a topology that no machine-readable source describes.
 */
export const WX_PLANNED_LINES_NOTICE_ID = 3967;

/** Provenance id of the operator's network map. */
export const WX_NETWORK_MAP_SOURCE = 'wxmetro-network-map';
/** Provenance id of the operator's ticket rules (票务服务 column). */
export const WX_TICKETING_SOURCE = 'wxmetro-ticketing-rules';
/** Provenance id of the AMap subway dataset. */
export const AMAP_SOURCE = 'amap-subway-3202';
/** Provenance id of the Baidu planner harvest. */
export const BAIDU_TIMETABLE_SOURCE = 'baidu-transit';

/**
 * English names the operator prints itself.
 *
 * The official network map prints an English name under every station it
 * draws. For 安镇 — the station no other source carries — that map is the
 * **only** source of an English name: it reads `安镇 / Anzhen`.
 *
 * The override matters because the generic Wikidata fallback romanises the
 * hanja of a same-named place elsewhere ("Gynheung An", the Korean reading of
 * 安镇) — a name that belongs to a different location entirely.
 */
export const ENGLISH_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([['安镇', 'Anzhen']]);

export interface WuxiLineConfig {
  /** Compact display code for badges (`1`, `S1`). */
  short: string;
  /** Official Chinese display name (`1号线`, `S1线`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /**
   * The official line colour from the operator's map legend, without a `#`.
   * AMap publishes the same values; this is the fallback.
   */
  color: string;
  /**
   * The Baidu planner's vehicle-name fragment (`地铁1号线`, `地铁S1号线`).
   * The S1 line is signed `地铁S1号线(锡澄线)` by the planner, so the S-number
   * has to be matched explicitly — a plain `(\d+)号线` extraction would read
   * the S1 line as line 1.
   */
  baiduNameHint: string;
}

export const WUXI_LINES: WuxiLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    slug: '1',
    mode: 'metro',
    color: 'EE3F42',
    baiduNameHint: '地铁1号线'
  },
  {
    short: '2',
    name: '2号线',
    slug: '2',
    mode: 'metro',
    color: '00AB4F',
    baiduNameHint: '地铁2号线'
  },
  {
    short: '3',
    name: '3号线',
    slug: '3',
    mode: 'metro',
    color: '01A2E2',
    baiduNameHint: '地铁3号线'
  },
  {
    short: '4',
    name: '4号线',
    slug: '4',
    mode: 'metro',
    color: 'B93FF5',
    baiduNameHint: '地铁4号线'
  },
  {
    short: 'S1',
    name: 'S1线',
    slug: 's1',
    mode: 'suburban_rail',
    color: 'EE3F42',
    baiduNameHint: '地铁S1号线'
  }
];

/** Official line name (`1号线`) → registry entry. */
export const LINE_CONFIG_BY_NAME = new Map<string, WuxiLineConfig>(
  WUXI_LINES.map((l) => [l.name, l] as const)
);

/**
 * The one line pair that runs through: a train continues from 1 号线 onto the
 * S1 line at 堰桥 without the passenger changing trains.
 *
 * Modelled the way `cn-kunming` models its 1/2 through-run and `cn-jinan`
 * models its 4/8 through-run: a **zero-second transfer edge** at the shared
 * station, in both directions.
 */
export const THROUGH_RUN_LINE_PAIRS: readonly [string, string][] = [['1', 'S1']];

/**
 * A station the operator's network map publishes but that is **not** in
 * passenger service.
 *
 * The map draws 2 号线's eastern terminus 安镇 with the marker 暂缓开通
 * ("opening deferred"): the over-station development above it stalled, so the
 * station is on the line's alignment but carries no trains. AMap's subway
 * dataset omits it entirely.
 *
 * It is modelled the way the repo models every other not-yet-open station
 * (`cn-hefei`, `cn-ningbo`, `cn-suzhou`): the stop and its segment exist, the
 * station is `under_construction`, and it sits on its own **spur pattern**
 * hanging off the station it follows — so the operating chain is never split
 * and the routing graph drops it.
 */
export interface NotYetOpenStation {
  /** Official Chinese name as the map prints it. */
  name: string;
  /** The line the map draws it on. */
  line: string;
  /** The operating station it follows on the map. */
  after: string;
  /** The operator's own note. */
  note: string;
}

export const NOT_YET_OPEN_STATIONS: readonly NotYetOpenStation[] = [
  {
    name: '安镇',
    line: '2号线',
    after: '无锡东站',
    note: '官网线路导览图标为「暂缓开通」：站体上盖综合体停工，尚未进入运营，AMap 地铁数据集亦未收录。'
  }
];

/**
 * The official mileage tariff.
 *
 * 《无锡地铁票务规则》第二条 基本票价 (effective 2026-01-01, published in the
 * 票务服务 column of the operator's site):
 *
 * > 无锡地铁线网票价按里程分段计价：起步5公里以内2元；超过5公里至15公里，每5公里
 * > 加收1元（不足5公里按5公里计价）；超过15公里至29公里，每7公里加收1元（不足7
 * > 公里按7公里计价）；超过29公里，每9公里加收1元（不足9公里按9公里计价）。
 *
 * The rule applies to **every operating line including S1** ("本规则适用于含S1
 * 线在内的无锡市城市轨道交通运营线路"), so unlike `cn-changsha` (whose maglev
 * is excluded) no OD pair has to stay `null` because of a line exclusion.
 */
export const WUXI_TARIFF = {
  /** Base fare for the 0–5 km band. */
  baseYuan: 2,
  /** Upper edge of the base band (km). */
  baseKm: 5,
  /** Second band: up to this many km, +1 yuan per 5 km. */
  secondKm: 15,
  /** Step of the second band (km). */
  secondStepKm: 5,
  /** Third band: up to this many km, +1 yuan per 7 km. */
  thirdKm: 29,
  /** Step of the third band (km). */
  thirdStepKm: 7,
  /** Fourth band: +1 yuan per 9 km beyond the third band. */
  fourthStepKm: 9
} as const;

/**
 * Official single-journey fare for a charged mileage of `km`.
 *
 * The operator prices the **shortest rail path**, so the caller supplies the
 * riding distance of the cheapest route, not the straight line.
 */
export function wuxiMileageFare(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return WUXI_TARIFF.baseYuan;
  if (km <= WUXI_TARIFF.baseKm) return WUXI_TARIFF.baseYuan;
  if (km <= WUXI_TARIFF.secondKm) {
    return WUXI_TARIFF.baseYuan + Math.ceil((km - WUXI_TARIFF.baseKm) / WUXI_TARIFF.secondStepKm);
  }
  if (km <= WUXI_TARIFF.thirdKm) {
    return (
      WUXI_TARIFF.baseYuan + 2 + Math.ceil((km - WUXI_TARIFF.secondKm) / WUXI_TARIFF.thirdStepKm)
    );
  }
  return (
    WUXI_TARIFF.baseYuan + 2 + 2 + Math.ceil((km - WUXI_TARIFF.thirdKm) / WUXI_TARIFF.fourthStepKm)
  );
}

/** The tariff bands, as read out of the operator's published rules. */
export interface WuxiTariffBands {
  baseYuan: number;
  baseKm: number;
  secondKm: number;
  secondStepKm: number;
  thirdKm: number;
  thirdStepKm: number;
  fourthStepKm: number;
}

/**
 * Extract the tariff bands from the operator's published ticket rules.
 *
 * The rules page is prose, so the ladder is read out of the 基本票价 paragraph:
 *
 * > 起步5公里以内2元；超过5公里至15公里，每5公里加收1元（不足5公里按5公里计价）；
 * > 超过15公里至29公里，每7公里加收1元（不足7公里按7公里计价）；超过29公里，每9
 * > 公里加收1元（不足9公里按9公里计价）。
 *
 * The base band and every "超过 … 公里 … 每 N 公里加收 1 元" clause are
 * matched separately, so the parenthetical "不足 N 公里按 N 公里计价"
 * roundings — which the rule spells out per band — do not have to be modelled
 * and cannot break the parse.
 */
export function parseWuxiTariff(text: string): WuxiTariffBands | null {
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const base = /起步\s*(\d+)\s*公里以内\s*(\d+)\s*元/.exec(plain);
  if (!base) return null;

  // `超过 X 公里至 Y 公里，每 N 公里加收 1 元` and the open-ended
  // `超过 X 公里，每 N 公里加收 1 元` share one shape.
  const band = /超过\s*(\d+)\s*公里(?:至\s*(\d+)\s*公里)?[，,]\s*每\s*(\d+)\s*公里加收\s*1\s*元/g;
  const bands = [...plain.matchAll(band)].map((m) => ({
    lowerKm: Number(m[1]),
    upperKm: m[2] == null ? undefined : Number(m[2]),
    stepKm: Number(m[3])
  }));
  if (bands.length < 3) return null;

  const second = bands[0]!;
  const third = bands[1]!;
  const fourth = bands[2]!;
  if (second.upperKm == null || third.upperKm == null) return null;

  return {
    baseYuan: Number(base[2]),
    baseKm: Number(base[1]),
    secondKm: second.upperKm,
    secondStepKm: second.stepKm,
    thirdKm: third.upperKm,
    thirdStepKm: third.stepKm,
    fourthStepKm: fourth.stepKm
  };
}

/**
 * Does the published tariff still match the compiled ladder?
 *
 * A tariff change would silently invalidate every computed fare, so the
 * published rules are re-read on every sync and compared against the ladder
 * this module applies. A mismatch is reported rather than silently accepted.
 */
export function tariffMatchesLadder(bands: WuxiTariffBands): boolean {
  return (
    bands.baseYuan === WUXI_TARIFF.baseYuan &&
    bands.baseKm === WUXI_TARIFF.baseKm &&
    bands.secondKm === WUXI_TARIFF.secondKm &&
    bands.secondStepKm === WUXI_TARIFF.secondStepKm &&
    bands.thirdKm === WUXI_TARIFF.thirdKm &&
    bands.thirdStepKm === WUXI_TARIFF.thirdStepKm &&
    bands.fourthStepKm === WUXI_TARIFF.fourthStepKm
  );
}

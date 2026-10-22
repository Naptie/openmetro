/**
 * Dalian Metro line configuration.
 *
 * The operator (大连交通集团 / 大连地铁运营有限公司) runs **six** metro lines.
 * AMap publishes **seven** subway entries because it models the 3号线 九里支线
 * as its own line; that branch is folded back into 3号线 here as a branch
 * pattern whose junction is 开发区站.
 *
 * All city-specific facts live in this file.
 */
import type { LineMode } from '@openmetro/core';

export interface DalianBranchConfig {
  /** Stable slug used in the branch pattern id. */
  key: string;
  /** AMap subway dataset line name (`ln`) carrying this branch's stops. */
  amapName: string;
  /** Station name where the branch diverges from the primary alignment. */
  junction: string;
  /**
   * Baidu planner vehicle name for this branch. Branches run under their own
   * service name (地铁3号线支线, not 地铁3号线), and the in-vehicle distance
   * harvest matches on it — without this every branch segment silently falls
   * back to a straight-line estimate.
   */
  baiduName: string;
  /** Operator service description (recorded in `extras` / `network.notes`). */
  note: string;
}

export interface DalianLineConfig {
  /** Compact display code for badges (`1` … `13`). */
  short: string;
  /** Official Chinese display name. */
  name: string;
  /** AMap subway dataset line name (`ln`) for the primary alignment. */
  amapName: string;
  /** Official English name from the network-map legend. */
  nameEn: string;
  mode: LineMode;
  /** Baidu planner vehicle name for this line. */
  baiduName: string;
  /** Prior / engineering names kept as aliases. */
  aliases?: string[];
  /** Branch alignments served by this line. */
  branches?: DalianBranchConfig[];
  /** Service detail recorded in `network.notes`. */
  note?: string;
}

export const DALIAN_LINES: DalianLineConfig[] = [
  {
    short: '1',
    name: '1号线',
    amapName: '1号线',
    nameEn: 'Line 1',
    mode: 'metro',
    baiduName: '地铁1号线',
    note: '姚家—河口，6B 编组，设桧柏路车辆段与蔡大岭停车场。'
  },
  {
    short: '2',
    name: '2号线',
    amapName: '2号线',
    nameEn: 'Line 2',
    mode: 'metro',
    baiduName: '地铁2号线',
    note: '大连北站—海之韵，6B 编组，设虹锦路车辆段（与1号线共用控制中心）。'
  },
  {
    short: '3',
    name: '3号线',
    amapName: '3号线',
    nameEn: 'Line 3',
    mode: 'metro',
    baiduName: '地铁3号线',
    aliases: ['快轨3号线'],
    note: '主线 大连站—金石滩（4B 编组，点式 ATP）。保税区小交路 大连站⇌保税区 与主线并存；九里支线（快轨九里支线，2B 编组）自开发区站分岔，2021-12-28 起与13号线一期贯通运营至普兰店振兴街。',
    branches: [
      {
        key: 'jiuli',
        amapName: '地铁3号线支线',
        junction: '开发区',
        baiduName: '地铁3号线支线',
        note: '九里支线（快轨九里支线），自开发区站分岔；与13号线一期贯通运营，乘客可在开发区站换乘主线。'
      }
    ]
  },
  {
    short: '5',
    name: '5号线',
    amapName: '5号线',
    nameEn: 'Line 5',
    mode: 'metro',
    baiduName: '地铁5号线',
    note: '后关—虎滩新区，6B 编组，中国东北地区首条跨海地铁线路。'
  },
  {
    short: '12',
    name: '12号线',
    amapName: '12号线',
    nameEn: 'Line 12',
    mode: 'metro',
    baiduName: '地铁12号线',
    aliases: ['202路轨道延伸线'],
    note: '河口—旅顺新港，4B 编组，由原 202 路电车延伸线改建，设铁山车辆段。'
  },
  {
    short: '13',
    name: '13号线',
    amapName: '13号线',
    nameEn: 'Line 13',
    mode: 'suburban_rail',
    baiduName: '地铁13号线',
    aliases: ['金普城际铁路'],
    note: '工程名金普城际铁路，市域快轨制式，4B 编组，最高运行速度 120km/h。采用大小交路：大交路 普兰店振兴街↔开发区（间隔 30 分钟），小交路 九里↔开发区；与3号线九里支线贯通运营。'
  }
];

/** Canonical line id for a short code. */
export function dalianLineId(short: string): string {
  return `cn-dalian-line-${short}`;
}

/** Branch pattern id (a line may own several). */
export function dalianBranchPatternId(short: string, branchKey: string): string {
  return `cn-dalian-pattern-${short}-${branchKey}`;
}

/** Primary pattern id for a line. */
export function dalianPrimaryPatternId(short: string): string {
  return `cn-dalian-pattern-${short}-primary`;
}

/**
 * Pattern id → Baidu planner vehicle name.
 *
 * The distance harvest has to resolve a segment to an *alignment*, not just a
 * line: the 3号线 九里支线 shares `line_id` with the mainline but the planner
 * reports its legs under 地铁3号线支线.
 */
export function dalianPatternBaiduNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of DALIAN_LINES) {
    out.set(dalianPrimaryPatternId(l.short), l.baiduName);
    for (const b of l.branches ?? []) {
      out.set(dalianBranchPatternId(l.short, b.key), b.baiduName);
    }
  }
  return out;
}

/** Official network name, kept next to the fare ladder for the writer. */
export const DALIAN_NETWORK_NAME = { zh: '大连地铁', en: 'Dalian Metro' };

/**
 * Official distance-ladder tariff (大连地铁, 2021-12-28 起全线网统一票制):
 * 6 公里以内（含）2 元；以 1 元为增加单位，晋级里程为 6,6,8,8,10,10,15,15… 公里。
 * 即 0–6→¥2、6–12→¥3、12–18→¥4、18–26→¥5、26–34→¥6、34–44→¥7、44–54→¥8；
 * 54 公里以上部分每增加 1 元可乘坐 15 公里。全线网单程最高 14 元。
 */
export const FARE_LADDER: readonly { upToKm: number; yuan: number }[] = [
  { upToKm: 6, yuan: 2 },
  { upToKm: 12, yuan: 3 },
  { upToKm: 18, yuan: 4 },
  { upToKm: 26, yuan: 5 },
  { upToKm: 34, yuan: 6 },
  { upToKm: 44, yuan: 7 },
  { upToKm: 54, yuan: 8 }
];

/** Above the last step, every extra yuan buys this many km. */
export const FARE_LADDER_TAIL_KM = 15;

/** Published network maximum single fare (2023-03). */
export const FARE_MAX_YUAN = 14;

/**
 * Official anchors published with the 13号线 opening announcement — used to
 * assert the computed matrix still agrees with the operator.
 */
export const FARE_ANCHORS: readonly (readonly [string, string, number])[] = [
  ['普兰店振兴街', '九里', 7],
  ['普兰店振兴街', '大连站', 10],
  ['普兰店振兴街', '金石滩', 10]
];

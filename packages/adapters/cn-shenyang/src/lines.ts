/**
 * Shenyang Metro line configuration and the official fare tariff.
 *
 * The operator (沈阳地铁集团有限公司) runs six metro lines. The official
 * `getLineList` endpoint publishes them with the ids `01`/`02`/`03`/`04`/`09`/
 * `10` and the operator's own `line_name` (`1号线`); `getHomePageInitData`
 * additionally publishes the operator's **line colour**, mileage and opening
 * date per line. The registry below mirrors those ids so the adapter can
 * cross-check the feed and so the Baidu planner's vehicle-name fragment
 * (`地铁1号线`) stays explicit.
 *
 * Under construction and therefore absent from every machine-readable source —
 * 6号线一期, 9号线二期 (建筑大学→石庙子) and 10号线二期 (张沙布→丁香街) — are
 * deliberately not modelled: the official feed lists none of their stations and
 * hand-maintained tables would drift. Baidu's POI index does carry their stop
 * names, so they can be added later from a real source.
 */
import type { LineMode } from '@openmetro/core';

export interface ShenyangLineConfig {
  /** Compact display code for badges (`1`). */
  short: string;
  /** Official Chinese display name (`getLineList` `line_name`). */
  name: string;
  /** ASCII slug used in line/stop/pattern ids. */
  slug: string;
  mode: LineMode;
  /** Baidu planner vehicle-name fragment (`地铁1号线`). */
  baiduNameHint: string;
}

export const SHENYANG_LINES: ShenyangLineConfig[] = [
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
  },
  {
    short: '4',
    name: '4号线',
    slug: '4',
    mode: 'metro',
    baiduNameHint: '地铁4号线'
  },
  {
    short: '9',
    name: '9号线',
    slug: '9',
    mode: 'metro',
    baiduNameHint: '地铁9号线'
  },
  {
    short: '10',
    name: '10号线',
    slug: '10',
    mode: 'metro',
    baiduNameHint: '地铁10号线'
  }
];

/** Official line id (`getLineList` `line_id`) → registry entry. */
export const LINE_CONFIG_BY_OFFICIAL_ID = new Map<string, ShenyangLineConfig>(
  SHENYANG_LINES.map((l) => [l.slug.padStart(2, '0'), l])
);

/**
 * Official fare policy (《沈阳地铁票务规则》, 乘客须知栏目, 2025-01-13):
 *
 * > 一、基本票价
 * > 沈阳地铁票价实行里程分段计价票制：起步价为2元6公里，每增加1元，可继续乘坐4、4、7、7、10、10公里。
 * > 即：0-6（含，以下类同）公里，票价2元；6-10公里，票价3元；10-14公里，票价4元；14-21公里，票价5元；
 * > 21-28公里，票价6元；28公里以上，每增加10公里，增加1元。
 * > （一）线网实行最高票价7元封顶优惠。
 *
 * So the tariff is a threshold function over the charged mileage plus a
 * network-wide cap of 7 yuan. The operator prices every journey on its
 * **shortest path** mileage, which is a Dijkstra shortest path over the
 * network's segment distances — exactly what the fare layer computes.
 */
export const SHENYANG_TARIFF = {
  /** Charged mileage thresholds (km) — each crossed threshold adds 1 yuan. */
  thresholdsKm: [6, 10, 14, 21, 28],
  /** Base fare for the 0–6 km band. */
  baseYuan: 2,
  /** Above the last threshold the fare grows by 1 yuan per this many km. */
  stepKm: 10,
  /** The operator caps the network fare at 7 yuan (最高票价7元封顶优惠). */
  capYuan: 7
} as const;

/** Official single-journey fare for a charged mileage of `km`. */
export function shenyangMileageFare(km: number): number {
  if (!Number.isFinite(km) || km < 0) return SHENYANG_TARIFF.baseYuan;
  let yuan = SHENYANG_TARIFF.baseYuan;
  for (const threshold of SHENYANG_TARIFF.thresholdsKm) {
    if (km > threshold) yuan++;
  }
  const last = SHENYANG_TARIFF.thresholdsKm[SHENYANG_TARIFF.thresholdsKm.length - 1]!;
  if (km > last) {
    yuan += Math.floor((km - last) / SHENYANG_TARIFF.stepKm);
  }
  return Math.min(yuan, SHENYANG_TARIFF.capYuan);
}

/**
 * Split the operator's CamelCase pinyin into words.
 *
 * The official `station_eng_name` field publishes pinyin without word
 * separators — `ShiSanHaoJie`, `HuaiHeJieShenYiErYuan` — so it has to be split
 * before it can be title-cased into a readable romanised label
 * (`Shi San Hao Jie`). A word starts at every capital that follows a lowercase
 * letter or a digit; a capital run followed by a lowercase letter keeps its
 * last capital attached to that word (`HTTPServer` → `HTTP Server`).
 */
export function splitCamelPinyin(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s || !/^[A-Za-z]/.test(s)) return '';
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const prev = i > 0 ? s[i - 1]! : '';
    const next = i + 1 < s.length ? s[i + 1]! : '';
    const startsWord =
      i > 0 &&
      /[A-Z]/.test(ch) &&
      (/[a-z0-9]/.test(prev) || (/[A-Z]/.test(prev) && /[a-z]/.test(next)));
    if (startsWord) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out.filter(Boolean).join(' ');
}

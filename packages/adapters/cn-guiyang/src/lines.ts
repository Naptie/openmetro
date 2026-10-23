/**
 * Line registry for cn-guiyang.
 *
 * The operator's own line ids come from the `index_number` attribute of the
 * station list on `https://www.gyurt.com/subwayInquiry.html` (`1`, `2`, `3`,
 * `S1`); this registry only adds the canonical id slug, the English label
 * published on the official network map and the service mode.
 *
 * `S1` is a 市域快线 (suburban rail) linking 贵安新区 to the main city — the
 * operator's own network map labels it `S1线 / Line S1` and it runs B2 rolling
 * stock at 100 km/h, unlike the three underground lines. It is therefore
 * modelled as `suburban_rail`, matching how the repository classifies similar
 * services elsewhere.
 */

export type GuiyangLineMode = 'metro' | 'suburban_rail';

export interface GuiyangLineConfig {
  /** Operator line id as published (`1`, `2`, `3`, `S1`). */
  officialId: string;
  /** Compact display code used for map badges. */
  short: string;
  /** Official Chinese name, e.g. `1号线`. */
  name: string;
  /** Official English name as printed on the network map. */
  nameEn: string;
  /** Canonical id slug. */
  slug: string;
  mode: GuiyangLineMode;
}

export const GUIYANG_LINES: readonly GuiyangLineConfig[] = [
  {
    officialId: '1',
    short: '1',
    name: '1号线',
    nameEn: 'Line 1',
    slug: '1',
    mode: 'metro'
  },
  {
    officialId: '2',
    short: '2',
    name: '2号线',
    nameEn: 'Line 2',
    slug: '2',
    mode: 'metro'
  },
  {
    officialId: '3',
    short: '3',
    name: '3号线',
    nameEn: 'Line 3',
    slug: '3',
    mode: 'metro'
  },
  {
    officialId: 'S1',
    short: 'S1',
    name: 'S1线',
    nameEn: 'Line S1',
    slug: 's1',
    mode: 'suburban_rail'
  }
];

const BY_OFFICIAL_ID = new Map(GUIYANG_LINES.map((l) => [l.officialId, l] as const));

/** Look up a line config by the operator's line id. */
export function guiyangLineByOfficialId(officialId: string): GuiyangLineConfig | undefined {
  return BY_OFFICIAL_ID.get(officialId);
}

/** Canonical line id, e.g. `cn-guiyang-line-1`. */
export function guiyangLineId(config: GuiyangLineConfig): string {
  return `cn-guiyang-line-${config.slug}`;
}

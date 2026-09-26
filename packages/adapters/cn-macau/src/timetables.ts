/**
 * Macau LRT first/last train times — manually maintained.
 *
 * Primary evidence:
 *  - BAR / TFT timetable sheets (mlm.com.mo): 06:30–23:15 (Mon–Thu), 06:30–23:59 (Fri/Sun/PH)
 *  - Official service hours on mlm.com.mo/route.html match the above.
 *  - Full-line journey ≈ 28 min (13 stations, 12 segments).
 *
 * Interior stations are derived from verified terminus times + per-segment
 * runtimes (sea-crossing 媽閣↔海洋 and 蓮花↔橫琴 are longer). This keeps the
 * last-train chain monotonic so `deriveSegmentTimes` yields non-negative hops.
 *
 * Day types → canonical 7-element Mon..Sun arrays via `toWeekArray`.
 */

export interface DayTimes {
  first: string;
  last: string;
}

export interface StationDirTimes {
  ttCode: string;
  fromZh: string;
  toZh: string;
  mon_thu: DayTimes;
  fri: DayTimes;
  sat_sun_hol: DayTimes;
  note?: string;
}

/** Cumulative minutes from 媽閣 toward 氹仔碼頭 (runtime between consecutive stops). */
export const TAIPA_LEG_MINUTES: [string, string, number][] = [
  ['媽閣', '海洋', 3],
  ['海洋', '馬會', 2],
  ['馬會', '運動場', 2],
  ['運動場', '排角', 2],
  ['排角', '路氹西', 2],
  ['路氹西', '蓮花', 3],
  ['蓮花', '協和醫院', 2],
  ['協和醫院', '東亞運', 3],
  ['東亞運', '路氹東', 2],
  ['路氹東', '科大', 2],
  ['科大', '機場', 2],
  ['機場', '氹仔碼頭', 2]
];

/** Official Taipa-line station order (媽閣 → 氹仔碼頭). */
export const TAIPA_ORDER = [
  '媽閣',
  '海洋',
  '馬會',
  '運動場',
  '排角',
  '路氹西',
  '蓮花',
  '協和醫院',
  '東亞運',
  '路氹東',
  '科大',
  '機場',
  '氹仔碼頭'
] as const;

function addMin(hm: string, delta: number): string {
  const [h, m] = hm.split(':').map(Number) as [number, number];
  const total = h * 60 + m + delta;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Cumulative minutes from 媽閣 to each station (toward 氹仔碼頭). */
export function cumulativeFromBarra(): Map<string, number> {
  const cum = new Map<string, number>([['媽閣', 0]]);
  let acc = 0;
  for (const [_a, b, mins] of TAIPA_LEG_MINUTES) {
    acc += mins;
    cum.set(b, acc);
  }
  return cum;
}

/** Build the verified/derived timetable table. */
export function buildVerifiedTimes(): StationDirTimes[] {
  const cum = cumulativeFromBarra();
  const total = cum.get('氹仔碼頭') ?? 28;
  const out: StationDirTimes[] = [];

  // Terminus envelopes (visually verified from BAR/TFT sheets).
  const env = {
    mon_thu: { first: '06:30', last: '23:15' },
    fri: { first: '06:30', last: '23:59' },
    sat_sun_hol: { first: '06:30', last: '23:59' }
  };

  // Taipa line toward 氹仔碼頭
  for (const zh of TAIPA_ORDER) {
    if (zh === '氹仔碼頭') continue;
    const off = cum.get(zh) ?? 0;
    out.push({
      ttCode: zh === '媽閣' ? 'BAR' : ttCodeOf(zh),
      fromZh: zh,
      toZh: '氹仔碼頭',
      mon_thu: { first: addMin(env.mon_thu.first, off), last: addMin(env.mon_thu.last, off) },
      fri: { first: addMin(env.fri.first, off), last: addMin(env.fri.last, off) },
      sat_sun_hol: {
        first: addMin(env.sat_sun_hol.first, off),
        last: addMin(env.sat_sun_hol.last, off)
      },
      note:
        zh === '媽閣'
          ? 'verified BAR sheet (mlm.com.mo)'
          : `derived: 媽閣 +${off}min (verified terminus envelope)`
    });
  }

  // Taipa line toward 媽閣 (reverse)
  for (const zh of TAIPA_ORDER) {
    if (zh === '媽閣') continue;
    const off = total - (cum.get(zh) ?? 0);
    out.push({
      ttCode: `${ttCodeOf(zh)}-R`,
      fromZh: zh,
      toZh: '媽閣',
      mon_thu: { first: addMin(env.mon_thu.first, off), last: addMin(env.mon_thu.last, off) },
      fri: { first: addMin(env.fri.first, off), last: addMin(env.fri.last, off) },
      sat_sun_hol: {
        first: addMin(env.sat_sun_hol.first, off),
        last: addMin(env.sat_sun_hol.last, off)
      },
      note:
        zh === '氹仔碼頭'
          ? 'verified TFT sheet (mlm.com.mo)'
          : `derived: 氹仔碼頭 +${off}min (verified terminus envelope)`
    });
  }

  // Seac Pai Van line (2 stations, ~2 min) — same service envelope.
  for (const [from, to, code] of [
    ['石排灣', '協和醫院', 'SPV'],
    ['協和醫院', '石排灣', 'SPV_HU']
  ] as const) {
    out.push({
      ttCode: code,
      fromZh: from,
      toZh: to,
      mon_thu: { ...env.mon_thu },
      fri: { ...env.fri },
      sat_sun_hol: { ...env.sat_sun_hol },
      note: 'short shuttle; official service envelope (mlm.com.mo)'
    });
  }

  // Hengqin line (2 stations, ~2 min, cross-border).
  for (const [from, to, code] of [
    ['蓮花', '橫琴', 'HQL_LOT'],
    ['橫琴', '蓮花', 'HQL_HQ']
  ] as const) {
    out.push({
      ttCode: code,
      fromZh: from,
      toZh: to,
      mon_thu: { ...env.mon_thu },
      fri: { ...env.fri },
      sat_sun_hol: { ...env.sat_sun_hol },
      note: 'short shuttle; official service envelope (mlm.com.mo)'
    });
  }

  return out;
}

function ttCodeOf(zh: string): string {
  const map: Record<string, string> = {
    媽閣: 'BAR',
    海洋: 'OCE',
    馬會: 'JOC',
    運動場: 'STA',
    排角: 'PAK',
    路氹西: 'COW',
    蓮花: 'LOT',
    協和醫院: 'HU',
    東亞運: 'EAG',
    路氹東: 'COE',
    科大: 'MUST',
    機場: 'AIR',
    氹仔碼頭: 'TFT',
    石排灣: 'SPV',
    橫琴: 'HQ'
  };
  return map[zh] ?? zh;
}

/** Expand 3 day-types to canonical Mon..Sun 7-element array. */
export function toWeekArray(times: Record<string, DayTimes>, which: 'first' | 'last'): string[] {
  const mt = times.mon_thu![which]!;
  const fri = times.fri![which]!;
  const we = times.sat_sun_hol![which]!;
  return [mt, mt, mt, mt, fri, we, we];
}

export const VERIFIED_TIMES: StationDirTimes[] = buildVerifiedTimes();

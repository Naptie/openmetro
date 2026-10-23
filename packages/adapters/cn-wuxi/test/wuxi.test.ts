import { expect, test } from 'bun:test';
import { matchesLine, stopNameMatches } from '../src/baidu.ts';
import { buildNetworkDistanceMatrix, verifyFareMatrixAgainstTariff } from '../src/fares.ts';
import {
  ENGLISH_NAME_OVERRIDES,
  parseWuxiTariff,
  tariffMatchesLadder,
  WUXI_LINES,
  wuxiMileageFare
} from '../src/lines.ts';

/**
 * The 基本票价 paragraph of 《无锡地铁票务规则》, verbatim from the operator's
 * 票务服务 column (https://www.wxmetro.net/wxmetro/enterMetro?id=…71).
 */
const PUBLISHED_RULES = `
一、总则 为使广大市民了解并遵守无锡地铁相关票务规定，依据《无锡市轨道交通条例》、
《无锡市轨道交通乘客守则》、《市物价局关于核定无锡地铁票价的通知》（锡价服[2014] 50号）、
《市发展改革委关于核定S1线票价的通知》（锡发改价格〔2024〕1号）等相关规定，特制定本规则。
本规则适用于含S1线在内的无锡市城市轨道交通运营线路。

二、基本票价 无锡地铁线网票价按里程分段计价：起步5公里以内2元；超过5公里至15公里，
每5公里加收1元（不足5公里按5公里计价）；超过15公里至29公里，每7公里加收1元（不足7公里
按7公里计价）；超过29公里，每9公里加收1元（不足9公里按9公里计价）。

三、车票种类 （一）单程票：适用于所有乘客。
`;

test('the published tariff is parsed into the compiled bands', () => {
  const bands = parseWuxiTariff(PUBLISHED_RULES);
  expect(bands).not.toBeNull();
  expect(bands).toEqual({
    baseYuan: 2,
    baseKm: 5,
    secondKm: 15,
    secondStepKm: 5,
    thirdKm: 29,
    thirdStepKm: 7,
    fourthStepKm: 9
  });
  expect(tariffMatchesLadder(bands!)).toBe(true);
});

test('text without a tariff paragraph yields no bands', () => {
  expect(parseWuxiTariff('三、车票种类 （一）单程票')).toBeNull();
  expect(parseWuxiTariff('')).toBeNull();
});

test('the mileage ladder prices the published bands', () => {
  // 起步 2 元 5 公里
  expect(wuxiMileageFare(0)).toBe(2);
  expect(wuxiMileageFare(5)).toBe(2);
  // 5–15 公里：每 5 公里加 1 元
  expect(wuxiMileageFare(5.1)).toBe(3);
  expect(wuxiMileageFare(10)).toBe(3);
  expect(wuxiMileageFare(10.1)).toBe(4);
  expect(wuxiMileageFare(15)).toBe(4);
  // 15–29 公里：每 7 公里加 1 元
  expect(wuxiMileageFare(15.1)).toBe(5);
  expect(wuxiMileageFare(22)).toBe(5);
  expect(wuxiMileageFare(22.1)).toBe(6);
  expect(wuxiMileageFare(29)).toBe(6);
  // 29 公里以上：每 9 公里加 1 元
  expect(wuxiMileageFare(29.1)).toBe(7);
  expect(wuxiMileageFare(38)).toBe(7);
  expect(wuxiMileageFare(38.1)).toBe(8);
});

test('the ladder matches the fares the Baidu planner quotes', () => {
  // Measured against the planner on 2026-10-23: the quoted fare equals the
  // ladder applied to the quoted riding distance, for every band.
  expect(wuxiMileageFare(1.91)).toBe(2);
  expect(wuxiMileageFare(18.51)).toBe(5);
  expect(wuxiMileageFare(20.86)).toBe(5);
  expect(wuxiMileageFare(23.77)).toBe(6);
  expect(wuxiMileageFare(25.3)).toBe(6);
  expect(wuxiMileageFare(61.78)).toBe(10);
});

test('the S1 line is not mistaken for line 1', () => {
  const line1 = WUXI_LINES.find((l) => l.short === '1')!;
  const s1 = WUXI_LINES.find((l) => l.short === 'S1')!;

  // The planner signs the S1 line `地铁S1线` (and `地铁S1号线(锡澄线)`).
  expect(matchesLine('地铁S1线', s1)).toBe(true);
  expect(matchesLine('地铁S1号线(锡澄线)', s1)).toBe(true);
  expect(matchesLine('地铁S1线', line1)).toBe(false);
  expect(matchesLine('地铁1号线', line1)).toBe(true);
  expect(matchesLine('地铁1号线', s1)).toBe(false);
  expect(matchesLine('地铁2号线', line1)).toBe(false);
  // Bus legs are never rail legs.
  expect(matchesLine('公交1路', line1)).toBe(false);
});

test('the network distance follows the tracks, and the tariff cross-check holds', () => {
  // A two-stop line: A — B — C, with the AB hop 1 km and the BC hop 2 km.
  const stops = [
    { id: 's-a', station_id: 'st-a' },
    { id: 's-b', station_id: 'st-b' },
    { id: 's-c', station_id: 'st-c' }
  ];
  const segments = [
    { from_stop_id: 's-a', to_stop_id: 's-b', distance_km: 1 },
    { from_stop_id: 's-b', to_stop_id: 's-c', distance_km: 2 }
  ];
  const distanceKm = buildNetworkDistanceMatrix({ segments, stops });
  expect(distanceKm('st-a', 'st-c')).toBeCloseTo(3, 6);
  expect(distanceKm('st-a', 'st-b')).toBeCloseTo(1, 6);

  // The matrix the ladder produces for those distances is consistent with the
  // published tariff.
  const matrix = {
    station_ids: ['st-a', 'st-b', 'st-c'],
    fares: [
      [0, wuxiMileageFare(1), wuxiMileageFare(3)],
      [wuxiMileageFare(1), 0, wuxiMileageFare(2)],
      [wuxiMileageFare(3), wuxiMileageFare(2), 0]
    ]
  };
  const check = verifyFareMatrixAgainstTariff(matrix, distanceKm);
  expect(check.consistent).toBe(3);
  expect(check.inconsistent).toBe(0);
});

test('a price that no band explains is reported, not hidden', () => {
  const matrix = {
    station_ids: ['st-a', 'st-b'],
    fares: [
      [0, 9],
      [9, 0]
    ]
  };
  const check = verifyFareMatrixAgainstTariff(matrix, () => 3);
  expect(check.consistent).toBe(0);
  expect(check.inconsistent).toBe(1);
  expect(check.examples.length).toBe(1);
});

test('the official English name of 安镇 overrides the Wikidata fallback', () => {
  // The official network map prints `安镇 / Anzhen`. Wikidata's entry for 安镇
  // romanises the hanja of a same-named place elsewhere ("Gynheung An"), so
  // the operator's own name has to win.
  expect(ENGLISH_NAME_OVERRIDES.get('安镇')).toBe('Anzhen');
});

test('planner stop names fold onto the canonical names', () => {
  // The planner appends the exit the passenger enters.
  expect(stopNameMatches('无锡火车站(1口)', '无锡火车站')).toBe(true);
  expect(stopNameMatches('三阳广场站(2口)', '三阳广场')).toBe(true);
  expect(stopNameMatches('三阳广场站', '三阳广场')).toBe(true);
  expect(stopNameMatches('无锡新区站', '无锡新区站')).toBe(true);
  expect(stopNameMatches('无锡新区站', '无锡新区')).toBe(true);
  expect(stopNameMatches('市民中心站(1口)', '市民中心')).toBe(true);
  expect(stopNameMatches('市民中心站(1口)', '市民中心站')).toBe(true);
  expect(stopNameMatches('三阳广场站', '市民中心')).toBe(false);
});

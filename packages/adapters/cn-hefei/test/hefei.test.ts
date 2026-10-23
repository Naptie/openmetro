import { expect, test } from 'bun:test';
import { foldStopName, isRailLine, lineNumberOf, stopNameMatches } from '../src/baidu.ts';
import { parseFarePolicy } from '../src/fetch.ts';
import {
  FARE_LADDER,
  FARE_LADDER_TAIL_KM,
  fareFromDistanceKm,
  NOT_YET_OPEN_STATIONS,
  resolveHefeiStationName,
  STATION_NAME_ALIASES
} from '../src/lines.ts';
import {
  bandTimesToWeekArray,
  bandWeekIndices,
  exitOf,
  serviceBandFor
} from '../src/timetables.ts';

/**
 * The 票价信息及优惠政策 article, as published on the Hefei disclosure
 * platform (organId=156407), verbatim in the parts the parser reads.
 */
const PUBLISHED_TARIFF = `
一、票价种类及计价方式
起步价 2 元可乘 8 公里；乘坐 8 公里以上，14 公里 ( 含 ) 以内的 3 元；
乘坐 14 公里以上，21 公里 ( 含 ) 以内的 4 元；乘坐 21 公里以上，
29 公里 ( 含 ) 以内的 5 元；乘坐 29 公里以上的，每增加 9 公里，加收 1 元。
`;

test('the published tariff is parsed into the encoded ladder', () => {
  const fare = parseFarePolicy(PUBLISHED_TARIFF);
  expect(fare.steps).toEqual([
    { upToKm: 8, yuan: 2 },
    { upToKm: 14, yuan: 3 },
    { upToKm: 21, yuan: 4 },
    { upToKm: 29, yuan: 5 }
  ]);
  expect(fare.tailKm).toBe(9);
  expect(fare.tailYuan).toBe(1);
  // The parsed ladder has to be the encoded one, or the tariff changed.
  expect(fare.steps).toEqual(FARE_LADDER);
  expect(fare.tailKm).toBe(FARE_LADDER_TAIL_KM);
});

test('text without a tariff clause is rejected, not guessed', () => {
  expect(() => parseFarePolicy('二、优惠政策')).toThrow(/起步价/);
  expect(() =>
    parseFarePolicy('起步价 2 元可乘 8 公里；乘坐 29 公里以上的，每增加 9 公里，加收 2 元。')
  ).toThrow(/unexpected tail step/);
});

test('the mileage ladder prices the published bands', () => {
  // 起步 2 元 8 公里
  expect(fareFromDistanceKm(0)).toBe(0);
  expect(fareFromDistanceKm(1)).toBe(2);
  expect(fareFromDistanceKm(8)).toBe(2);
  // 8–14 公里 3 元
  expect(fareFromDistanceKm(8.01)).toBe(3);
  expect(fareFromDistanceKm(14)).toBe(3);
  // 14–21 公里 4 元
  expect(fareFromDistanceKm(14.01)).toBe(4);
  expect(fareFromDistanceKm(21)).toBe(4);
  // 21–29 公里 5 元
  expect(fareFromDistanceKm(21.01)).toBe(5);
  expect(fareFromDistanceKm(29)).toBe(5);
  // 29 公里以上每 9 公里加收 1 元 — a *started* step costs a yuan.
  expect(fareFromDistanceKm(29.01)).toBe(6);
  expect(fareFromDistanceKm(38)).toBe(6);
  expect(fareFromDistanceKm(38.01)).toBe(7);
});

test('the ladder reproduces the fares the operator published', () => {
  // 6 号线's opening announcement quotes the line's maximum single fare as
  // 6 元 for a 34.43 km line; 8 号线 quotes 5 元 for 22.22 km.
  expect(fareFromDistanceKm(34.43)).toBe(6);
  expect(fareFromDistanceKm(22.22)).toBe(5);
  // 合肥火车站 → 九联圩 is 23.30 km of rail — the planner quotes 5 元.
  expect(fareFromDistanceKm(23.3)).toBe(5);
});

test('official station names resolve onto the AMap spelling', () => {
  const known = new Set(['合肥南站', '合肥火车站', '肥东站', '九联圩', '长淮']);
  // The operator writes the `站` suffix on every station; AMap keeps it only
  // on the compounds.
  expect(resolveHefeiStationName('九联圩站', known)).toBe('九联圩');
  expect(resolveHefeiStationName('长淮站', known)).toBe('长淮');
  expect(resolveHefeiStationName('合肥南站', known)).toBe('合肥南站');
  expect(resolveHefeiStationName('肥东站', known)).toBe('肥东站');
  // The interchange workbook writes 合肥南, AMap writes 合肥南站.
  expect(resolveHefeiStationName('合肥南', known)).toBe('合肥南站');
  expect(STATION_NAME_ALIASES).toEqual({ 合肥南: '合肥南站' });
  // An unknown name is passed through rather than dropped.
  expect(resolveHefeiStationName('未知站', known)).toBe('未知站');
});

test('the not-yet-open stations hang off their anchor', () => {
  const names = NOT_YET_OPEN_STATIONS.map((s) => s.name);
  expect(names).toEqual(['馆驿', '紫云湖', '市博物馆']);
  // Two of them sit beyond the operating terminus, one between two
  // operating stations — the anchor says which.
  expect(NOT_YET_OPEN_STATIONS.find((s) => s.name === '馆驿')?.after).toBe('省儿童医院新区');
  expect(NOT_YET_OPEN_STATIONS.find((s) => s.name === '市博物馆')?.after).toBe('市儿童医院');
  for (const s of NOT_YET_OPEN_STATIONS) {
    expect(s.line).toMatch(/号线$/);
    expect(s.note).toContain('暂');
  }
});

test('planner stop names fold onto the canonical names', () => {
  expect(foldStopName('合肥火车站(E口)')).toBe('合肥火车站');
  expect(foldStopName('合肥火车站（E口）')).toBe('合肥火车站');
  expect(foldStopName(null)).toBe('');
  // The `站` suffix is meaningful for the compounds, so it is kept.
  expect(stopNameMatches('合肥火车站(E口)', '合肥火车站')).toBe(true);
  expect(stopNameMatches('长淮站', '长淮')).toBe(true);
  expect(stopNameMatches('合肥南站', '合肥南')).toBe(true);
  expect(stopNameMatches('合肥火车站(E口)', '长淮')).toBe(false);
});

test('the rail lines are told apart from the buses', () => {
  expect(isRailLine('轨道交通3号线')).toBe(true);
  expect(isRailLine('地铁4号线')).toBe(true);
  expect(isRailLine('公交1路')).toBe(false);
  expect(lineNumberOf('轨道交通3号线')).toBe('3');
  expect(lineNumberOf('地铁12号线')).toBe('12');
  expect(lineNumberOf('公交1路')).toBeUndefined();
});

test('the three service bands map onto the canonical weekday array', () => {
  // 2026-10-19 is a Monday, 2026-10-23 a Friday, 2026-10-24 a Saturday.
  expect(serviceBandFor(new Date('2026-10-19T08:00:00'))).toBe('mon_thu');
  expect(serviceBandFor(new Date('2026-10-22T08:00:00'))).toBe('mon_thu');
  expect(serviceBandFor(new Date('2026-10-23T08:00:00'))).toBe('fri');
  expect(serviceBandFor(new Date('2026-10-24T08:00:00'))).toBe('weekend');
  expect(serviceBandFor(new Date('2026-10-25T08:00:00'))).toBe('weekend');

  expect(bandWeekIndices('mon_thu')).toEqual([0, 1, 2, 3]);
  expect(bandWeekIndices('fri')).toEqual([4]);
  expect(bandWeekIndices('weekend')).toEqual([5, 6]);

  const week = bandTimesToWeekArray({ mon_thu: '06:00', fri: '06:05', weekend: '06:10' });
  expect(week).toEqual(['06:00', '06:00', '06:00', '06:00', '06:05', '06:10', '06:10']);
});

test('the exit the planner boards through is extracted', () => {
  expect(exitOf('合肥火车站(E口)')).toBe('E口');
  expect(exitOf('合肥火车站（E口）')).toBe('E口');
  expect(exitOf('合肥火车站')).toBeUndefined();
  expect(exitOf(undefined)).toBeUndefined();
});

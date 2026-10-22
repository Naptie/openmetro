import { expect, test } from 'bun:test';
import { directionTargets, foldDirectionLabel, foldPlannerStopName } from '../src/baidu.ts';
import {
  HOHHOT_FARE_LADDER_KM,
  HOHHOT_MAX_FARE,
  hohhotFareForKm,
  RENAMED_STATIONS_2023,
  STATION_NAME_OVERRIDES
} from '../src/lines.ts';
import { officialStationName } from '../src/normalize.ts';

test('planner stop names fold to the canonical operator name', () => {
  // A plain station with an exit suffix.
  expect(foldPlannerStopName('市政府站(B口)')).toBe('市政府');
  expect(foldPlannerStopName('市政府站')).toBe('市政府');
  // Multi-character exit codes (`C2口`) are used on Line 1 as well.
  expect(foldPlannerStopName('将军衙署站(C2口)')).toBe('将军衙署');
  expect(foldPlannerStopName('新华广场站(A口)')).toBe('新华广场');
  // A descriptive exit suffix that names the exit and a landmark.
  expect(foldPlannerStopName('大学西街站(地铁C通道口-万象城)')).toBe('大学西街');
  // The parenthesised qualifier carries the operator's current official name
  // and must survive the fold.
  expect(foldPlannerStopName('坝堰(机场)(国内航站楼)站')).toBe('坝堰(机场)(国内航站楼)');
  expect(foldPlannerStopName('坝堰(机场)(国内航站楼)站(B口)')).toBe('坝堰(机场)(国内航站楼)');
  expect(foldPlannerStopName('白塔西(国际航站楼)站(B口)')).toBe('白塔西(国际航站楼)');
  // Full-width brackets are normalized.
  expect(foldPlannerStopName('呼和浩特站')).toBe('呼和浩特');
  expect(foldPlannerStopName(undefined)).toBe('');
});

test('direction labels match the destination terminus', () => {
  expect(foldDirectionLabel('坝堰(机场)(国内航站楼)方向')).toBe('坝堰(机场)(国内航站楼)');
  expect(
    directionTargets('坝堰(机场)(国内航站楼)方向', '坝堰(机场)(国内航站楼)', '伊利健康谷')
  ).toBe(true);
  expect(directionTargets('伊利健康谷方向', '坝堰(机场)(国内航站楼)', '伊利健康谷')).toBe(false);
  // A label for the longer terminus must not validate for the shorter one
  // it is a prefix of — and the shorter label still validates for the
  // shorter terminus.
  expect(
    directionTargets('坝堰(机场)(国内航站楼)方向', '坝堰(机场)', '坝堰(机场)(国内航站楼)')
  ).toBe(false);
  expect(directionTargets('坝堰(机场)方向', '坝堰(机场)', '坝堰(机场)(国内航站楼)')).toBe(true);
});

test('station names follow the operator renames', () => {
  // 2023-11-01 renames: the canonical name is the current official one.
  expect(officialStationName('呼钢南路')).toBe('呼钢南路');
  expect(officialStationName('坝堰(机场)')).toBe('坝堰(机场)(国内航站楼)');
  expect(officialStationName('白塔西')).toBe('白塔西(国际航站楼)');
  // The three renames are recorded for provenance.
  expect(RENAMED_STATIONS_2023.map((r) => r.to)).toEqual(['呼钢南路', '北山公园', '丝绸之路大道']);
  expect(Object.keys(STATION_NAME_OVERRIDES).sort()).toEqual(['坝堰(机场)', '白塔西']);
});

test('the published fare ladder matches the 发改委 tariff', () => {
  // 呼发改医价〔2019〕63号：0-5 公里（含）2 元，5-10 公里（含）3 元，
  // 10-15 公里（含）4 元，15-21 公里（含）5 元，21-28 公里（含）6 元，
  // 28 公里以上每增加 1 元可继续乘坐 10 公里。
  expect(HOHHOT_FARE_LADDER_KM).toEqual([5, 10, 15, 21, 28]);
  expect(hohhotFareForKm(0)).toBe(0);
  expect(hohhotFareForKm(1.2)).toBe(2);
  expect(hohhotFareForKm(5)).toBe(2);
  expect(hohhotFareForKm(5.01)).toBe(3);
  expect(hohhotFareForKm(10)).toBe(3);
  expect(hohhotFareForKm(15)).toBe(4);
  expect(hohhotFareForKm(21)).toBe(5);
  expect(hohhotFareForKm(28)).toBe(6);
  // 28 公里以上每增加 1 元可继续乘坐 10 公里 — the band edge is inclusive.
  expect(hohhotFareForKm(28.01)).toBe(7);
  expect(hohhotFareForKm(28.88)).toBe(7);
  expect(hohhotFareForKm(38)).toBe(7);
  expect(hohhotFareForKm(38.01)).toBe(8);
  expect(hohhotFareForKm(48)).toBe(8);
  // The whole network fits the last band: Line 2 is 27.32 km → 6 元.
  expect(HOHHOT_FARE_LADDER_KM.length + 1).toBe(6);
  expect(27.32).toBeLessThanOrEqual(HOHHOT_FARE_LADDER_KM[HOHHOT_FARE_LADDER_KM.length - 1]!);
  // The longest journey in the network crosses into the next band.
  expect(hohhotFareForKm(29)).toBe(7);
  expect(HOHHOT_MAX_FARE).toBe(hohhotFareForKm(29));
});
